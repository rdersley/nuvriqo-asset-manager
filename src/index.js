import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const LINK_PREFIX = 'issue-link:';
const HISTORY_PREFIX = 'asset-history:';
const SETTINGS_KEY = 'settings:asset-manager';

const DEFAULT_SETTINGS = {
  assetTypes: ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Printer', 'Accessory', 'Other'],
  statuses: ['Ordered', 'Available', 'In Use', 'Repair', 'Lost', 'Retired'],
  locations: [],
  customFields: []
};

const now = () => new Date().toISOString();
const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const safeArray = (value) => Array.isArray(value) ? value : [];

function makeAssetId() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `AST-${stamp}-${random}`;
}

function normaliseAsset(input = {}, existing = {}) {
  const id = clean(input.id || existing.id || makeAssetId());
  return {
    ...existing,
    id,
    name: clean(input.name ?? existing.name ?? ''),
    type: clean(input.type ?? existing.type ?? 'Other'),
    manufacturer: clean(input.manufacturer ?? existing.manufacturer ?? ''),
    model: clean(input.model ?? existing.model ?? ''),
    serialNumber: clean(input.serialNumber ?? existing.serialNumber ?? ''),
    assigneeAccountId: clean(input.assigneeAccountId ?? existing.assigneeAccountId ?? ''),
    assigneeName: clean(input.assigneeName ?? existing.assigneeName ?? ''),
    status: clean(input.status ?? existing.status ?? 'Available'),
    location: clean(input.location ?? existing.location ?? ''),
    purchaseDate: clean(input.purchaseDate ?? existing.purchaseDate ?? ''),
    warrantyExpiry: clean(input.warrantyExpiry ?? existing.warrantyExpiry ?? ''),
    notes: clean(input.notes ?? existing.notes ?? ''),
    customFields: typeof input.customFields === 'object' && input.customFields !== null ? input.customFields : (existing.customFields || {}),
    createdAt: existing.createdAt || now(),
    updatedAt: now()
  };
}

async function addHistory(assetId, event) {
  const timestamp = now();
  const key = `${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`;
  await kvs.set(key, { assetId, timestamp, ...event });
}

async function saveOneAsset(supplied, source = 'manual') {
  if (!clean(supplied?.name)) throw new Error('Asset name is required.');
  const existing = supplied.id ? await kvs.get(`${ASSET_PREFIX}${supplied.id}`) : null;
  const asset = normaliseAsset(supplied, existing || {});
  await kvs.set(`${ASSET_PREFIX}${asset.id}`, asset);
  if (!existing) {
    await addHistory(asset.id, { type: 'created', source, message: 'Asset created' });
  } else {
    const changes = [];
    if ((existing.assigneeAccountId || existing.assigneeName) !== (asset.assigneeAccountId || asset.assigneeName)) changes.push({ field: 'assignee', from: existing.assigneeName || 'Unassigned', to: asset.assigneeName || 'Unassigned' });
    if (existing.status !== asset.status) changes.push({ field: 'status', from: existing.status || '', to: asset.status || '' });
    if (existing.location !== asset.location) changes.push({ field: 'location', from: existing.location || '', to: asset.location || '' });
    if (changes.length) await addHistory(asset.id, { type: 'updated', source, message: 'Asset updated', changes });
  }
  return asset;
}

resolver.define('listAssets', async ({ payload }) => {
  const query = String(payload?.query || '').toLowerCase();
  const status = clean(payload?.status || '');
  const type = clean(payload?.type || '');
  const location = clean(payload?.location || '');
  const result = await kvs.query().where('key', WhereConditions.beginsWith(ASSET_PREFIX)).limit(100).getMany();
  let assets = result.results.map((entry) => entry.value);
  if (query) assets = assets.filter((asset) => [asset.id, asset.name, asset.type, asset.manufacturer, asset.model, asset.serialNumber, asset.assigneeName, asset.status, asset.location].some((value) => String(value || '').toLowerCase().includes(query)));
  if (status) assets = assets.filter((asset) => asset.status === status);
  if (type) assets = assets.filter((asset) => asset.type === type);
  if (location) assets = assets.filter((asset) => asset.location === location);
  assets.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return assets;
});

resolver.define('getAsset', async ({ payload }) => payload?.id ? kvs.get(`${ASSET_PREFIX}${payload.id}`) : null);
resolver.define('saveAsset', async ({ payload }) => saveOneAsset(payload?.asset || {}, 'manual'));

resolver.define('bulkImportAssets', async ({ payload }) => {
  const rows = safeArray(payload?.assets);
  if (!rows.length) return { imported: 0, failed: [] };
  const failed = [];
  let imported = 0;
  for (let i = 0; i < rows.length; i += 1) {
    try { await saveOneAsset(rows[i], 'csv-import'); imported += 1; }
    catch (error) { failed.push({ row: i + 2, message: error?.message || 'Import failed' }); }
  }
  return { imported, failed };
});

resolver.define('deleteAsset', async ({ payload }) => {
  if (!payload?.id) throw new Error('Asset id is required.');
  await kvs.delete(`${ASSET_PREFIX}${payload.id}`);
  await addHistory(payload.id, { type: 'deleted', source: 'manual', message: 'Asset deleted' });
  return { ok: true };
});

resolver.define('getAssetHistory', async ({ payload }) => {
  if (!payload?.assetId) return [];
  const result = await kvs.query().where('key', WhereConditions.beginsWith(`${HISTORY_PREFIX}${payload.assetId}:`)).limit(100).getMany();
  return result.results.map((entry) => entry.value).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
});

resolver.define('getSettings', async () => ({ ...DEFAULT_SETTINGS, ...((await kvs.get(SETTINGS_KEY)) || {}) }));
resolver.define('saveSettings', async ({ payload }) => {
  const incoming = payload?.settings || {};
  const settings = {
    assetTypes: safeArray(incoming.assetTypes).map(clean).filter(Boolean),
    statuses: safeArray(incoming.statuses).map(clean).filter(Boolean),
    locations: safeArray(incoming.locations).map(clean).filter(Boolean),
    customFields: safeArray(incoming.customFields).map((field) => ({ key: clean(field.key), label: clean(field.label), type: clean(field.type || 'text') })).filter((field) => field.key && field.label)
  };
  if (!settings.assetTypes.length) settings.assetTypes = DEFAULT_SETTINGS.assetTypes;
  if (!settings.statuses.length) settings.statuses = DEFAULT_SETTINGS.statuses;
  await kvs.set(SETTINGS_KEY, settings);
  return settings;
});

resolver.define('searchUsers', async ({ payload }) => {
  const q = clean(payload?.query || '');
  if (!q || q.length < 2) return [];
  const response = await api.asUser().requestJira(route`/rest/api/3/user/search?query=${q}&maxResults=20`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  const users = await response.json();
  return users.filter((u) => u.active !== false && u.accountType !== 'app').map((u) => ({ accountId: u.accountId, displayName: u.displayName, avatarUrl: u.avatarUrls?.['24x24'] || '' }));
});

resolver.define('getIssueContext', async ({ context }) => {
  const issueKey = context?.extension?.issue?.key;
  if (!issueKey) return { issueKey: null, linkedAsset: null };
  const link = await kvs.get(`${LINK_PREFIX}${issueKey}`);
  const linkedAsset = link?.assetId ? await kvs.get(`${ASSET_PREFIX}${link.assetId}`) : null;
  return { issueKey, linkedAsset };
});

resolver.define('linkAssetToIssue', async ({ payload, context }) => {
  const issueKey = payload?.issueKey || context?.extension?.issue?.key;
  const assetId = payload?.assetId;
  if (!issueKey || !assetId) throw new Error('Issue and asset are required.');
  const asset = await kvs.get(`${ASSET_PREFIX}${assetId}`);
  if (!asset) throw new Error('Asset not found.');
  await kvs.set(`${LINK_PREFIX}${issueKey}`, { issueKey, assetId, linkedAt: now() });
  await addHistory(assetId, { type: 'ticket-linked', source: 'jira', message: `${issueKey} linked to asset`, issueKey });
  return { issueKey, asset };
});

resolver.define('unlinkAssetFromIssue', async ({ payload, context }) => {
  const issueKey = payload?.issueKey || context?.extension?.issue?.key;
  if (!issueKey) throw new Error('Issue is required.');
  const link = await kvs.get(`${LINK_PREFIX}${issueKey}`);
  await kvs.delete(`${LINK_PREFIX}${issueKey}`);
  if (link?.assetId) await addHistory(link.assetId, { type: 'ticket-unlinked', source: 'jira', message: `${issueKey} unlinked from asset`, issueKey });
  return { ok: true };
});

resolver.define('getAssetTickets', async ({ payload }) => {
  const assetId = payload?.assetId;
  if (!assetId) return [];
  const links = await kvs.query().where('key', WhereConditions.beginsWith(LINK_PREFIX)).limit(100).getMany();
  const issueKeys = links.results.filter((entry) => entry.value?.assetId === assetId).map((entry) => entry.value.issueKey);
  if (!issueKeys.length) return [];
  const jql = `key in (${issueKeys.join(',')}) ORDER BY created DESC`;
  const response = await api.asUser().requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=summary,status,created,resolutiondate&maxResults=100`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return issueKeys.map((key) => ({ key }));
  const data = await response.json();
  return (data.issues || []).map((issue) => ({ key: issue.key, summary: issue.fields?.summary || '', status: issue.fields?.status?.name || '', created: issue.fields?.created || '', resolved: issue.fields?.resolutiondate || '' }));
});

export const handler = resolver.getDefinitions();
