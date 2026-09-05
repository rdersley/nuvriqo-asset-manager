import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const LINK_PREFIX = 'issue-link:';
const HISTORY_PREFIX = 'asset-history:';
const SETTINGS_KEY = 'settings:asset-manager';
const SYNC_KEY = 'sync:asset-manager:jira-field';

const DEFAULT_SETTINGS = {
  assetTypes: ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Printer', 'Accessory', 'Other'],
  statuses: ['Ordered', 'Available', 'In Use', 'Repair', 'Lost', 'Retired'],
  locations: [],
  customFields: [],
  jiraAssetField: null
};

const now = () => new Date().toISOString();
const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const safeArray = (value) => Array.isArray(value) ? value : [];
const normaliseName = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const nameIndexKey = (name) => `${ASSET_NAME_PREFIX}${encodeURIComponent(normaliseName(name))}`;

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

async function assertUniqueDeviceName(name, assetId) {
  const normalized = normaliseName(name);
  if (!normalized) throw new Error('Device name is required.');
  const indexed = await kvs.get(nameIndexKey(name));
  if (indexed?.assetId && indexed.assetId !== assetId) throw new Error(`Device name “${clean(name)}” already exists. Device names must be unique.`);
}

async function saveOneAsset(supplied, source = 'manual') {
  if (!clean(supplied?.name)) throw new Error('Device name is required.');
  const existing = supplied.id ? await kvs.get(`${ASSET_PREFIX}${supplied.id}`) : null;
  const asset = normaliseAsset(supplied, existing || {});
  await assertUniqueDeviceName(asset.name, asset.id);
  const oldNameKey = existing?.name ? nameIndexKey(existing.name) : null;
  const newNameKey = nameIndexKey(asset.name);
  await kvs.set(`${ASSET_PREFIX}${asset.id}`, asset);
  await kvs.set(newNameKey, { assetId: asset.id, name: asset.name, updatedAt: asset.updatedAt });
  if (oldNameKey && oldNameKey !== newNameKey) await kvs.delete(oldNameKey);
  if (!existing) {
    await addHistory(asset.id, { type: 'created', source, message: source === 'jira-sync' ? 'Asset discovered from Jira' : 'Asset created' });
  } else {
    const changes = [];
    if (existing.name !== asset.name) changes.push({ field: 'device name', from: existing.name || '', to: asset.name || '' });
    if ((existing.assigneeAccountId || existing.assigneeName) !== (asset.assigneeAccountId || asset.assigneeName)) changes.push({ field: 'assignee', from: existing.assigneeName || 'Unassigned', to: asset.assigneeName || 'Unassigned' });
    if (existing.status !== asset.status) changes.push({ field: 'status', from: existing.status || '', to: asset.status || '' });
    if (existing.location !== asset.location) changes.push({ field: 'location', from: existing.location || '', to: asset.location || '' });
    if (changes.length) await addHistory(asset.id, { type: 'updated', source, message: 'Asset updated', changes });
  }
  return asset;
}

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

function ticketFields(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || '',
    statusCategory: issue.fields?.status?.statusCategory?.key || '',
    issueType: issue.fields?.issuetype?.name || '',
    priority: issue.fields?.priority?.name || '',
    assignee: issue.fields?.assignee?.displayName || '',
    created: issue.fields?.created || '',
    resolved: issue.fields?.resolutiondate || '',
    resolution: issue.fields?.resolution?.name || ''
  };
}

function fieldValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate ? [String(candidate).trim()] : [];
  }
  return [];
}

async function getSettingsValue() {
  return { ...DEFAULT_SETTINGS, ...((await kvs.get(SETTINGS_KEY)) || {}) };
}

async function getJiraCustomFields() {
  const response = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not load Jira fields (${response.status}).`);
  const fields = await response.json();
  return safeArray(fields)
    .filter((field) => field.custom && field.id)
    .map((field) => ({ id: field.id, name: field.name || field.id, schemaType: field.schema?.type || '', customType: field.schema?.custom || '' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function resolveJiraAssetField() {
  const settings = await getSettingsValue();
  const fields = await getJiraCustomFields();
  if (settings.jiraAssetField?.id) {
    const selected = fields.find((field) => field.id === settings.jiraAssetField.id);
    if (selected) return selected;
  }
  const byName = fields.find((field) => normaliseName(field.name) === 'asset name');
  return byName || null;
}

async function searchIssuesWithConfiguredAssetField() {
  const field = await resolveJiraAssetField();
  if (!field) return { field: null, issues: [] };
  const numericId = String(field.id).replace('customfield_', '');
  const jql = `cf[${numericId}] is not EMPTY ORDER BY created DESC`;
  const fields = [field.id, 'summary', 'status', 'issuetype', 'priority', 'assignee', 'created', 'resolutiondate', 'resolution'];
  const issues = [];
  let nextPageToken;
  do {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Jira asset-field lookup failed with status ${response.status}.`);
    const data = await response.json();
    issues.push(...safeArray(data.issues));
    nextPageToken = data.nextPageToken || null;
  } while (nextPageToken);
  return { field, issues };
}

async function syncAssetsFromJira(force = false) {
  const previous = await kvs.get(SYNC_KEY);
  if (!force && previous?.timestamp && Date.now() - new Date(previous.timestamp).getTime() < 60000) return previous;
  const { field, issues } = await searchIssuesWithConfiguredAssetField();
  if (!field) return { timestamp: now(), field: null, discovered: 0, created: 0 };
  const discoveredNames = new Map();
  for (const issue of issues) {
    for (const name of fieldValues(issue.fields?.[field.id])) {
      const normalized = normaliseName(name);
      if (normalized && !discoveredNames.has(normalized)) discoveredNames.set(normalized, name);
    }
  }
  let created = 0;
  for (const name of discoveredNames.values()) {
    const indexed = await kvs.get(nameIndexKey(name));
    if (!indexed?.assetId) {
      await saveOneAsset({ name, type: 'Other', status: 'In Use', notes: `Discovered automatically from Jira field “${field.name}”.` }, 'jira-sync');
      created += 1;
    }
  }
  const result = { timestamp: now(), field, discovered: discoveredNames.size, created };
  await kvs.set(SYNC_KEY, result);
  return result;
}

async function searchAssetTickets(assetId, legacyKeys = []) {
  const asset = await kvs.get(`${ASSET_PREFIX}${assetId}`);
  const matched = [];
  if (asset?.name) {
    const { field, issues } = await searchIssuesWithConfiguredAssetField();
    if (field) {
      const target = normaliseName(asset.name);
      for (const issue of issues) {
        if (fieldValues(issue.fields?.[field.id]).some((value) => normaliseName(value) === target)) matched.push(issue);
      }
    }
  }
  if (legacyKeys.length) {
    const existing = new Set(matched.map((issue) => issue.key));
    const missingKeys = legacyKeys.filter((key) => !existing.has(key));
    if (missingKeys.length) {
      const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql: `key in (${missingKeys.join(',')}) ORDER BY created DESC`, fields: ['summary', 'status', 'issuetype', 'priority', 'assignee', 'created', 'resolutiondate', 'resolution'], maxResults: 100 })
      });
      if (response.ok) {
        const data = await response.json();
        matched.push(...safeArray(data.issues));
      }
    }
  }
  return matched.map(ticketFields).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
}

resolver.define('listAssets', async ({ payload }) => {
  try { await syncAssetsFromJira(false); } catch { /* keep local register available if Jira sync fails */ }
  const query = String(payload?.query || '').toLowerCase();
  const status = clean(payload?.status || '');
  const type = clean(payload?.type || '');
  const location = clean(payload?.location || '');
  let assets = await queryAllByPrefix(ASSET_PREFIX);
  if (query) assets = assets.filter((asset) => [asset.id, asset.name, asset.type, asset.manufacturer, asset.model, asset.serialNumber, asset.assigneeName, asset.status, asset.location].some((value) => String(value || '').toLowerCase().includes(query)));
  if (status) assets = assets.filter((asset) => asset.status === status);
  if (type) assets = assets.filter((asset) => asset.type === type);
  if (location) assets = assets.filter((asset) => asset.location === location);
  assets.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  return assets;
});

resolver.define('syncAssetsFromJira', async () => syncAssetsFromJira(true));
resolver.define('getJiraCustomFields', async () => getJiraCustomFields());

resolver.define('searchDevices', async ({ payload }) => {
  const query = normaliseName(payload?.query || '');
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  return assets.filter((asset) => !query || normaliseName(asset.name).includes(query)).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' })).slice(0, 50).map((asset) => ({ id: asset.id, name: asset.name }));
});

resolver.define('getAssetByName', async ({ payload }) => {
  const name = clean(payload?.name || '');
  if (!name) return null;
  const indexed = await kvs.get(nameIndexKey(name));
  return indexed?.assetId ? kvs.get(`${ASSET_PREFIX}${indexed.assetId}`) : null;
});

resolver.define('getAsset', async ({ payload }) => payload?.id ? kvs.get(`${ASSET_PREFIX}${payload.id}`) : null);
resolver.define('saveAsset', async ({ payload }) => saveOneAsset(payload?.asset || {}, 'manual'));

resolver.define('bulkImportAssets', async ({ payload }) => {
  const rows = safeArray(payload?.assets);
  if (!rows.length) return { imported: 0, failed: [] };
  const failed = [];
  let imported = 0;
  for (let i = 0; i < rows.length; i += 1) {
    try { await saveOneAsset(rows[i], 'bulk-import'); imported += 1; }
    catch (error) { failed.push({ row: i + 2, deviceName: clean(rows[i]?.name || ''), message: error?.message || 'Import failed' }); }
  }
  return { imported, failed };
});

resolver.define('deleteAsset', async ({ payload }) => {
  if (!payload?.id) throw new Error('Asset id is required.');
  const asset = await kvs.get(`${ASSET_PREFIX}${payload.id}`);
  if (!asset) return { ok: true };
  const links = await queryAllByPrefix(LINK_PREFIX);
  const legacyKeys = links.filter((link) => link?.assetId === payload.id).map((link) => link.issueKey).filter(Boolean);
  let linkedTickets;
  try { linkedTickets = await searchAssetTickets(payload.id, legacyKeys); }
  catch { throw new Error('Could not verify whether this device is linked to Jira tickets. Please try again before deleting it.'); }
  if (linkedTickets.length) throw new Error(`This device is linked to ${linkedTickets.length} Jira ticket${linkedTickets.length === 1 ? '' : 's'}. Clear the configured Jira asset field or unlink those tickets before deleting the device.`);
  await kvs.delete(`${ASSET_PREFIX}${payload.id}`);
  if (asset.name) await kvs.delete(nameIndexKey(asset.name));
  await addHistory(payload.id, { type: 'deleted', source: 'manual', message: 'Asset deleted', deviceName: asset.name });
  return { ok: true };
});

resolver.define('getAssetHistory', async ({ payload }) => {
  if (!payload?.assetId) return [];
  const history = await queryAllByPrefix(`${HISTORY_PREFIX}${payload.assetId}:`);
  return history.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
});

resolver.define('getSettings', async () => getSettingsValue());
resolver.define('saveSettings', async ({ payload }) => {
  const incoming = payload?.settings || {};
  const settings = {
    assetTypes: safeArray(incoming.assetTypes).map(clean).filter(Boolean),
    statuses: safeArray(incoming.statuses).map(clean).filter(Boolean),
    locations: safeArray(incoming.locations).map(clean).filter(Boolean),
    customFields: safeArray(incoming.customFields).map((field) => ({ key: clean(field.key), label: clean(field.label), type: clean(field.type || 'text') })).filter((field) => field.key && field.label),
    jiraAssetField: incoming.jiraAssetField?.id ? { id: clean(incoming.jiraAssetField.id), name: clean(incoming.jiraAssetField.name || incoming.jiraAssetField.id) } : null
  };
  if (!settings.assetTypes.length) settings.assetTypes = DEFAULT_SETTINGS.assetTypes;
  if (!settings.statuses.length) settings.statuses = DEFAULT_SETTINGS.statuses;
  await kvs.set(SETTINGS_KEY, settings);
  await kvs.delete(SYNC_KEY);
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
  await kvs.set(`${LINK_PREFIX}${issueKey}`, { issueKey, assetId, deviceName: asset.name, linkedAt: now() });
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
  const assetId = clean(payload?.assetId || '');
  if (!assetId) return [];
  const links = await queryAllByPrefix(LINK_PREFIX);
  const legacyKeys = links.filter((link) => link?.assetId === assetId).map((link) => link.issueKey).filter(Boolean);
  try { return await searchAssetTickets(assetId, legacyKeys); }
  catch { return legacyKeys.map((key) => ({ key })); }
});

resolver.define('getAssetReport', async () => {
  try { await syncAssetsFromJira(false); } catch { /* reporting still works for local assets */ }
  const assets = await queryAllByPrefix(ASSET_PREFIX);
  const links = await queryAllByPrefix(LINK_PREFIX);
  const rows = [];
  for (let start = 0; start < assets.length; start += 5) {
    const batch = assets.slice(start, start + 5);
    const batchRows = await Promise.all(batch.map(async (asset) => {
      const legacyKeys = links.filter((link) => link?.assetId === asset.id).map((link) => link.issueKey).filter(Boolean);
      try {
        const tickets = await searchAssetTickets(asset.id, legacyKeys);
        const open = tickets.filter((ticket) => !ticket.resolved && ticket.statusCategory !== 'done').length;
        return { assetId: asset.id, name: asset.name, type: asset.type, status: asset.status, assigneeName: asset.assigneeName || '', total: tickets.length, open, resolved: tickets.length - open, lastFault: tickets.find((ticket) => ticket.created)?.created || '', error: false };
      } catch {
        return { assetId: asset.id, name: asset.name, type: asset.type, status: asset.status, assigneeName: asset.assigneeName || '', total: null, open: null, resolved: null, lastFault: '', error: true };
      }
    }));
    rows.push(...batchRows);
  }
  return rows.sort((a, b) => (b.total ?? -1) - (a.total ?? -1) || String(b.lastFault || '').localeCompare(String(a.lastFault || '')) || String(a.name).localeCompare(String(b.name)));
});

export const handler = resolver.getDefinitions();