import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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

// Stub Jira for both user and app calls.
let searchHandler = () => ({ issues: [] });
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const requestJira = async (path, options = {}) => {
  const url = String(path);
  if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url === '/rest/api/3/field') return json([{ id: 'customfield_100', name: 'Device ID', schema: { type: 'string' } }, { id: 'customfield_300', name: 'Organizations', schema: { custom: 'com.atlassian.servicedesk:sd-customer-organizations' } }]);
  if (url.startsWith('/rest/servicedeskapi/organization')) return json({ values: [{ id: '1', name: 'Ryanair' }], isLastPage: true });
  if (url.startsWith('/rest/api/3/search/jql')) return json(searchHandler(JSON.parse(options.body)));
  throw new Error(`Unexpected Jira call ${url}`);
};
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});

const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(key, fn) { this.defs[key] = fn; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;
await import('../src/ticket-sync.js');
const ticketSync = resolvers.at(-1).defs;
await import('../src/portal-assets.js');
const portal = resolvers.at(-1).defs;
const call = (defs, name, payload = {}) => defs[name]({ payload, context: {} });

const jiraAssetId = (fieldId, identifier) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${identifier.toLowerCase()}`).digest('hex').slice(0, 24).toUpperCase()}`;
const filler = (count, prefix = 'A') => { for (let i = 0; i < count; i += 1) store.set(`asset:${prefix}${String(i).padStart(5, '0')}`, { id: `${prefix}${i}`, name: `Filler ${i}`, jiraIdentifier: `FILL_${i}` }); };

beforeEach(() => {
  store.clear();
  searchHandler = () => ({ issues: [] });
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraProjectKey: 'SD' });
});

test('Device field picker finds an exact Jira Device ID beyond the scanned window', async () => {
  filler(2500);
  const id = jiraAssetId('customfield_100', 'RYR_J9');
  store.set(`asset:${id}`, { id, name: 'Tablet J', jiraIdentifier: 'RYR_J9' });
  const results = await call(ticketSync, 'searchDevices', { query: 'RYR_J9' });
  assert.deepEqual(results.map((r) => r.id), [id]);
});

test('Device field picker substring search reaches past the old 500-asset scan', async () => {
  filler(1500);
  store.set('asset:A01499', { id: 'A1499', name: 'Zeta handheld', jiraIdentifier: 'ZETA_1' });
  const results = await call(ticketSync, 'searchDevices', { query: 'zeta' });
  assert.deepEqual(results.map((r) => r.id), ['A1499']);
});

test('Client dropdown includes clients saved on assets beyond the first 1,000', async () => {
  filler(1200);
  await call(main, 'saveAsset', { asset: { name: 'Late device', client: 'LDA' } });
  const options = await call(main, 'getJiraClientOptions');
  assert.ok(options.includes('LDA'));
});

test('asset history returns more than 500 events', async () => {
  for (let i = 0; i < 700; i += 1) store.set(`asset-history:H1:2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.${String(i).padStart(3, '0')}Z:x`, { assetId: 'H1', timestamp: `t${i}` });
  const events = await call(main, 'getAssetHistory', { assetId: 'H1' });
  assert.equal(events.length, 700);
});

test('portal pages past 500 tickets per organisation and flags when it stops early', async () => {
  store.set('asset:P1', { id: 'P1', name: 'OLD_DEVICE', jiraIdentifier: 'OLD_DEVICE' });
  store.set(`asset-name:${Buffer.from('old_device').toString('base64url')}`, { assetId: 'P1' });
  let page = 0;
  searchHandler = () => { page += 1; return page < 7 ? { issues: [], nextPageToken: `p${page}` } : { issues: [{ key: 'SD-1', fields: { customfield_100: 'OLD_DEVICE' } }] }; };
  let result = await call(portal, 'getPortalAssets');
  assert.deepEqual(result.assets.map((a) => a.id), ['P1'], 'device only on the 7th page is found');
  assert.equal(result.partial, false);

  searchHandler = () => ({ issues: [], nextPageToken: 'more' });
  result = await call(portal, 'getPortalAssets');
  assert.equal(result.partial, true);
});
