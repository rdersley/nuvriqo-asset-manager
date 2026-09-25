import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory Forge KVS with sorted prefix queries and cursors.
const store = new Map();
function query() {
  const state = { prefix: '', limit: 100, cursor: null };
  const builder = {
    where: (_field, prefix) => { state.prefix = prefix; return builder; },
    limit: (n) => { state.limit = n; return builder; },
    cursor: (c) => { state.cursor = c; return builder; },
    getMany: async () => {
      const keys = [...store.keys()].filter((k) => k.startsWith(state.prefix)).sort();
      const start = state.cursor ? Number(state.cursor) : 0;
      const next = start + state.limit < keys.length ? String(start + state.limit) : undefined;
      return { results: keys.slice(start, start + state.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: next };
    }
  };
  return builder;
}
mock.module('@forge/kvs', { namedExports: {
  kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query },
  WhereConditions: { beginsWith: (p) => p }
} });

// Stub Jira: permission check, field list, issue fetch and JQL search.
let fields = [];
let searchHandler = () => ({ issues: [] });
let issueFields = {};
const searches = [];
const json = (body) => ({ ok: true, status: 200, json: async () => body });
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira: async (path, options = {}) => {
    const url = String(path);
    if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
    if (url === '/rest/api/3/field') return json(fields);
    if (url.startsWith('/rest/api/3/search/jql')) { const body = JSON.parse(options.body); searches.push(body); return json(searchHandler(body)); }
    if (url.startsWith('/rest/api/3/issue/')) return json({ fields: issueFields });
    throw new Error(`Unexpected Jira call ${url}`);
  } }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});

const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(key, fn) { this.defs[key] = fn; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;
await import('../src/issue-panel.js');
const panel = resolvers.at(-1).defs;
const call = (defs, name, payload = {}) => defs[name]({ payload, context: {} });

const TEXT_FIELD = { id: 'customfield_100', name: 'Device ID', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } };
const SETTINGS = { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraProjectKey: 'SD' };
const issue = (key, deviceId) => ({ key, fields: { customfield_100: deviceId, summary: `Ticket ${key}`, status: { name: 'Open' }, created: '2026-09-01T00:00:00.000Z' } });

beforeEach(() => {
  store.clear(); searches.length = 0; issueFields = {};
  fields = [TEXT_FIELD];
  searchHandler = () => ({ issues: [] });
  store.set('settings:asset-manager', { ...SETTINGS });
});

test('delete searches Jira for this device (and its old IDs) instead of the newest 150 tickets', async () => {
  store.set('asset:A1', { id: 'A1', name: 'Tablet 1', jiraIdentifier: 'RYR_1', jiraAliases: ['OLD_9'] });
  searchHandler = () => ({ issues: [issue('SD-5', 'OLD_9')] });
  await assert.rejects(call(main, 'deleteAsset', { id: 'A1' }), /linked to 1 Jira ticket/);
  assert.match(searches[0].jql, /^project = "SD" AND \(/);
  assert.match(searches[0].jql, /cf\[100\] ~ "\\"RYR_1\\""/);
  assert.match(searches[0].jql, /cf\[100\] ~ "\\"OLD_9\\""/);
  assert.ok(store.has('asset:A1'));
});

test('delete refuses when the ticket search could not be completed', async () => {
  store.set('asset:A1', { id: 'A1', name: 'Tablet 1', jiraIdentifier: 'RYR_1' });
  searchHandler = () => ({ issues: [], nextPageToken: 'more' });
  await assert.rejects(call(main, 'deleteAsset', { id: 'A1' }), /Could not check every Jira ticket/);
  assert.equal(searches.length, 20, 'stops at the page cap');
  assert.ok(store.has('asset:A1'));
});

test('untargetable field types fall back to the broad scan and still block an unverifiable delete', async () => {
  fields = [{ id: 'customfield_100', name: 'Device ID', schema: { type: 'any', custom: 'com.example:object' } }];
  store.set('asset:A1', { id: 'A1', name: 'Tablet 1', jiraIdentifier: 'RYR_1' });
  searchHandler = () => ({ issues: [], nextPageToken: 'more' });
  await assert.rejects(call(main, 'deleteAsset', { id: 'A1' }), /Could not check every Jira ticket/);
  assert.match(searches[0].jql, /cf\[100\] is not EMPTY/);
});

test('select fields are matched exactly and an unlinked device is deleted', async () => {
  fields = [{ id: 'customfield_100', name: 'Device ID', schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } }];
  store.set('asset:A1', { id: 'A1', name: 'Tablet 1', jiraIdentifier: 'RYR_1' });
  store.set(`asset-name:${Buffer.from('tablet 1').toString('base64url')}`, { assetId: 'SOMEONE-ELSE' });
  await call(main, 'deleteAsset', { id: 'A1' });
  assert.match(searches[0].jql, /cf\[100\] in \("RYR_1"\)/);
  assert.ok(!store.has('asset:A1'));
  assert.ok(store.has(`asset-name:${Buffer.from('tablet 1').toString('base64url')}`), 'name index owned by another asset is kept');
});

test('ticket history uses the live search rather than stale recorded tickets', async () => {
  store.set('asset:A1', { id: 'A1', name: 'Tablet 1', jiraIdentifier: 'RYR_1' });
  store.set('asset-ticket:A1:SD-1:primary', { assetId: 'A1', key: 'SD-1', relation: 'primary' });
  searchHandler = () => ({ issues: [issue('SD-2', 'RYR_1')] });
  const tickets = await call(main, 'getAssetTickets', { assetId: 'A1' });
  assert.deepEqual(tickets.map((t) => t.key), ['SD-2']);
});

test('issue panel finds devices beyond the first 300 assets', async () => {
  for (let i = 0; i < 350; i += 1) store.set(`asset:M${String(i).padStart(3, '0')}`, { id: `M${i}`, name: `Manual ${i}`, jiraIdentifier: `RYR_${i}` });
  issueFields = { customfield_100: 'RYR_349' };
  const context = await call(panel, 'getIssueAssetContext', { issueKey: 'SD-9' });
  assert.equal(context.primaryAsset?.name, 'Manual 349');
});

test('issue panel resolves Jira-discovered devices by key without scanning', async () => {
  store.set(`asset-name:${Buffer.from('ryr_x').toString('base64url')}`, { assetId: 'J1' });
  store.set('asset:J1', { id: 'J1', name: 'RYR_X' });
  issueFields = { customfield_100: 'RYR_X' };
  const context = await call(panel, 'getIssueAssetContext', { issueKey: 'SD-9' });
  assert.equal(context.primaryAsset?.id, 'J1');
});

test('saving settings keeps a paused scan unless a scan setting changed', async () => {
  const progress = { fieldId: 'customfield_100', projectKey: 'SD', nextPageToken: 'tok', issuesScanned: 500 };
  store.set('sync-progress:asset-manager:jira-field', progress);
  await call(main, 'saveSettings', { settings: { ...SETTINGS, assetTypes: ['Tablet'], statuses: ['In Use'] } });
  assert.deepEqual(store.get('sync-progress:asset-manager:jira-field'), progress);
  await call(main, 'saveSettings', { settings: { ...SETTINGS, jiraProjectKey: 'HW', assetTypes: ['Tablet'], statuses: ['In Use'] } });
  assert.ok(!store.has('sync-progress:asset-manager:jira-field'));
});

test('a paused scan resumes from its token, but not after the project changed', async () => {
  store.set('sync-progress:asset-manager:jira-field', { fieldId: 'customfield_100', projectKey: 'SD', runId: 'r1', nextPageToken: 'tok', issuesScanned: 500, discovered: 0, created: 0, matched: 0, ignored: 0, reconciled: 0 });
  await call(main, 'syncAssetsFromJira', { restart: false });
  assert.equal(searches.at(-1).nextPageToken, 'tok');

  store.set('sync-progress:asset-manager:jira-field', { fieldId: 'customfield_100', projectKey: 'HW', runId: 'r2', nextPageToken: 'old', issuesScanned: 500 });
  await call(main, 'syncAssetsFromJira', { restart: false });
  assert.equal(searches.at(-1).nextPageToken, undefined);
});
