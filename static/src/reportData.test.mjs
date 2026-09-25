import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let assetCount = 0;
let failReportBatch = null;
let truncateBatch = null;
const calls = [];
mock.module('@forge/bridge', { namedExports: { invoke: async (name, payload) => {
  calls.push({ name, payload });
  if (name === 'listAssetsPage') {
    const start = payload.cursor ? Number(payload.cursor) : 0;
    const items = Array.from({ length: Math.min(payload.limit, assetCount - start) }, (_, i) => ({ id: `A${start + i}` }));
    const next = start + payload.limit < assetCount ? String(start + payload.limit) : null;
    return { items, nextCursor: next };
  }
  if (name === 'getAssetReport') {
    assert.ok(payload.assetIds.length <= 100, 'batches never exceed the backend limit');
    if (payload.assetIds[0] === failReportBatch) throw new Error('boom');
    return { rows: payload.assetIds.map((assetId) => ({ assetId })), truncated: payload.assetIds[0] === truncateBatch };
  }
  throw new Error(`unexpected ${name}`);
} } });
const { loadFullReport, loadReportRows } = await import('./reportData.js');

beforeEach(() => { calls.length = 0; failReportBatch = null; truncateBatch = null; });

test('loads every asset past the old 500 limit and a report row for each', async () => {
  assetCount = 1234;
  const progress = [];
  const result = await loadFullReport((m) => progress.push(m));
  assert.equal(result.assets.length, 1234);
  assert.equal(result.reports.length, 1234);
  assert.equal(result.partial, false);
  assert.equal(calls.filter((c) => c.name === 'getAssetReport').length, 13);
  assert.ok(progress.some((m) => m.startsWith('Matching Jira tickets')));
});

test('a failed or truncated batch marks the report partial instead of failing it', async () => {
  assetCount = 300;
  failReportBatch = 'A100';
  let result = await loadFullReport();
  assert.equal(result.partial, true);
  assert.equal(result.reports.length, 200);

  failReportBatch = null; truncateBatch = 'A200';
  result = await loadFullReport();
  assert.equal(result.partial, true);
  assert.equal(result.reports.length, 300);
});

test('fault column rows are fetched only for the assets in view', async () => {
  const { rows, partial } = await loadReportRows(Array.from({ length: 150 }, (_, i) => ({ id: `V${i}` })));
  assert.equal(rows.length, 150);
  assert.equal(partial, false);
  assert.equal(calls.filter((c) => c.name === 'listAssetsPage').length, 0);
});
