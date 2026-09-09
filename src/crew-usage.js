import Resolver from '@forge/resolver';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const CREW_PREFIX = 'internal-crew:';
const ASSET_PREFIX = 'asset:';
const USAGE_PREFIX = 'internal-device-usage:';

const clean = (value) => typeof value === 'string' ? value.trim() : value;
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const safeArray = (value) => Array.isArray(value) ? value : [];
const usageKey = (deviceIdentifier) => `${USAGE_PREFIX}${Buffer.from(normalise(deviceIdentifier), 'utf8').toString('base64url')}`;

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

resolver.define('importDeviceUsage', async ({ payload }) => {
  const rows = safeArray(payload?.rows);
  const existing = await queryEntriesByPrefix(USAGE_PREFIX);
  for (const entry of existing) await kvs.delete(entry.key);

  let imported = 0;
  const failed = [];
  const importedAt = new Date().toISOString();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const deviceIdentifier = clean(row.deviceIdentifier || row.deviceId || row.device || row.assetId || '');
    const crewCode = clean(row.crewCode || row.crew || row.user || row.username || row.assignmentReference || '');
    if (!deviceIdentifier || !crewCode) {
      failed.push({ row: index + 2, message: 'Device identifier and crew code are required.' });
      continue;
    }
    const record = {
      deviceIdentifier,
      crewCode,
      lastLoginAt: clean(row.lastLoginAt || row.lastLogin || row.loginDate || row.lastSeen || ''),
      source: clean(row.source || 'Imported device login report'),
      importedAt
    };
    await kvs.set(usageKey(deviceIdentifier), record);
    imported += 1;
  }

  return { imported, failed, importedAt };
});

resolver.define('getUsageReconciliation', async () => {
  const [crewRows, assets, usages] = await Promise.all([
    queryAllByPrefix(CREW_PREFIX),
    queryAllByPrefix(ASSET_PREFIX),
    queryAllByPrefix(USAGE_PREFIX)
  ]);

  const crewMap = new Map(crewRows.map((crew) => [normalise(crew.crewCode), crew]));
  const assetMap = new Map();
  for (const asset of assets) {
    const keys = [asset.jiraIdentifier, asset.name, asset.id].filter(Boolean);
    for (const key of keys) if (!assetMap.has(normalise(key))) assetMap.set(normalise(key), asset);
  }

  const rows = usages.map((usage) => {
    const crew = crewMap.get(normalise(usage.crewCode)) || null;
    const asset = assetMap.get(normalise(usage.deviceIdentifier)) || null;
    const assignedCrewCode = clean(asset?.crewCode || '');
    let state = 'match';
    let reviewRequired = false;

    if (!crew) {
      state = 'crew-not-in-register';
      reviewRequired = true;
    }
    if (!asset) {
      state = state === 'crew-not-in-register' ? 'crew-and-device-missing' : 'device-not-in-assets';
      reviewRequired = true;
    } else if (!assignedCrewCode) {
      state = 'no-current-assignment';
      reviewRequired = true;
    } else if (normalise(assignedCrewCode) !== normalise(usage.crewCode)) {
      state = 'crew-mismatch';
      reviewRequired = true;
    }

    return {
      ...usage,
      crewName: crew?.name || '',
      crewLocation: crew?.location || '',
      crewStatus: crew?.status || (crew ? '' : 'Not in imported crew list'),
      assetId: asset?.id || '',
      assetName: asset?.name || '',
      assetType: asset?.type || '',
      assetStatus: asset?.status || '',
      assetLocation: asset?.location || '',
      assignedCrewCode,
      assignedPerson: asset?.assigneeName || '',
      state,
      reviewRequired
    };
  });

  const rank = { 'crew-mismatch': 0, 'crew-and-device-missing': 1, 'crew-not-in-register': 2, 'device-not-in-assets': 3, 'no-current-assignment': 4, match: 5 };
  rows.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || String(a.deviceIdentifier).localeCompare(String(b.deviceIdentifier), undefined, { sensitivity: 'base' }));

  return {
    rows,
    importedCount: usages.length,
    reviewCount: rows.filter((row) => row.reviewRequired).length,
    mismatchCount: rows.filter((row) => row.state === 'crew-mismatch').length,
    notInCrewListCount: rows.filter((row) => ['crew-not-in-register', 'crew-and-device-missing'].includes(row.state)).length,
    missingAssetCount: rows.filter((row) => ['device-not-in-assets', 'crew-and-device-missing'].includes(row.state)).length,
    matchedCount: rows.filter((row) => row.state === 'match').length,
    importedAt: usages.map((row) => row.importedAt).filter(Boolean).sort().at(-1) || null
  };
});

resolver.define('clearDeviceUsage', async () => {
  const existing = await queryEntriesByPrefix(USAGE_PREFIX);
  for (const entry of existing) await kvs.delete(entry.key);
  return { deleted: existing.length };
});

export const handler = resolver.getDefinitions();
