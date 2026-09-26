import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let crewTotal = 0, assetTotal = 0, ticketPages = 0;
const calls = [];
const page = (total, cursor, make) => { const start = cursor ? Number(cursor) : 0; const items = Array.from({ length: Math.min(1000, total - start) }, (_, i) => make(start + i)); return { items, nextCursor: start + 1000 < total ? String(start + 1000) : null }; };
mock.module('@forge/bridge', { namedExports: { invoke: async (name, payload = {}) => {
  calls.push(name);
  if (name === 'getCrewReportConfig') return { crewCodeFieldId: 'cf_crew', assetFieldId: 'cf_dev' };
  if (name === 'getCrewPage') return page(crewTotal, payload.cursor, (i) => ({ crewCode: `C${i}`, name: `Crew ${i}` }));
  if (name === 'getCrewAssetPage') return page(assetTotal, payload.cursor, (i) => ({ id: `A${i}`, name: `Device ${i}`, crewCode: `C${i % 3}`, type: i % 2 ? 'Tablet' : 'Phone' }));
  if (name === 'getCrewTicketPage') { const n = payload.nextPageToken ? Number(payload.nextPageToken) : 0; return { issues: [{ key: `SD-${n}`, fields: { cf_crew: 'C0', cf_dev: `A${n}` } }], nextPageToken: n + 1 < ticketPages ? String(n + 1) : null }; }
  throw new Error(`unexpected ${name}`);
} } });
const { buildCrewReport, loadCrewReport } = await import('./crewReport.js');

test('join flags duplicate device types and crew missing from the register', () => {
  const rows = buildCrewReport({
    crewRows: [{ crewCode: 'ABC', name: 'Alice' }],
    assets: [{ id: '1', crewCode: 'ABC', type: 'Tablet' }, { id: '2', crewCode: 'abc', type: 'Tablet' }, { id: '3', crewCode: 'XYZ', type: 'Phone' }],
    issues: [{ key: 'SD-1', fields: { cf_crew: 'ABC', cf_dev: 'OLD-1' } }],
    crewCodeFieldId: 'cf_crew', assetFieldId: 'cf_dev'
  });
  const alice = rows.find((r) => r.crewCode === 'ABC');
  assert.equal(alice.currentDeviceCount, 2);
  assert.equal(alice.reviewRequired, true);
  assert.equal(alice.unreturnedIndicator, 1);
  assert.equal(alice.ticketCount, 1);
  assert.ok(alice.historicalDevices.includes('OLD-1'));
  assert.equal(rows.find((r) => r.crewCode === 'XYZ').status, 'Not in imported crew list');
  assert.equal(rows[0].crewCode, 'ABC', 'review-required rows sort first');
});

test('loads every page, shows crew/devices before tickets, and is not partial under the caps', async () => {
  crewTotal = 2500; assetTotal = 1800; ticketPages = 3; calls.length = 0;
  const snapshots = [];
  const { rows, partial } = await loadCrewReport(undefined, (r) => snapshots.push(r.reduce((s, c) => s + c.ticketCount, 0)));
  assert.equal(partial, false);
  assert.equal(rows.length, 2500);
  assert.equal(rows.reduce((s, c) => s + c.currentDeviceCount, 0), 1800);
  assert.equal(snapshots[0], 0, 'first view is rendered before any tickets load');
  assert.equal(snapshots.at(-1), 3);
  assert.deepEqual(calls.filter((c) => c === 'getCrewPage').length, 3);
});

test('marks the report partial when a source hits its page cap', async () => {
  crewTotal = 10; assetTotal = 10; ticketPages = 100;
  const { partial } = await loadCrewReport();
  assert.equal(partial, true);
});
