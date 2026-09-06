import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const SETTINGS_KEY = 'settings:asset-manager';
const HISTORY_PREFIX = 'asset-history:';
const PRIMARY_LINK_PREFIX = 'issue-link:';

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const now = () => new Date().toISOString();
const validIdentifier = (value) => {
  const v = normalise(value);
  return Boolean(v && !['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v));
};

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

async function settings() {
  return (await kvs.get(SETTINGS_KEY)) || {};
}

function relatedIdentifiers(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(relatedIdentifiers);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate == null ? [] : relatedIdentifiers(candidate);
  }
  const seen = new Set();
  const result = [];
  for (const item of String(value).split(/[,;\n\r]+/).map((part) => part.trim())) {
    const key = normalise(item);
    if (!validIdentifier(item) || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function firstValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return firstValue(value[0]);
  if (typeof value === 'object') return clean(value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key ?? '');
  return clean(String(value));
}

async function getIssue(issueKey, fieldIds = []) {
  const fields = [...new Set(fieldIds.filter(Boolean))].join(',');
  const suffix = fields ? `?fields=${encodeURIComponent(fields)}` : '';
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}${suffix}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not load Jira issue (${response.status}).`);
  return response.json();
}

async function updateIssueFields(issueKey, fields) {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.stringify(await response.json()); } catch {}
    throw new Error(`Could not update Jira issue (${response.status}).${detail ? ` ${detail.slice(0, 250)}` : ''}`);
  }
}

async function addHistory(assetId, event) {
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event });
}

async function resolveAsset(identifier, assets) {
  const target = normalise(identifier);
  return assets.find((asset) => normalise(asset.jiraIdentifier || asset.name) === target) || null;
}

async function issueContext(issueKey) {
  const cfg = await settings();
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  const primaryFieldId = cfg.jiraAssetField?.id || '';
  const relatedFieldId = cfg.jiraRelatedAssetField?.id || '';
  const issue = await getIssue(issueKey, [primaryFieldId, relatedFieldId]);

  const storedPrimary = await kvs.get(`${PRIMARY_LINK_PREFIX}${issueKey}`);
  const primaryIdentifier = primaryFieldId ? firstValue(issue.fields?.[primaryFieldId]) : '';
  const fieldPrimary = primaryIdentifier ? await resolveAsset(primaryIdentifier, assets) : null;
  const storedPrimaryAsset = storedPrimary?.assetId ? assets.find((asset) => asset.id === storedPrimary.assetId) : null;
  const primaryAsset = fieldPrimary || storedPrimaryAsset || null;

  const relatedIds = relatedFieldId ? relatedIdentifiers(issue.fields?.[relatedFieldId]) : [];
  const relatedAssets = relatedIds.map((identifier) => ({ identifier, asset: assets.find((asset) => normalise(asset.jiraIdentifier || asset.name) === normalise(identifier)) || null }));

  return {
    issueKey,
    primaryAsset,
    primaryIdentifier,
    relatedAssets,
    relatedIdentifiers: relatedIds,
    configured: {
      primary: Boolean(primaryFieldId),
      related: Boolean(relatedFieldId),
      primaryFieldName: cfg.jiraAssetField?.name || 'Device ID',
      relatedFieldName: cfg.jiraRelatedAssetField?.name || 'Related Device ID'
    }
  };
}

resolver.define('getIssueAssetContext', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key || '');
  if (!issueKey) throw new Error('Issue is required.');
  return issueContext(issueKey);
});

resolver.define('searchPanelAssets', async ({ payload }) => {
  const query = normalise(payload?.query || '');
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  return assets
    .filter((asset) => !query || [asset.name, asset.jiraIdentifier, asset.serialNumber, asset.model].some((value) => normalise(value).includes(query)))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }))
    .slice(0, 50)
    .map((asset) => ({ id: asset.id, name: asset.name, jiraIdentifier: asset.jiraIdentifier || asset.name, type: asset.type || '', status: asset.status || '', holder: asset.assigneeName || asset.crewCode || '' }));
});

resolver.define('setPrimaryAsset', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key || '');
  const assetId = clean(payload?.assetId || '');
  if (!issueKey || !assetId) throw new Error('Issue and asset are required.');
  const cfg = await settings();
  if (!cfg.jiraAssetField?.id) throw new Error('Map the Jira device identifier field in Asset Manager configuration first.');
  const asset = await kvs.get(`${ASSET_PREFIX}${assetId}`);
  if (!asset) throw new Error('Asset not found.');
  const identifier = clean(asset.jiraIdentifier || asset.name);
  await updateIssueFields(issueKey, { [cfg.jiraAssetField.id]: identifier });
  await kvs.set(`${PRIMARY_LINK_PREFIX}${issueKey}`, { issueKey, assetId, deviceName: asset.name, linkedAt: now() });
  await addHistory(assetId, { type: 'ticket-linked', source: 'jira', relation: 'primary', issueKey, message: `${issueKey} linked as primary asset` });
  return issueContext(issueKey);
});

resolver.define('clearPrimaryAsset', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key || '');
  if (!issueKey) throw new Error('Issue is required.');
  const cfg = await settings();
  const stored = await kvs.get(`${PRIMARY_LINK_PREFIX}${issueKey}`);
  if (cfg.jiraAssetField?.id) await updateIssueFields(issueKey, { [cfg.jiraAssetField.id]: null });
  await kvs.delete(`${PRIMARY_LINK_PREFIX}${issueKey}`);
  if (stored?.assetId) await addHistory(stored.assetId, { type: 'ticket-unlinked', source: 'jira', relation: 'primary', issueKey, message: `${issueKey} unlinked as primary asset` });
  return issueContext(issueKey);
});

resolver.define('addRelatedAsset', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key || '');
  const assetId = clean(payload?.assetId || '');
  if (!issueKey || !assetId) throw new Error('Issue and asset are required.');
  const cfg = await settings();
  if (!cfg.jiraRelatedAssetField?.id) throw new Error('Map the Jira related asset field in Asset Manager configuration first.');
  const asset = await kvs.get(`${ASSET_PREFIX}${assetId}`);
  if (!asset) throw new Error('Asset not found.');
  const identifier = clean(asset.jiraIdentifier || asset.name);
  const issue = await getIssue(issueKey, [cfg.jiraRelatedAssetField.id]);
  const current = relatedIdentifiers(issue.fields?.[cfg.jiraRelatedAssetField.id]);
  if (!current.some((value) => normalise(value) === normalise(identifier))) current.push(identifier);
  await updateIssueFields(issueKey, { [cfg.jiraRelatedAssetField.id]: current.join(', ') });
  await addHistory(assetId, { type: 'ticket-linked', source: 'jira', relation: 'related', issueKey, message: `${issueKey} linked as related asset` });
  return issueContext(issueKey);
});

resolver.define('removeRelatedAsset', async ({ payload, context }) => {
  const issueKey = clean(payload?.issueKey || context?.extension?.issue?.key || '');
  const assetId = clean(payload?.assetId || '');
  const identifierFromPayload = clean(payload?.identifier || '');
  if (!issueKey) throw new Error('Issue is required.');
  const cfg = await settings();
  if (!cfg.jiraRelatedAssetField?.id) throw new Error('Map the Jira related asset field in Asset Manager configuration first.');
  const asset = assetId ? await kvs.get(`${ASSET_PREFIX}${assetId}`) : null;
  const identifier = clean(asset?.jiraIdentifier || asset?.name || identifierFromPayload);
  if (!identifier) throw new Error('Related asset identifier is required.');
  const issue = await getIssue(issueKey, [cfg.jiraRelatedAssetField.id]);
  const current = relatedIdentifiers(issue.fields?.[cfg.jiraRelatedAssetField.id]);
  const next = current.filter((value) => normalise(value) !== normalise(identifier));
  await updateIssueFields(issueKey, { [cfg.jiraRelatedAssetField.id]: next.length ? next.join(', ') : null });
  if (asset?.id) await addHistory(asset.id, { type: 'ticket-unlinked', source: 'jira', relation: 'related', issueKey, message: `${issueKey} unlinked as related asset` });
  return issueContext(issueKey);
});

export const handler = resolver.getDefinitions();
