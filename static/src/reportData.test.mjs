import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let assetCount = 0;
let failReportBatch = null;
let truncateBatch = null;
const calls = [];
mock.module('@forge/bridge', { namedExports: { invoke: async (name, payload) => {
  calls.push({ name, payload });
  if (name === 'getReportPage') {
    const start = payload.cursor ? Number(payload.cursor) : 0;
    const items = Array.from({ length: Math.min(2000, assetCount - start) }, (_, i) => ({ id: `A${start + i}`, name: `D${start + i}`, faultSummary: (start + i) % 2 ? null : { total: 3, open: 1, resolved: 2, lastFault: '2026-09-01', latestFaultKey: 'SD-1', latestFault: 'Faulty Battery', repeats: [] } }));
    const next = start + 2000 < assetCount ? String(start + 2000) : null;
    return { items, nextCursor: next };
  }
  if (name === 'getAssetReport') {
    assert.ok(payload.assetIds.length <= 100, 'batches never exceed the backend limit');
    if (payload.assetIds[0] === failReportBatch) throw new Error('boom');
    return { rows: payload.assetIds.map((assetId) => ({ assetId })), truncated: payload.assetIds[0] === truncateBatch };
  }
  throw new Error(`unexpected ${name}`);
} } });
const { loadFullReport, loadReportRows, repeatFaultRows } = await import('./reportData.js');

beforeEach(() => { calls.length = 0; failReportBatch = null; truncateBatch = null; });

test('the full report reads saved fault figures, about one call per 2,000 devices, with no Jira search', async () => {
  assetCount = 4500;
  const progress = [];
  const result = await loadFullReport((m) => progress.push(m));
  assert.equal(result.assets.length, 4500);
  assert.equal(calls.filter((c) => c.name === 'getReportPage').length, 3);
  assert.equal(calls.filter((c) => c.name === 'getAssetReport').length, 0);
  assert.equal(result.reports.length, 2250, 'devices with saved figures');
  assert.equal(result.unscanned, 2250, 'devices the scan has not reached');
  assert.deepEqual(result.reports[0], { assetId: 'A0', name: 'D0', type: undefined, status: undefined, assigneeName: '', total: 3, open: 1, resolved: 2, related: 0, involved: 0, lastFault: '2026-09-01', latestFault: { key: 'SD-1', fault: 'Faulty Battery', summary: '' }, error: false });
  assert.equal(result.partial, false);
  assert.ok(progress.some((m) => m.startsWith('Loading devices')));
});

test('fault column rows are fetched only for the assets in view', async () => {
  const { rows, partial } = await loadReportRows(Array.from({ length: 150 }, (_, i) => ({ id: `V${i}` })));
  assert.equal(rows.length, 150);
  assert.equal(partial, false);
  assert.equal(calls.filter((c) => c.name === 'listAssetsPage').length, 0);
});

test('repeat fault rows list each device and fault seen at least the minimum times, most first', () => {
  const assets = [
    { id: 'A', name: 'RYRS1', faultSummary: { repeats: [{ fault: 'Faulty Battery', count: 2, open: 0, first: '2026-01-01', last: '2026-05-01', keys: ['SD-2', 'SD-1'] }] } },
    { id: 'B', name: 'RYRS2', faultSummary: { repeats: [{ fault: 'Screen cracked', count: 4, open: 1, first: '2026-02-01', last: '2026-09-01', keys: ['SD-9'] }] } },
    { id: 'C', name: 'RYRS3', faultSummary: null }
  ];
  assert.deepEqual(repeatFaultRows(assets).map((r) => [r.name, r.fault, r.count]), [['RYRS2', 'Screen cracked', 4], ['RYRS1', 'Faulty Battery', 2]]);
  assert.deepEqual(repeatFaultRows(assets, 3).map((r) => r.name), ['RYRS2']);
});
