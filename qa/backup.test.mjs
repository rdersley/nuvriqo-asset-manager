import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// In-memory stand-in for Forge KVS: ordered keys, cursor paging, TTL metadata and batchSet.
const store = new Map();
const batchCalls = [];
mock.module('@forge/kvs', {
  namedExports: {
    MetadataField: { EXPIRE_TIME: 'EXPIRE_TIME' },
    kvs: {
      query: () => {
        const state = { limit: 100, cursor: null };
        const builder = {
          limit(n) { state.limit = n; return builder; },
          cursor(c) { state.cursor = c; return builder; },
          async getMany() {
            const keys = [...store.keys()].sort();
            const start = state.cursor ? Number(state.cursor) : 0;
            const slice = keys.slice(start, start + state.limit);
            const next = start + state.limit < keys.length ? String(start + state.limit) : undefined;
            return { results: slice.map((key) => ({ key, ...store.get(key) })), nextCursor: next };
          }
        };
        return builder;
      },
      async batchSet(items) {
        batchCalls.push(items.length);
        const failedKeys = [];
        for (const item of items) {
          if (item.key === 'fail-me') { failedKeys.push({ key: item.key }); continue; }
          store.set(item.key, { value: item.value, ...(item.options?.ttl ? { ttl: item.options.ttl } : {}) });
        }
        return { successfulKeys: [], failedKeys };
      }
    }
  }
});
const { exportBackupPage, importBackupBatch, validateBackupItems, defineBackupResolvers } = await import('../src/backup.js');

const exportAll = async (options) => {
  const items = []; let cursor = null; let calls = 0;
  do { const page = await exportBackupPage(cursor, options); items.push(...page.items); cursor = page.cursor; calls += 1; } while (cursor);
  return { items, calls };
};

test('export walks every key across pages, with values and expiry times', async () => {
  store.clear();
  for (let i = 0; i < 250; i += 1) store.set(`asset:${String(i).padStart(3, '0')}`, { value: { id: i } });
  store.set('lock:scan', { value: true, expireTime: new Date(Date.now() + 3_600_000).toISOString() });
  const { items, calls } = await exportAll({ maxBytes: 5_000 });
  assert.equal(items.length, 251);
  assert.ok(calls > 1, 'a small byte budget splits the export into several calls');
  assert.deepEqual(items[0], { key: 'asset:000', value: { id: 0 } });
  assert.ok(items.find((item) => item.key === 'lock:scan').expireTime);
});

test('restore writes in batches of 25, keeps remaining time-to-live and skips expired items', async () => {
  store.clear(); batchCalls.length = 0;
  const items = Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, value: i }));
  items.push({ key: 'ttl', value: 1, expireTime: new Date(Date.now() + 120_000).toISOString() });
  items.push({ key: 'expired', value: 1, expireTime: new Date(Date.now() - 1_000).toISOString() });
  const result = await importBackupBatch(items);
  assert.deepEqual([result.restored, result.skipped, result.failed], [61, 1, []]);
  assert.ok(batchCalls.every((n) => n <= 25));
  assert.equal(store.get('k59').value, 59);
  assert.equal(store.get('ttl').ttl.unit, 'SECONDS');
  assert.ok(store.get('ttl').ttl.value > 100 && store.get('ttl').ttl.value <= 120);
  assert.equal(store.has('expired'), false);
});

test('restore reports keys Forge refused and honours skipKey', async () => {
  store.clear();
  const result = await importBackupBatch([{ key: 'fail-me', value: 1 }, { key: 'keep', value: 2 }, { key: 'internal:x', value: 3 }], { skipKey: (key) => key.startsWith('internal:') });
  assert.deepEqual(result, { restored: 1, skipped: 1, failed: ['fail-me'] });
});

test('an exported backup restores to the same data', async () => {
  store.clear();
  for (let i = 0; i < 40; i += 1) store.set(`r:${i}`, { value: { n: i, nested: { list: [i] } } });
  const { items } = await exportAll();
  const before = JSON.stringify([...store.entries()].sort());
  store.clear();
  await importBackupBatch(items);
  assert.equal(JSON.stringify([...store.entries()].sort()), before);
});

test('restore rejects malformed batches', () => {
  assert.throws(() => validateBackupItems('nope'), /list of items/);
  assert.throws(() => validateBackupItems([{ value: 1 }]), /no valid key/);
  assert.throws(() => validateBackupItems([{ key: 'a' }]), /no value/);
  assert.throws(() => validateBackupItems(Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, value: i }))), /at most 500/);
});

test('defineBackupResolvers registers the two resolvers', async () => {
  store.clear();
  const defs = {};
  defineBackupResolvers({ define: (key, fn) => { defs[key] = fn; } });
  assert.deepEqual(Object.keys(defs).sort(), ['exportBackupPage', 'importBackupBatch']);
  assert.deepEqual(await defs.importBackupBatch({ payload: { items: [{ key: 'x', value: 1 }] } }), { restored: 1, skipped: 0, failed: [] });
  assert.deepEqual((await defs.exportBackupPage({ payload: {} })).items, [{ key: 'x', value: 1 }]);
});
