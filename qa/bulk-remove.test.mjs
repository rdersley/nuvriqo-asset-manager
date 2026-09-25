import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory stand-in for Forge KVS: sorted prefix queries with cursors.
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
      const slice = keys.slice(start, start + state.limit);
      const next = start + state.limit < keys.length ? String(start + state.limit) : undefined;
      return { results: slice.map((key) => ({ key, value: store.get(key) })), nextCursor: next };
    }
  };
  return builder;
}
mock.module('@forge/kvs', { namedExports: {
  kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query },
  WhereConditions: { beginsWith: (p) => p }
} });

let isAdmin = true;
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira: async () => ({ ok: true, json: async () => ({ permissions: { ADMINISTER: { havePermission: isAdmin } } }) }) }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});

const defs = {};
mock.module('@forge/resolver', { defaultExport: class { define(key, fn) { defs[key] = fn; } getDefinitions() { return defs; } } });
await import('../src/index.js');
const bulkRemove = (payload) => defs.bulkRemoveAssets({ payload, context: {} });

const DISCOVERED = 'Discovered automatically from Jira field “Device ID”.';
const put = (asset) => store.set(`asset:${asset.id}`, asset);
const history = (id) => [...store.keys()].filter((k) => k.startsWith(`asset-history:${id}:`)).map((k) => store.get(k));

beforeEach(() => { store.clear(); isAdmin = true; });

test('cleanup removes unconfirmed Jira discoveries and keeps confirmed or manual assets', async () => {
  put({ id: 'JUNK', name: '0000', notes: DISCOVERED });
  put({ id: 'CURATED', name: 'Tablet 1', notes: DISCOVERED, curatedAt: '2026-09-01T00:00:00.000Z' });
  put({ id: 'MERGED', name: 'Tablet 2', notes: DISCOVERED });
  store.set('asset-history:MERGED:2026-09-02T00:00:00.000Z:a', { assetId: 'MERGED', timestamp: '2026-09-02T00:00:00.000Z', type: 'merged', source: 'import-reconcile' });
  put({ id: 'SYNCED', name: 'Tablet 3', notes: DISCOVERED });
  store.set('asset-history:SYNCED:2026-09-02T00:00:00.000Z:b', { assetId: 'SYNCED', timestamp: '2026-09-02T00:00:00.000Z', type: 'updated', source: 'jira-sync' });
  put({ id: 'MANUAL', name: 'Laptop 1', notes: '' });

  const result = await bulkRemove({ removeAllDiscovered: true, discoveredOnly: true });

  assert.equal(result.removed, 2);
  assert.equal(result.kept, 1);
  assert.ok(!store.has('asset:JUNK'));
  assert.ok(!store.has('asset:SYNCED'), 'automatic sync history is not human confirmation');
  assert.ok(store.has('asset:CURATED'));
  assert.ok(store.has('asset:MANUAL'));
  assert.equal(store.get('asset:MERGED').curatedAt, '2026-09-02T00:00:00.000Z', 'backfill records when it was confirmed');
  assert.equal(history('JUNK').at(-1).source, 'jira-cleanup');
});

test('manual saves mark assets as curated so later cleanups keep them', async () => {
  put({ id: 'EDITED', name: 'Tablet 4', notes: DISCOVERED });
  await defs.saveAsset({ payload: { asset: { ...store.get('asset:EDITED'), location: 'DUB' } }, context: {} });
  assert.ok(store.get('asset:EDITED').curatedAt);
  await bulkRemove({ removeAllDiscovered: true, discoveredOnly: true });
  assert.ok(store.has('asset:EDITED'));
});

test('bulk delete of selected assets skips anything linked to Jira tickets', async () => {
  put({ id: 'FREE', name: 'Spare 1' });
  put({ id: 'TICKETED', name: 'Spare 2' });
  store.set('asset-ticket:TICKETED:SD-1:primary', { assetId: 'TICKETED', key: 'SD-1' });
  put({ id: 'LINKED', name: 'Spare 3' });
  store.set('issue-link:SD-2', { issueKey: 'SD-2', assetId: 'LINKED' });

  const result = await bulkRemove({ ids: ['FREE', 'TICKETED', 'LINKED', 'MISSING'] });

  assert.equal(result.removed, 1);
  assert.deepEqual(result.skipped.map((s) => s.id).sort(), ['LINKED', 'TICKETED']);
  assert.ok(!store.has('asset:FREE'));
  assert.ok(store.has('asset:TICKETED') && store.has('asset:LINKED'));
  assert.equal(history('FREE').at(-1).type, 'deleted');
});

test('bulk delete rejects oversized batches and non-admin callers', async () => {
  await assert.rejects(bulkRemove({ ids: Array.from({ length: 26 }, (_, i) => `A${i}`) }), /at most 25/);
  isAdmin = false;
  put({ id: 'FREE', name: 'Spare 1' });
  await assert.rejects(bulkRemove({ ids: ['FREE'] }), /Only Jira administrators/);
  assert.ok(store.has('asset:FREE'));
});
