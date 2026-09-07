import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const SETTINGS_KEY = 'settings:asset-manager';
const SPLIT_PREFIX = 'device-split:';
const HISTORY_PREFIX = 'asset-history:';

const clean = (value) => String(value ?? '').trim();
const normalise = (value) => clean(value).toLocaleLowerCase('en').replace(/\s+/g, ' ');
const now = () => new Date().toISOString();

async function queryAllByPrefix(prefix) {
  const values = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    values.push(...page.results.map((entry) => entry.value));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text || '';
  const inner = Array.isArray(node.content) ? node.content.map(adfToText).join('') : '';
  if (['paragraph', 'heading', 'listItem'].includes(node.type)) return `${inner}\n`;
  if (['bulletList', 'orderedList'].includes(node.type)) return `${inner}\n`;
  if (node.type === 'hardBreak') return '\n';
  return inner;
}

function stripLead(value) {
  return clean(value).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '');
}

function faultAfterIdentifier(line, identifier) {
  const index = line.toLocaleLowerCase('en').indexOf(identifier.toLocaleLowerCase('en'));
  if (index < 0) return '';
  return clean(line.slice(index + identifier.length).replace(/^\s*[-–—:|]+\s*/, ''));
}

function assetIdentifiers(asset) {
  return [...new Set([asset?.jiraIdentifier, asset?.name, asset?.serialNumber].map(clean).filter(Boolean))];
}

function detectDevices(text, assets) {
  const rows = String(text || '').split(/\r?\n/).map(stripLead).filter(Boolean);
  const found = [];
  const seen = new Set();

  const indexed = assets.flatMap((asset) => assetIdentifiers(asset).map((identifier) => ({ asset, identifier })))
    .sort((a, b) => b.identifier.length - a.identifier.length);

  for (const line of rows) {
    const lower = line.toLocaleLowerCase('en');
    const matches = indexed.filter(({ identifier }) => lower.includes(identifier.toLocaleLowerCase('en')));
    for (const match of matches) {
      const key = normalise(match.identifier);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        identifier: match.identifier,
        assetId: match.asset.id,
        assetName: match.asset.name || match.identifier,
        fault: faultAfterIdentifier(line, match.identifier),
        recognised: true
      });
    }

    const tokenMatches = line.match(/\b[A-Z0-9]{2,}(?:[_-][A-Z0-9]{2,}){1,}\b/gi) || [];
    for (const token of tokenMatches) {
      const key = normalise(token);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ identifier: token, assetId: '', assetName: token, fault: faultAfterIdentifier(line, token), recognised: false });
    }
  }

  return found;
}

async function loadIssue(issueKey) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,project,priority,issuetype,subtasks`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Could not load Jira issue (${response.status}).`);
  return response.json();
}

async function subtaskIssueType(projectId) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issuetype/project?projectId=${projectId}&level=-1`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Could not load sub-task issue types (${response.status}).`);
  const types = await response.json();
  const type = Array.isArray(types) ? types.find((item) => item.subtask || Number(item.hierarchyLevel) === -1) : null;
  if (!type?.id) throw new Error('This Jira project does not have a sub-task issue type configured.');
  return type;
}

async function addHistory(assetId, event) {
  if (!assetId) return;
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event });
}

function childDescription(parentKey, identifier, fault) {
  const lines = [
    `Created from ${parentKey} by Nuvriqo Asset Manager device splitting.`,
    `Device: ${identifier}`,
    fault ? `Reported fault: ${fault}` : 'Reported fault: See parent request.'
  ];
  return {
    type: 'doc', version: 1,
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
  };
}

async function splitState(parentKey, detected) {
  return Promise.all(detected.map(async (item) => {
    const existing = await kvs.get(`${SPLIT_PREFIX}${parentKey}:${normalise(item.identifier)}`);
    return { ...item, alreadySplit: Boolean(existing?.childKey), childKey: existing?.childKey || '' };
  }));
}

resolver.define('previewDeviceSplit', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key);
  if (!issueKey) throw new Error('Issue is required.');
  const issue = await loadIssue(issueKey);
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  const text = adfToText(issue.fields?.description);
  const detected = detectDevices(text, assets);
  const items = await splitState(issueKey, detected);
  const type = issue.fields?.project?.id ? await subtaskIssueType(issue.fields.project.id) : null;
  return {
    issueKey,
    summary: issue.fields?.summary || issueKey,
    projectId: issue.fields?.project?.id || '',
    subtaskType: type ? { id: type.id, name: type.name } : null,
    items,
    textFound: Boolean(text.trim())
  };
});

resolver.define('createDeviceSubtasks', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key);
  const requested = Array.isArray(payload?.items) ? payload.items : [];
  if (!issueKey) throw new Error('Issue is required.');
  if (!requested.length) throw new Error('Select at least one device to split.');

  const issue = await loadIssue(issueKey);
  const projectId = issue.fields?.project?.id;
  if (!projectId) throw new Error('Could not determine the Jira project.');
  const type = await subtaskIssueType(projectId);
  const cfg = (await kvs.get(SETTINGS_KEY)) || {};
  const assetFieldId = cfg.jiraAssetField?.id || '';
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const created = [];
  const skipped = [];

  for (const raw of requested) {
    const identifier = clean(raw?.identifier);
    if (!identifier) continue;
    const splitKey = `${SPLIT_PREFIX}${issueKey}:${normalise(identifier)}`;
    const existing = await kvs.get(splitKey);
    if (existing?.childKey) {
      skipped.push({ identifier, childKey: existing.childKey, reason: 'already-created' });
      continue;
    }

    const fault = clean(raw?.fault);
    const fields = {
      project: { id: projectId },
      issuetype: { id: type.id },
      parent: { key: issueKey },
      summary: `${identifier} - ${fault || 'Device issue'}`.slice(0, 255),
      description: childDescription(issueKey, identifier, fault)
    };
    if (issue.fields?.priority?.id) fields.priority = { id: issue.fields.priority.id };

    const response = await api.asUser().requestJira(route`/rest/api/3/issue`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    if (!response.ok) {
      let detail = '';
      try { detail = JSON.stringify(await response.json()); } catch {}
      throw new Error(`Could not create sub-task for ${identifier} (${response.status}).${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    }

    const child = await response.json();
    const childKey = child.key;
    const asset = clean(raw?.assetId) ? assetById.get(clean(raw.assetId)) : assets.find((item) => assetIdentifiers(item).some((value) => normalise(value) === normalise(identifier)));

    if (assetFieldId && asset) {
      const assetValue = clean(asset.jiraIdentifier || asset.name);
      try {
        await api.asUser().requestJira(route`/rest/api/3/issue/${childKey}`, {
          method: 'PUT',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: { [assetFieldId]: assetValue } })
        });
      } catch {}
    }

    await kvs.set(splitKey, { parentKey: issueKey, childKey, identifier, assetId: asset?.id || '', fault, createdAt: now() });
    if (asset?.id) await addHistory(asset.id, { type: 'ticket-linked', source: 'device-split', relation: 'primary', issueKey: childKey, parentKey: issueKey, message: `${childKey} created from ${issueKey}` });
    created.push({ identifier, childKey, assetId: asset?.id || '' });
  }

  return { created, skipped, total: created.length, issueKey };
});

export const handler = resolver.getDefinitions();
