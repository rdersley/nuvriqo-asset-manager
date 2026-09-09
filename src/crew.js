import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const SETTINGS_KEY = 'settings:asset-manager';
const CREW_PREFIX = 'internal-crew:';
const ASSET_PREFIX = 'asset:';
const HISTORY_PREFIX = 'asset-history:';
const USAGE_SESSION_KEY = 'internal-device-usage:current-session';
const USAGE_BATCH_PREFIX = 'internal-device-usage-batch:';

const clean = (value) => typeof value === 'string' ? value.trim() : value;
const safeArray = (value) => Array.isArray(value) ? value : [];
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const crewKey = (crewCode) => `${CREW_PREFIX}${Buffer.from(normalise(crewCode), 'utf8').toString('base64url')}`;
const now = () => new Date().toISOString();

async function queryEntriesByPrefix(prefix) {
  const entries = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    entries.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

async function queryAllByPrefix(prefix) {
  return (await queryEntriesByPrefix(prefix)).map((entry) => entry.value);
}

async function addHistory(assetId, event) {
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`, { assetId, timestamp, ...event });
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
  const fields = [crewField.id, settings.jiraAssetField?.id, 'summary', 'status', 'created', 'resolutiondate', 'issuetype', 'priority'].filter(Boolean);
  const issues = [];
  let nextPageToken;
  do {
    const body = { jql: `cf[${numericId}] is not EMPTY ORDER BY created DESC`, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) };
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body)
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
    if (!crewCode) { failed.push({ row: index + 2, message: 'Crew code is required.' }); continue; }
    const existing = await kvs.get(crewKey(crewCode));
    const record = {
      ...(existing || {}), crewCode,
      name: clean(row.name || row.displayName || row.crewName || existing?.name || ''),
      location: clean(row.location || row.base || existing?.location || ''),
      email: clean(row.email || existing?.email || ''),
      status: clean(row.status || existing?.status || 'Active'),
      notes: clean(row.notes || existing?.notes || ''), importedAt: now()
    };
    await kvs.set(crewKey(crewCode), record);
    imported += 1;
  }
  return { imported, failed };
});

resolver.define('getCrewReport', async () => {
  const settings = await getSettings();
  if (!settings.jiraCrewCodeField?.id) throw new Error('Map the Jira assignment reference field in Asset Manager configuration before using Crew Tracking.');
  const [crewRows, assets, issues] = await Promise.all([queryAllByPrefix(CREW_PREFIX), queryAllByPrefix(ASSET_PREFIX), searchCrewTickets(settings)]);
  const crewMap = new Map(crewRows.map((crew) => [normalise(crew.crewCode), { ...crew, currentDevices: [], historicalDevices: new Set(), tickets: [] }]));
  const ensureCrew = (code) => {
    const key = normalise(code);
    if (!key) return null;
    if (!crewMap.has(key)) crewMap.set(key, { crewCode: clean(code), name: '', location: '', email: '', status: 'Not in imported crew list', notes: '', currentDevices: [], historicalDevices: new Set(), tickets: [] });
    return crewMap.get(key);
  };
  for (const asset of assets) {
    if (!asset?.crewCode) continue;
    const crew = ensureCrew(asset.crewCode);
    const identifier = asset.jiraIdentifier || asset.name || asset.id;
    crew.currentDevices.push({ id: asset.id, name: asset.name || identifier, identifier, type: asset.type || 'Unspecified', status: asset.status || '', location: asset.location || '' });
    if (identifier) crew.historicalDevices.add(identifier);
  }
  for (const issue of issues) {
    const crewCodes = fieldValues(issue.fields?.[settings.jiraCrewCodeField.id]);
    const deviceIds = settings.jiraAssetField?.id ? fieldValues(issue.fields?.[settings.jiraAssetField.id]) : [];
    for (const code of crewCodes) {
      const crew = ensureCrew(code);
      if (!crew) continue;
      deviceIds.forEach((id) => crew.historicalDevices.add(id));
      crew.tickets.push({ key: issue.key, summary: issue.fields?.summary || '', status: issue.fields?.status?.name || '', issueType: issue.fields?.issuetype?.name || '', priority: issue.fields?.priority?.name || '', created: issue.fields?.created || '', resolved: issue.fields?.resolutiondate || '', devices: deviceIds });
    }
  }
  return [...crewMap.values()].map((crew) => {
    const typeMap = new Map();
    for (const device of crew.currentDevices) {
      const displayType = clean(device.type) || 'Unspecified';
      const key = normalise(displayType) || 'unspecified';
      if (!typeMap.has(key)) typeMap.set(key, { type: displayType, count: 0, devices: [] });
      const group = typeMap.get(key);
      group.count += 1;
      group.devices.push(device);
    }
    const currentDeviceTypes = [...typeMap.values()].sort((a, b) => String(a.type).localeCompare(String(b.type), undefined, { sensitivity: 'base' }));
    const duplicateDeviceTypes = currentDeviceTypes.filter((group) => group.count > 1);
    const unreturnedIndicator = duplicateDeviceTypes.reduce((sum, group) => sum + Math.max(0, group.count - 1), 0);
    return {
      ...crew,
      historicalDevices: [...crew.historicalDevices], currentDeviceTypes, duplicateDeviceTypes,
      currentDeviceCount: crew.currentDevices.length, currentDeviceTypeCount: currentDeviceTypes.length,
      historicalDeviceCount: crew.historicalDevices.size, ticketCount: crew.tickets.length,
      reviewRequired: duplicateDeviceTypes.length > 0, unreturnedIndicator
    };
  }).sort((a, b) => a.reviewRequired !== b.reviewRequired ? (a.reviewRequired ? -1 : 1) : String(a.crewCode).localeCompare(String(b.crewCode), undefined, { sensitivity: 'base' }));
});

resolver.define('deleteCrew', async ({ payload }) => {
  const crewCode = clean(payload?.crewCode || '');
  if (!crewCode) throw new Error('Crew code is required.');
  await kvs.delete(crewKey(crewCode));
  return { deleted: true };
});

function assetLookup(assets) {
  const map = new Map();
  for (const asset of assets) {
    for (const value of [asset.jiraIdentifier, asset.name, asset.id, asset.serialNumber].filter(Boolean)) {
      const key = normalise(value);
      if (key && !map.has(key)) map.set(key, asset);
    }
  }
  return map;
}

resolver.define('beginDeviceUsageImport', async ({ payload }) => {
  const sessionId = clean(payload?.sessionId || '');
  if (!sessionId) throw new Error('Import session is required.');
  const meta = {
    sessionId,
    sourceFile: clean(payload?.sourceFile || ''),
    sourceRows: Number(payload?.sourceRows || 0),
    usableRows: Number(payload?.usableRows || 0),
    skippedNoLogin: Number(payload?.skippedNoLogin || 0),
    importedRows: 0,
    assignedCount: 0,
    mismatchCount: 0,
    matchedCount: 0,
    unknownCrewCount: 0,
    missingAssetCount: 0,
    startedAt: now(),
    completedAt: null
  };
  await kvs.set(USAGE_SESSION_KEY, meta);
  return meta;
});

resolver.define('importDeviceUsageBatch', async ({ payload }) => {
  const session = await kvs.get(USAGE_SESSION_KEY);
  const sessionId = clean(payload?.sessionId || '');
  if (!session || !sessionId || session.sessionId !== sessionId) throw new Error('The device usage import session is no longer active. Start the import again.');
  const rows = safeArray(payload?.rows);
  const batchIndex = Number(payload?.batchIndex || 0);
  const [crewRows, assets] = await Promise.all([queryAllByPrefix(CREW_PREFIX), queryAllByPrefix(ASSET_PREFIX)]);
  const crewMap = new Map(crewRows.map((crew) => [normalise(crew.crewCode), crew]));
  const assetsByKey = assetLookup(assets);
  const results = [];
  let assignedCount = 0, mismatchCount = 0, matchedCount = 0, unknownCrewCount = 0, missingAssetCount = 0;

  for (const row of rows) {
    const deviceIdentifier = clean(row.deviceIdentifier || row.deviceName || row.deviceId || row.device || '');
    const deviceCode = clean(row.deviceCode || '');
    const crewCode = clean(row.crewCode || row.lastLogin || row.user || row.username || '');
    if (!deviceIdentifier || !crewCode) continue;
    const crew = crewMap.get(normalise(crewCode)) || null;
    const asset = assetsByKey.get(normalise(deviceIdentifier)) || (deviceCode ? assetsByKey.get(normalise(deviceCode)) : null) || null;
    const previousCrewCode = clean(asset?.crewCode || '');
    let state = 'match';
    let reviewRequired = false;
    let action = 'No change required';
    let assignedCrewCode = previousCrewCode;
    let assignedPerson = clean(asset?.assigneeName || '');

    if (!asset) {
      state = crew ? 'device-not-in-assets' : 'crew-and-device-missing';
      reviewRequired = true;
      action = 'Device not found in Asset Manager';
      missingAssetCount += 1;
      if (!crew) unknownCrewCount += 1;
    } else if (!crew) {
      state = 'crew-not-in-register';
      reviewRequired = true;
      action = 'Crew code not found in imported crew register';
      unknownCrewCount += 1;
    } else if (!previousCrewCode) {
      assignedCrewCode = crewCode;
      assignedPerson = clean(crew.name || crewCode);
      const updated = { ...asset, crewCode, assigneeName: assignedPerson, updatedAt: now() };
      await kvs.set(`${ASSET_PREFIX}${asset.id}`, updated);
      await addHistory(asset.id, {
        type: 'assignment-from-device-login', source: 'device-login-import',
        message: `Assigned to ${assignedPerson || crewCode} from device last-login report`,
        changes: [{ field: 'assignment reference', from: '', to: crewCode }, { field: 'assigned person', from: 'Unassigned', to: assignedPerson || crewCode }],
        crewCode, deviceIdentifier, deviceCode, lastLoginAt: clean(row.lastLoginAt || ''), sourceFile: session.sourceFile || ''
      });
      state = 'assigned-automatically';
      action = `Assigned to ${assignedPerson || crewCode}`;
      assignedCount += 1;
    } else if (normalise(previousCrewCode) !== normalise(crewCode)) {
      state = 'assignment-mismatch';
      reviewRequired = true;
      action = `Review: Asset Manager=${previousCrewCode}; last login=${crewCode}`;
      mismatchCount += 1;
    } else {
      matchedCount += 1;
    }

    results.push({
      deviceIdentifier, deviceCode, crewCode, lastLoginAt: clean(row.lastLoginAt || ''), source: clean(row.source || 'vPOS device status report'),
      crewName: crew?.name || '', crewLocation: crew?.location || '', crewStatus: crew?.status || (crew ? '' : 'Not in imported crew list'),
      assetId: asset?.id || '', assetName: asset?.name || '', assetType: asset?.type || '', assetStatus: asset?.status || '', assetLocation: asset?.location || '',
      assignedCrewCode, assignedPerson, previousCrewCode, state, reviewRequired, action
    });
  }

  const batchKey = `${USAGE_BATCH_PREFIX}${sessionId}:${String(batchIndex).padStart(5, '0')}`;
  await kvs.set(batchKey, { sessionId, batchIndex, importedAt: now(), rows: results });
  const nextMeta = {
    ...session,
    importedRows: Number(session.importedRows || 0) + results.length,
    assignedCount: Number(session.assignedCount || 0) + assignedCount,
    mismatchCount: Number(session.mismatchCount || 0) + mismatchCount,
    matchedCount: Number(session.matchedCount || 0) + matchedCount,
    unknownCrewCount: Number(session.unknownCrewCount || 0) + unknownCrewCount,
    missingAssetCount: Number(session.missingAssetCount || 0) + missingAssetCount,
    completedAt: payload?.finalBatch ? now() : null
  };
  await kvs.set(USAGE_SESSION_KEY, nextMeta);
  return { imported: results.length, assignedCount, mismatchCount, matchedCount, unknownCrewCount, missingAssetCount, completedAt: nextMeta.completedAt };
});

resolver.define('getUsageReconciliation', async ({ payload }) => {
  const session = await kvs.get(USAGE_SESSION_KEY);
  if (!session?.sessionId) return { rows: [], importedCount: 0, reviewCount: 0, mismatchCount: 0, assignedCount: 0, matchedCount: 0, notInCrewListCount: 0, missingAssetCount: 0, totalRows: 0, filteredCount: 0, importedAt: null };
  const batches = await queryAllByPrefix(`${USAGE_BATCH_PREFIX}${session.sessionId}:`);
  let rows = batches.flatMap((batch) => safeArray(batch?.rows));
  const rank = { 'assignment-mismatch': 0, 'crew-and-device-missing': 1, 'crew-not-in-register': 2, 'device-not-in-assets': 3, 'assigned-automatically': 4, match: 5 };
  rows.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || String(a.deviceIdentifier).localeCompare(String(b.deviceIdentifier), undefined, { sensitivity: 'base' }));
  const totalRows = rows.length;
  const q = normalise(payload?.query || '');
  if (q) rows = rows.filter((row) => [row.deviceIdentifier, row.deviceCode, row.crewCode, row.crewName, row.assignedCrewCode, row.assetName, row.assetType, row.assetLocation].some((value) => normalise(value).includes(q)));
  if (payload?.reviewOnly === true) rows = rows.filter((row) => row.reviewRequired);
  const filteredCount = rows.length;
  const offset = Math.max(0, Number(payload?.offset || 0));
  const limit = Math.min(500, Math.max(1, Number(payload?.limit || 250)));
  const pageRows = rows.slice(offset, offset + limit);
  return {
    rows: pageRows,
    importedCount: totalRows,
    reviewCount: batches.flatMap((batch) => safeArray(batch?.rows)).filter((row) => row.reviewRequired).length,
    mismatchCount: Number(session.mismatchCount || 0),
    assignedCount: Number(session.assignedCount || 0),
    matchedCount: Number(session.matchedCount || 0),
    notInCrewListCount: Number(session.unknownCrewCount || 0),
    missingAssetCount: Number(session.missingAssetCount || 0),
    totalRows, filteredCount, offset, limit,
    importedAt: session.completedAt || session.startedAt || null,
    sourceFile: session.sourceFile || '', sourceRows: session.sourceRows || 0, skippedNoLogin: session.skippedNoLogin || 0
  };
});

resolver.define('clearDeviceUsage', async () => {
  await kvs.delete(USAGE_SESSION_KEY);
  return { deleted: true };
});

export const handler = resolver.getDefinitions();
