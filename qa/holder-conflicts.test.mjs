import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A Jira scan must not silently reassign a device that already has a holder.
const store = new Map();
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query }, WhereConditions: { beginsWith: (p) => p } } });
let issues = [];
const json = (b) => ({ ok: true, status: 200, json: async () => b });
const requestJira = async (u) => {
  const url = String(u);
  if (url.includes('mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.includes('/search/jql')) return json({ issues });
  if (url.includes('/rest/api/3/field')) return json([{ id: 'customfield_100', name: 'Device ID' }, { id: 'customfield_200', name: 'Crew code' }]);
  return json({});
};
mock.module('@forge/api', { defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) }, namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, f) { this.defs[k] = f; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;

const ticket = (key, device, crew, created = '2026-10-01T10:00:00.000Z') => ({ key, fields: { customfield_100: device, customfield_200: crew, summary: `Fault on ${device}`, created } });
const scan = () => main.syncAssetsFromJira({ payload: { restart: true }, context: {} });
const conflicts = () => main.getDataConflicts({ payload: {}, context: {} });
const resolve = (assetId, action) => main.resolveDataConflict({ payload: { assetId, action }, context: { accountId: 'admin-1' } });
const asset = (id) => store.get(`asset:${id}`);
const history = (id) => [...store.entries()].filter(([k]) => k.startsWith(`asset-history:${id}:`)).map(([, v]) => v);

beforeEach(() => {
  store.clear(); issues = [];
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraCrewCodeField: { id: 'customfield_200', name: 'Crew code' }, jiraProjectKey: 'OPS', crewMappings: [{ crewCode: 'BEN1', displayName: 'Ben' }] });
  store.set('asset:A1', { id: 'A1', name: 'DEV100', jiraIdentifier: 'DEV100', crewCode: 'ANNA1', assigneeName: 'Anna', status: 'In Use' });
  store.set(`asset-name:${Buffer.from('dev100').toString('base64url')}`, { assetId: 'A1', name: 'DEV100' });
});

test('a ticket naming a different holder opens a conflict and leaves the device unchanged', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  const result = await scan();
  assert.equal(result.conflicts, 1);
  assert.equal(asset('A1').crewCode, 'ANNA1');
  assert.equal(asset('A1').assigneeName, 'Anna');
  const { conflicts: list } = await conflicts();
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].currentHolder, list[0].ticketHolder, list[0].ticketCrewCode, list[0].issueKey], ['Anna', 'Ben', 'BEN1', 'OPS-7']);
});

test('a ticket fills in a holder for a device that has none, with no conflict', async () => {
  store.set('asset:A1', { ...asset('A1'), crewCode: '', assigneeName: '' });
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  const result = await scan();
  assert.equal(result.conflicts, 0);
  assert.equal(asset('A1').crewCode, 'BEN1');
  assert.equal(asset('A1').assigneeName, 'Ben');
});

test('a ticket naming the current holder raises nothing', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'anna1')];
  assert.equal((await scan()).conflicts, 0);
  assert.equal((await conflicts()).conflicts.length, 0);
});

test('only the newest ticket counts', async () => {
  issues = [ticket('OPS-9', 'DEV100', 'ANNA1', '2026-10-03T00:00:00Z'), ticket('OPS-2', 'DEV100', 'BEN1', '2026-09-01T00:00:00Z')];
  assert.equal((await scan()).conflicts, 0);
});

test('accepting moves the device to the ticket holder and records who decided', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  await scan();
  await resolve('A1', 'accept');
  assert.equal(asset('A1').crewCode, 'BEN1');
  assert.equal(asset('A1').assigneeName, 'Ben');
  assert.equal((await conflicts()).conflicts.length, 0);
  const entry = history('A1').find((h) => h.type === 'holder-conflict-accepted');
  assert.equal(entry.resolvedBy, 'admin-1');
  assert.match(entry.message, /Anna to Ben after reviewing OPS-7/);
  await assert.rejects(resolve('A1', 'accept'), /already been resolved/);
});

test('keeping the current holder is remembered until a different ticket or person appears', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  await scan();
  await resolve('A1', 'keep');
  assert.equal(asset('A1').crewCode, 'ANNA1');
  let list = await conflicts();
  assert.equal(list.conflicts.length, 0);
  assert.equal(list.kept, 1);
  assert.equal((await scan()).conflicts, 0, 'the same ticket does not reopen it');
  issues = [ticket('OPS-8', 'DEV100', 'BEN1', '2026-10-04T00:00:00Z')];
  assert.equal((await scan()).conflicts, 1, 'a newer ticket does');
  list = await conflicts();
  assert.equal(list.conflicts[0].issueKey, 'OPS-8');
});

test('a conflict clears itself when the holder is fixed by hand or the device is deleted', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  await scan();
  store.set('asset:A1', { ...asset('A1'), crewCode: 'BEN1', assigneeName: 'Ben' });
  assert.equal((await conflicts()).conflicts.length, 0);
  assert.equal(store.has('holder-conflict:A1'), false);
  await scan();
  assert.equal(store.has('holder-conflict:A1'), false);
});

// Assigned-since dates, the device timeline and the bulk holder review.
const bulk = (payload) => main.bulkHolderConflicts({ payload, context: { accountId: 'admin-1' } });
const bulkAll = async (payload) => { let cursor = null; const out = { checked: 0, applied: 0, candidates: [] }; do { const r = await bulk({ ...payload, cursor }); out.checked += r.checked; out.applied += r.applied; out.candidates.push(...r.candidates); cursor = r.nextCursor; } while (cursor); return out; };

test('accepting a conflict dates the assignment from the ticket', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1', '2026-09-14T08:00:00.000Z')];
  await scan();
  await resolve('A1', 'accept');
  assert.equal(asset('A1').assignedAt, '2026-09-14');
});

test('a holder changed by hand is dated today unless a date is given', async () => {
  await main.saveAsset({ payload: { asset: { ...asset('A1'), crewCode: 'CAT1', assigneeName: 'Cat' } }, context: {} });
  assert.equal(asset('A1').assignedAt, new Date().toISOString().slice(0, 10));
  await main.saveAsset({ payload: { asset: { ...asset('A1'), crewCode: 'DAN1', assigneeName: 'Dan', assignedAt: '2026-01-02' } }, context: {} });
  assert.equal(asset('A1').assignedAt, '2026-01-02');
  await main.saveAsset({ payload: { asset: { ...asset('A1'), notes: 'checked' } }, context: {} });
  assert.equal(asset('A1').assignedAt, '2026-01-02', 'other edits leave the date alone');
});

test('the scan records each ticket with its crew code', async () => {
  issues = [ticket('OPS-7', 'DEV100', 'BEN1')];
  await scan();
  assert.equal(store.get('asset-ticket:A1:OPS-7:primary').crewCode, 'BEN1');
});

test('the timeline lists tickets with their crew code, marks other holders, and sums up reporters', async () => {
  issues = [ticket('OPS-9', 'DEV100', 'BEN1', '2026-10-03T00:00:00Z'), ticket('OPS-8', 'DEV100', 'BEN1', '2026-09-20T00:00:00Z'), ticket('OPS-2', 'DEV100', 'ANNA1', '2026-03-01T00:00:00Z')];
  const t = await main.getDeviceTimeline({ payload: { assetId: 'A1' }, context: {} });
  assert.deepEqual(t.events.filter((e) => e.kind === 'ticket').map((e) => [e.key, e.crewCode, e.otherHolder]), [['OPS-9', 'BEN1', true], ['OPS-8', 'BEN1', true], ['OPS-2', 'ANNA1', false]]);
  assert.deepEqual(t.reporters.map((r) => [r.crewCode, r.count]), [['BEN1', 2], ['ANNA1', 1]]);
  assert.deepEqual([t.latestRun.crewCode, t.latestRun.count, t.latestMatchesHolder], ['BEN1', 2, false]);
});

test('bulk review previews, then moves devices whose newest tickets all came from one other person', async () => {
  store.set('asset:A2', { id: 'A2', name: 'DEV200', jiraIdentifier: 'DEV200', crewCode: 'ANNA1', assigneeName: 'Anna' });
  store.set(`asset-name:${Buffer.from('dev200').toString('base64url')}`, { assetId: 'A2', name: 'DEV200' });
  issues = [
    ticket('OPS-9', 'DEV100', 'BEN1', '2026-10-03T00:00:00Z'), ticket('OPS-8', 'DEV100', 'BEN1', '2026-09-20T00:00:00Z'),
    ticket('OPS-7', 'DEV200', 'BEN1', '2026-10-02T00:00:00Z'), ticket('OPS-6', 'DEV200', 'ANNA1', '2026-09-01T00:00:00Z'), ticket('OPS-5', 'DEV200', 'CAT1', '2026-08-01T00:00:00Z')
  ];
  await scan();
  const preview = await bulkAll({ minTickets: 2 });
  assert.deepEqual(preview.candidates.map((c) => [c.deviceName, c.proposedHolder, c.tickets]), [['DEV100', 'Ben', 2]], 'DEV200 has only one newest ticket from Ben');
  assert.equal(asset('A1').crewCode, 'ANNA1', 'preview changes nothing');
  const applied = await bulkAll({ minTickets: 2, apply: true });
  assert.equal(applied.applied, 1);
  assert.deepEqual([asset('A1').crewCode, asset('A1').assigneeName, asset('A1').assignedAt], ['BEN1', 'Ben', '2026-09-20']);
  assert.ok(history('A1').some((h) => h.type === 'holder-bulk-accepted' && /last 2 tickets/.test(h.message)));
  assert.equal((await conflicts()).conflicts.some((c) => c.assetId === 'A1'), false);
});

test('bulk review leaves kept conflicts and tickets older than the date alone', async () => {
  issues = [ticket('OPS-9', 'DEV100', 'BEN1', '2026-10-03T00:00:00Z'), ticket('OPS-8', 'DEV100', 'BEN1', '2026-09-20T00:00:00Z')];
  await scan();
  assert.equal((await bulkAll({ minTickets: 2, since: '2026-10-04' })).candidates.length, 0);
  await resolve('A1', 'keep');
  assert.equal((await bulkAll({ minTickets: 1 })).candidates.length, 0);
});

test('the Jira scan saves each device\'s fault figures for Reports', async () => {
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), jiraFaultField: { id: 'customfield_300', name: 'Fault' } });
  issues = [{ ...ticket('OPS-9', 'DEV100', 'ANNA1', '2026-10-03T00:00:00Z'), fields: { ...ticket('OPS-9', 'DEV100', 'ANNA1', '2026-10-03T00:00:00Z').fields, customfield_300: 'Screen cracked', status: { name: 'Open', statusCategory: { key: 'new' } } } }, ticket('OPS-8', 'DEV100', 'ANNA1', '2026-09-20T00:00:00Z')];
  await scan();
  const f = asset('A1').faultSummary;
  assert.deepEqual([f.total, f.open, f.involved, f.latestFaultKey, f.latestFault], [1, 1, 2, 'OPS-9', 'Screen cracked']);
});

test('the same fault on several tickets is saved as a repeat, ignoring case and spacing', async () => {
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), jiraFaultField: { id: 'customfield_300', name: 'Fault' } });
  const faulty = (key, created, fault, open) => ({ ...ticket(key, 'DEV100', 'ANNA1', created), fields: { ...ticket(key, 'DEV100', 'ANNA1', created).fields, customfield_300: fault, ...(open ? { status: { name: 'Open', statusCategory: { key: 'new' } } } : { resolutiondate: created }) } });
  issues = [faulty('OPS-9', '2026-10-03T00:00:00Z', 'Faulty Battery', true), faulty('OPS-7', '2026-08-01T00:00:00Z', 'faulty  battery'), faulty('OPS-5', '2026-03-01T00:00:00Z', 'Faulty Battery'), faulty('OPS-4', '2026-02-01T00:00:00Z', 'Screen cracked')];
  await scan();
  assert.deepEqual(asset('A1').faultSummary.repeats, [{ fault: 'Faulty Battery', count: 3, open: 1, first: '2026-03-01T00:00:00Z', last: '2026-10-03T00:00:00Z', keys: ['OPS-9', 'OPS-7', 'OPS-5'] }]);
});
