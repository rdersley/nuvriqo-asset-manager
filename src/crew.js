import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const SETTINGS_KEY = 'settings:asset-manager';
const CREW_PREFIX = 'internal-crew:';
const CREW_ALIAS_PREFIX = 'internal-crew-alias:';
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const DEVICE_CODE_PREFIX = 'internal-vpos-device-code:';
const HISTORY_PREFIX = 'asset-history:';
const USAGE_SESSION_KEY = 'internal-device-usage:current-session';
const USAGE_BATCH_PREFIX = 'internal-device-usage-batch:';

const clean = (value) => typeof value === 'string' ? value.trim() : value;
const safeArray = (value) => Array.isArray(value) ? value : [];
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const encoded = (value) => Buffer.from(normalise(value), 'utf8').toString('base64url');
const crewKey = (crewCode) => `${CREW_PREFIX}${encoded(crewCode)}`;
const crewAliasKey = (value) => `${CREW_ALIAS_PREFIX}${encoded(value)}`;
const nameIndexKey = (value) => `${ASSET_NAME_PREFIX}${encoded(value)}`;
const deviceCodeKey = (value) => `${DEVICE_CODE_PREFIX}${encoded(value)}`;
const internalAssetId = (identifier) => `AST-VPOS-${encoded(identifier).slice(0, 40).toUpperCase()}`;
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

function identityValues(record) {
  const email = clean(record?.email || '');
  const emailUser = email.includes('@') ? email.split('@')[0] : '';
  return [...new Set([
    record?.crewCode,
    record?.easysimUsername,
    record?.ryrWinUsername,
    record?.username,
    emailUser
  ].map(clean).filter(Boolean))];
}

async function saveCrewAliases(record, previous = null) {
  const nextAliases = identityValues(record);
  const previousAliases = safeArray(previous?.identityAliases);
  for (const alias of previousAliases) {
    if (!nextAliases.some((value) => normalise(value) === normalise(alias))) {
      const indexed = await kvs.get(crewAliasKey(alias));
      if (indexed?.crewCode && normalise(indexed.crewCode) === normalise(record.crewCode)) await kvs.delete(crewAliasKey(alias));
    }
  }
  for (const alias of nextAliases) await kvs.set(crewAliasKey(alias), { crewCode: record.crewCode, updatedAt: now() });
  return nextAliases;
}

async function resolveCrew(loginValue) {
  const login = clean(loginValue || '');
  if (!login) return null;
  const direct = await kvs.get(crewKey(login));
  if (direct) return direct;
  const alias = await kvs.get(crewAliasKey(login));
  if (!alias?.crewCode) return null;
  return (await kvs.get(crewKey(alias.crewCode))) || null;
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
    const combinedName = clean(row.name || [clean(row.firstName || ''), clean(row.lastName || '')].filter(Boolean).join(' ') || existing?.name || '');
    const record = {
      ...(existing || {}), crewCode,
      name: combinedName,
      firstName: clean(row.firstName || existing?.firstName || ''),
      lastName: clean(row.lastName || existing?.lastName || ''),
      location: clean(row.location || row.base || existing?.location || ''),
      email: clean(row.email || existing?.email || ''),
      easysimUsername: clean(row.easysimUsername || existing?.easysimUsername || ''),
      ryrWinUsername: clean(row.ryrWinUsername || existing?.ryrWinUsername || ''),
      role: clean(row.role || existing?.role || ''),
      contractEndDate: clean(row.contractEndDate || existing?.contractEndDate || ''),
      trainingEndDate: clean(row.trainingEndDate || existing?.trainingEndDate || ''),
      status: clean(row.status || existing?.status || 'Active'),
      notes: clean(row.notes || existing?.notes || ''), importedAt: now()
    };
    record.identityAliases = await saveCrewAliases(record, existing);
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
  const existing = await kvs.get(crewKey(crewCode));
  for (const alias of safeArray(existing?.identityAliases)) {
    const indexed = await kvs.get(crewAliasKey(alias));
    if (indexed?.crewCode && normalise(indexed.crewCode) === normalise(crewCode)) await kvs.delete(crewAliasKey(alias));
  }
  await kvs.delete(crewKey(crewCode));
  return { deleted: true };
});

async function findAsset(deviceIdentifier, deviceCode = '') {
  const identifier = clean(deviceIdentifier || '');
  if (identifier) {
    const index = await kvs.get(nameIndexKey(identifier));
    if (index?.assetId) {
      const indexedAsset = await kvs.get(`${ASSET_PREFIX}${index.assetId}`);
      if (indexedAsset) return indexedAsset;
    }
    const internalAsset = await kvs.get(`${ASSET_PREFIX}${internalAssetId(identifier)}`);
    if (internalAsset) return internalAsset;
  }
  if (deviceCode) {
    const codeIndex = await kvs.get(deviceCodeKey(deviceCode));
    if (codeIndex?.assetId) return (await kvs.get(`${ASSET_PREFIX}${codeIndex.assetId}`)) || null;
  }
  return null;
}

async function createVposAsset({ deviceIdentifier, deviceCode, crew, lastLoginAt, sourceFile }) {
  const timestamp = now();
  const id = internalAssetId(deviceIdentifier);
  const existing = await kvs.get(`${ASSET_PREFIX}${id}`);
  if (existing) return { asset: existing, created: false };
  const crewCode = clean(crew?.crewCode || '');
  const assignedPerson = crewCode ? clean(crew?.name || crewCode) : '';
  const asset = {
    id,
    name: deviceIdentifier,
    jiraIdentifier: deviceIdentifier,
    jiraIdentifierFieldId: '',
    jiraIdentifierFieldName: '',
    crewCode,
    type: 'vPOS',
    manufacturer: '',
    model: '',
    serialNumber: clean(deviceCode || ''),
    assigneeAccountId: '',
    assigneeName: assignedPerson,
    status: 'In Use',
    location: clean(crew?.location || ''),
    purchaseDate: '',
    warrantyExpiry: '',
    notes: 'Imported from vPOS Device Status report',
    customFields: { vposDeviceCode: clean(deviceCode || '') },
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await kvs.set(`${ASSET_PREFIX}${id}`, asset);
  await kvs.set(nameIndexKey(deviceIdentifier), { assetId: id, name: deviceIdentifier, updatedAt: timestamp });
  if (deviceCode) await kvs.set(deviceCodeKey(deviceCode), { assetId: id, deviceCode, updatedAt: timestamp });
  await addHistory(id, {
    type: 'created', source: 'vpos-device-import',
    message: 'Asset created from vPOS Device Status report',
    deviceIdentifier, deviceCode, sourceFile: sourceFile || '', lastLoginAt: clean(lastLoginAt || '')
  });
  if (crewCode) {
    await addHistory(id, {
      type: 'assignment-from-device-login', source: 'device-login-import',
      message: `Assigned to ${assignedPerson || crewCode} from device last-login report`,
      changes: [{ field: 'assignment reference', from: '', to: crewCode }, { field: 'assigned person', from: 'Unassigned', to: assignedPerson || crewCode }],
      crewCode, deviceIdentifier, deviceCode, lastLoginAt: clean(lastLoginAt || ''), sourceFile: sourceFile || ''
    });
  }
  return { asset, created: true };
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
    createdCount: 0,
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
  const results = [];
  let createdCount = 0, assignedCount = 0, mismatchCount = 0, matchedCount = 0, unknownCrewCount = 0, missingAssetCount = 0;

  for (const row of rows) {
    const deviceIdentifier = clean(row.deviceIdentifier || row.deviceName || row.deviceId || row.device || '');
    const deviceCode = clean(row.deviceCode || '');
    const loginValue = clean(row.crewCode || row.lastLogin || row.user || row.username || '');
    if (!deviceIdentifier || !loginValue) continue;

    const crew = await resolveCrew(loginValue);
    let asset = await findAsset(deviceIdentifier, deviceCode);
    let wasCreated = false;
    if (!asset) {
      const created = await createVposAsset({ deviceIdentifier, deviceCode, crew, lastLoginAt: row.lastLoginAt, sourceFile: session.sourceFile });
      asset = created.asset;
      wasCreated = created.created;
      if (wasCreated) createdCount += 1;
    }

    const previousCrewCode = clean(asset?.crewCode || '');
    let state = 'match';
    let reviewRequired = false;
    let action = wasCreated ? 'Created vPOS asset' : 'No change required';
    let assignedCrewCode = previousCrewCode;
    let assignedPerson = clean(asset?.assigneeName || '');

    if (!crew) {
      state = wasCreated ? 'created-unassigned' : 'crew-not-in-register';
      reviewRequired = true;
      action = wasCreated ? 'Created vPOS asset; Last Login not found in crew register' : 'Last Login not found in imported crew register';
      unknownCrewCount += 1;
    } else if (wasCreated) {
      state = 'created-and-assigned';
      assignedCrewCode = clean(crew.crewCode || loginValue);
      assignedPerson = clean(crew.name || assignedCrewCode);
      action = `Created vPOS asset and assigned to ${assignedPerson || assignedCrewCode}`;
      assignedCount += 1;
    } else if (!previousCrewCode) {
      assignedCrewCode = clean(crew.crewCode || loginValue);
      assignedPerson = clean(crew.name || assignedCrewCode);
      const updated = { ...asset, crewCode: assignedCrewCode, assigneeName: assignedPerson, status: asset.status || 'In Use', updatedAt: now() };
      await kvs.set(`${ASSET_PREFIX}${asset.id}`, updated);
      asset = updated;
      await addHistory(asset.id, {
        type: 'assignment-from-device-login', source: 'device-login-import',
        message: `Assigned to ${assignedPerson || assignedCrewCode} from device last-login report`,
        changes: [{ field: 'assignment reference', from: '', to: assignedCrewCode }, { field: 'assigned person', from: 'Unassigned', to: assignedPerson || assignedCrewCode }],
        crewCode: assignedCrewCode, loginValue, deviceIdentifier, deviceCode, lastLoginAt: clean(row.lastLoginAt || ''), sourceFile: session.sourceFile || ''
      });
      state = 'assigned-automatically';
      action = `Assigned to ${assignedPerson || assignedCrewCode}`;
      assignedCount += 1;
    } else if (normalise(previousCrewCode) !== normalise(crew.crewCode)) {
      state = 'assignment-mismatch';
      reviewRequired = true;
      action = `Review: Asset Manager=${previousCrewCode}; last login resolves to ${crew.crewCode}`;
      mismatchCount += 1;
    } else {
      matchedCount += 1;
    }

    results.push({
      deviceIdentifier, deviceCode, crewCode: loginValue, resolvedCrewCode: crew?.crewCode || '', lastLoginAt: clean(row.lastLoginAt || ''), source: clean(row.source || 'vPOS device status report'),
      crewName: crew?.name || '', crewLocation: crew?.location || '', crewStatus: crew?.status || (crew ? '' : 'Not in imported crew list'),
      assetId: asset?.id || '', assetName: asset?.name || '', assetType: asset?.type || '', assetStatus: asset?.status || '', assetLocation: asset?.location || '',
      assignedCrewCode, assignedPerson, previousCrewCode, state, reviewRequired, action, created: wasCreated
    });
  }

  const batchKey = `${USAGE_BATCH_PREFIX}${sessionId}:${String(batchIndex).padStart(5, '0')}`;
  await kvs.set(batchKey, { sessionId, batchIndex, importedAt: now(), rows: results });
  const nextMeta = {
    ...session,
    importedRows: Number(session.importedRows || 0) + results.length,
    createdCount: Number(session.createdCount || 0) + createdCount,
    assignedCount: Number(session.assignedCount || 0) + assignedCount,
    mismatchCount: Number(session.mismatchCount || 0) + mismatchCount,
    matchedCount: Number(session.matchedCount || 0) + matchedCount,
    unknownCrewCount: Number(session.unknownCrewCount || 0) + unknownCrewCount,
    missingAssetCount: Number(session.missingAssetCount || 0) + missingAssetCount,
    completedAt: payload?.finalBatch ? now() : null
  };
  await kvs.set(USAGE_SESSION_KEY, nextMeta);
  return { imported: results.length, createdCount, assignedCount, mismatchCount, matchedCount, unknownCrewCount, missingAssetCount, completedAt: nextMeta.completedAt };
});

resolver.define('getUsageReconciliation', async ({ payload }) => {
  const session = await kvs.get(USAGE_SESSION_KEY);
  if (!session?.sessionId) return { rows: [], importedCount: 0, reviewCount: 0, createdCount: 0, mismatchCount: 0, assignedCount: 0, matchedCount: 0, notInCrewListCount: 0, missingAssetCount: 0, totalRows: 0, filteredCount: 0, importedAt: null };
  const batches = await queryAllByPrefix(`${USAGE_BATCH_PREFIX}${session.sessionId}:`);
  let rows = batches.flatMap((batch) => safeArray(batch?.rows));
  const rank = { 'assignment-mismatch': 0, 'created-unassigned': 1, 'crew-not-in-register': 2, 'created-and-assigned': 3, 'assigned-automatically': 4, match: 5 };
  rows.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || String(a.deviceIdentifier).localeCompare(String(b.deviceIdentifier), undefined, { sensitivity: 'base' }));
  const allRows = rows;
  const totalRows = rows.length;
  const q = normalise(payload?.query || '');
  if (q) rows = rows.filter((row) => [row.deviceIdentifier, row.deviceCode, row.crewCode, row.resolvedCrewCode, row.crewName, row.assignedCrewCode, row.assetName, row.assetType, row.assetLocation].some((value) => normalise(value).includes(q)));
  if (payload?.reviewOnly === true) rows = rows.filter((row) => row.reviewRequired);
  const filteredCount = rows.length;
  const offset = Math.max(0, Number(payload?.offset || 0));
  const limit = Math.min(500, Math.max(1, Number(payload?.limit || 250)));
  const pageRows = rows.slice(offset, offset + limit);
  return {
    rows: pageRows,
    importedCount: totalRows,
    reviewCount: allRows.filter((row) => row.reviewRequired).length,
    createdCount: Number(session.createdCount || 0),
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
