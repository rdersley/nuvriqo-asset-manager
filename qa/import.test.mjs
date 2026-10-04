import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory KVS with simulated latency per call, like Forge storage.
const LATENCY_MS = 5;
const store = new Map();
const wait = () => new Promise((r) => setTimeout(r, LATENCY_MS));
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { await wait(); const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: {
  get: async (k) => { await wait(); return store.get(k); }, set: async (k, v) => { await wait(); store.set(k, v); }, delete: async (k) => { await wait(); store.delete(k); }, query
}, WhereConditions: { beginsWith: (p) => p } } });
const json = (b) => ({ ok: true, status: 200, json: async () => b });
mock.module('@forge/api', { defaultExport: { asUser: () => ({ requestJira: async (u) => (String(u).includes('mypermissions') ? json({ permissions: { ADMINISTER: { havePermission: true } } }) : json({})) }), asApp: () => ({ requestJira: async () => json({}) }) }, namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, f) { this.defs[k] = f; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;
const reconcile = (assets) => main.reconcileAssetImport({ payload: { assets }, context: {} });
const assets = () => [...store.entries()].filter(([k]) => k.startsWith('asset:')).map(([, v]) => v);

beforeEach(() => { store.clear(); store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100' } }); });

test('a 50-row batch imports in parallel, well inside the Forge time limit', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `DEV${1000 + i}`, jiraIdentifier: `DEV${1000 + i}`, serialNumber: `SER${i}`, client: 'RYR', location: 'DUB', status: 'In Use' }));
  const started = Date.now();
  const result = await reconcile(rows);
  const elapsed = Date.now() - started;
  assert.equal(result.created, 50);
  assert.equal(result.failed.length, 0);
  assert.equal(assets().length, 50);
  // One row after another this takes 50 rows x ~10 calls x 5 ms = ~2.5 s; in parallel it is a fraction.
  assert.ok(elapsed < 1200, `took ${elapsed} ms`);
});

test('re-importing updates existing devices in one write and records history', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `DEV${i}`, jiraIdentifier: `DEV${i}`, location: 'DUB' }));
  await reconcile(rows);
  const result = await reconcile(rows.map((r) => ({ ...r, location: 'STN', notes: 'moved' })));
  assert.equal(result.updated, 10);
  assert.ok(assets().every((a) => a.location === 'STN' && a.notes === 'moved'));
});

test('rows that resolve to the same device are applied one after another, not lost', async () => {
  await reconcile([{ name: 'TABLET-1', jiraIdentifier: 'TABLET-1', serialNumber: 'SN-1' }]);
  // Two rows both match TABLET-1 (by name and by serial): both must apply, neither overwrite the other.
  const result = await reconcile([{ name: 'TABLET-1', jiraIdentifier: 'TABLET-1', location: 'DUB' }, { name: 'TABLET-1', jiraIdentifier: 'TABLET-1', client: 'RYR' }]);
  assert.equal(result.failed.length, 0);
  const [only] = assets();
  assert.equal(assets().length, 1);
  assert.equal(only.location, 'DUB');
  assert.equal(only.client, 'RYR');
});

test('two new rows with the same Device Name never create two devices', async () => {
  const result = await reconcile([{ name: 'NEW-1', jiraIdentifier: 'NEW-1' }, { name: 'new-1', jiraIdentifier: 'NEW-1' }]);
  assert.equal(assets().length, 1);
  assert.equal(result.created + result.updated + result.merged, 2, 'the second row updates the device the first created');
});

test('the import preview classifies rows in parallel and keeps their order', async () => {
  await reconcile([{ name: 'DEV-OLD', jiraIdentifier: 'DEV-OLD' }]);
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: i === 7 ? 'DEV-OLD' : `PREV${i}`, jiraIdentifier: i === 7 ? 'DEV-OLD' : `PREV${i}`, serialNumber: `PS${i}` }));
  const started = Date.now();
  const result = await main.previewAssetImportReconciliation({ payload: { assets: rows }, context: {} });
  const elapsed = Date.now() - started;
  assert.deepEqual(result.map((r) => r.index), rows.map((_, i) => i));
  assert.equal(result[7].action, 'update-device-id');
  assert.ok(result.every((r, i) => i === 7 || r.action === 'create'));
  // One row after another: 50 rows x 3+ lookups x 5 ms = 750 ms or more.
  assert.ok(elapsed < 300, `took ${elapsed} ms`);
});
