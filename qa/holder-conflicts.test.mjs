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
