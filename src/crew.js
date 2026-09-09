import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const SETTINGS_KEY = 'settings:asset-manager';
const CREW_PREFIX = 'internal-crew:';
const ASSET_PREFIX = 'asset:';

const clean = (value) => typeof value === 'string' ? value.trim() : value;
const safeArray = (value) => Array.isArray(value) ? value : [];
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const crewKey = (crewCode) => `${CREW_PREFIX}${Buffer.from(normalise(crewCode), 'utf8').toString('base64url')}`;

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

function fieldValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate ? [String(candidate).trim()] : [];
  }
  return [];
}

async function getSettings() {
  return (await kvs.get(SETTINGS_KEY)) || {};
}

async function searchCrewTickets(settings) {
  const crewField = settings.jiraCrewCodeField;
  if (!crewField?.id) return [];
  const numericId = String(crewField.id).replace('customfield_', '');
  const fields = [
    crewField.id,
    settings.jiraAssetField?.id,
    'summary', 'status', 'created', 'resolutiondate', 'issuetype', 'priority'
  ].filter(Boolean);
  const issues = [];
  let nextPageToken;
  do {
    const body = {
      jql: `cf[${numericId}] is not EMPTY ORDER BY created DESC`,
      fields,
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {})
    };
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Crew ticket lookup failed with status ${response.status}.`);
    const data = await response.json();
    issues.push(...safeArray(data.issues));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  return issues;
}

resolver.define('importCrew', async ({ payload }) => {
  const rows = safeArray(payload?.rows);
  let imported = 0;
  const failed = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const crewCode = clean(row.crewCode || row.code || row.assignmentReference || '');
    if (!crewCode) {
      failed.push({ row: index + 2, message: 'Crew code is required.' });
      continue;
    }
    const existing = await kvs.get(crewKey(crewCode));
    const record = {
      ...(existing || {}),
      crewCode,
      name: clean(row.name || row.displayName || row.crewName || existing?.name || ''),
      location: clean(row.location || row.base || existing?.location || ''),
      email: clean(row.email || existing?.email || ''),
      status: clean(row.status || existing?.status || 'Active'),
      notes: clean(row.notes || existing?.notes || ''),
      importedAt: new Date().toISOString()
    };
    await kvs.set(crewKey(crewCode), record);
    imported += 1;
  }
  return { imported, failed };
});

resolver.define('getCrewReport', async () => {
  const settings = await getSettings();
  if (!settings.jiraCrewCodeField?.id) {
    throw new Error('Map the Jira assignment reference field in Asset Manager configuration before using Crew Tracking.');
  }
  const [crewRows, assets, issues] = await Promise.all([
    queryAllByPrefix(CREW_PREFIX),
    queryAllByPrefix(ASSET_PREFIX),
    searchCrewTickets(settings)
  ]);

  const crewMap = new Map(crewRows.map((crew) => [normalise(crew.crewCode), {
    ...crew,
    currentDevices: [],
    historicalDevices: new Set(),
    tickets: []
  }]));

  const ensureCrew = (code) => {
    const key = normalise(code);
    if (!key) return null;
    if (!crewMap.has(key)) crewMap.set(key, {
      crewCode: clean(code),
      name: '', location: '', email: '', status: 'Not in imported crew list', notes: '',
      currentDevices: [], historicalDevices: new Set(), tickets: []
    });
    return crewMap.get(key);
  };

  for (const asset of assets) {
    if (!asset?.crewCode) continue;
    const crew = ensureCrew(asset.crewCode);
    if (!crew) continue;
    const identifier = asset.jiraIdentifier || asset.name || asset.id;
    crew.currentDevices.push({
      id: asset.id,
      name: asset.name || identifier,
      identifier,
      type: asset.type || '',
      status: asset.status || '',
      location: asset.location || ''
    });
    if (identifier) crew.historicalDevices.add(identifier);
  }

  for (const issue of issues) {
    const crewCodes = fieldValues(issue.fields?.[settings.jiraCrewCodeField.id]);
    const deviceIds = settings.jiraAssetField?.id ? fieldValues(issue.fields?.[settings.jiraAssetField.id]) : [];
    for (const code of crewCodes) {
      const crew = ensureCrew(code);
      if (!crew) continue;
      deviceIds.forEach((id) => crew.historicalDevices.add(id));
      crew.tickets.push({
        key: issue.key,
        summary: issue.fields?.summary || '',
        status: issue.fields?.status?.name || '',
        issueType: issue.fields?.issuetype?.name || '',
        priority: issue.fields?.priority?.name || '',
        created: issue.fields?.created || '',
        resolved: issue.fields?.resolutiondate || '',
        devices: deviceIds
      });
    }
  }

  return [...crewMap.values()].map((crew) => ({
    ...crew,
    historicalDevices: [...crew.historicalDevices],
    currentDeviceCount: crew.currentDevices.length,
    historicalDeviceCount: crew.historicalDevices.size,
    ticketCount: crew.tickets.length,
    reviewRequired: crew.currentDevices.length > 1,
    unreturnedIndicator: Math.max(0, crew.currentDevices.length - 1)
  })).sort((a, b) => {
    if (a.reviewRequired !== b.reviewRequired) return a.reviewRequired ? -1 : 1;
    return String(a.crewCode).localeCompare(String(b.crewCode), undefined, { sensitivity: 'base' });
  });
});

resolver.define('deleteCrew', async ({ payload }) => {
  const crewCode = clean(payload?.crewCode || '');
  if (!crewCode) throw new Error('Crew code is required.');
  await kvs.delete(crewKey(crewCode));
  return { deleted: true };
});

export const handler = resolver.getDefinitions();
