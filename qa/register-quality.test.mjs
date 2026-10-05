import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Who changed a device, device type spelling, name uniqueness, and the Overview's open fault count.
const store = new Map();
let reads = 0;
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; if (st.prefix === 'asset:') reads += 1; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query }, WhereConditions: { beginsWith: (p) => p } } });
const jiraCalls = [];
const json = (b, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b });
let countResponse = () => json({ count: 7 });
const requestJira = async (u, init) => {
  const url = String(u?.value ?? u);
  jiraCalls.push({ url, body: init?.body });
  if (url.includes('mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.includes('/user/bulk')) return json({ values: [{ accountId: 'acc-1', displayName: 'Rachel Admin' }] });
  if (url.includes('approximate-count')) return countResponse();
  if (url.includes('/rest/api/3/field')) return json([{ id: 'customfield_100', name: 'Device ID' }]);
  return json({});
};
mock.module('@forge/api', { defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) }, namedExports: { route: (s, ...v) => ({ value: s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }) } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, f) { this.defs[k] = f; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;
const call = (name, payload = {}, accountId = 'acc-1') => main[name]({ payload, context: { accountId } });
const nameKey = (n) => `asset-name:${Buffer.from(n.toLowerCase()).toString('base64url')}`;
const assets = () => [...store.entries()].filter(([k]) => k.startsWith('asset:')).map(([, v]) => v);
const historyOf = (id) => [...store.entries()].filter(([k]) => k.startsWith(`asset-history:${id}:`)).map(([, v]) => v);

beforeEach(() => {
  store.clear(); jiraCalls.length = 0; reads = 0; countResponse = () => json({ count: 7 });
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraFaultField: { id: 'customfield_300', name: 'Fault' }, jiraProjectKey: 'OPS', assetTypes: ['Tablet', 'Phone'] });
});

test('history records who made a change and shows their name', async () => {
  const saved = await call('saveAsset', { asset: { name: 'DEV1', type: 'Tablet' } });
  await call('saveAsset', { asset: { ...saved, status: 'Repair' } });
  for (const h of historyOf(saved.id)) assert.equal(h.changedBy, 'acc-1');
  const shown = await call('getAssetHistory', { assetId: saved.id });
  assert.ok(shown.length >= 2);
  assert.ok(shown.every((h) => h.changedByName === 'Rachel Admin'));
  assert.ok(jiraCalls.some((c) => c.url.includes('/user/bulk?') && c.url.includes('accountId=acc-1')));
});

test('a change with no signed-in user records no one', async () => {
  const saved = await call('saveAsset', { asset: { name: 'DEV2' } }, '');
  assert.equal(historyOf(saved.id)[0].changedBy, undefined);
});

test('import matches types to the list ignoring case, and adds new types once', async () => {
  const result = await call('reconcileAssetImport', { assets: [
    { name: 'A1', type: 'tablet' }, { name: 'A2', type: ' TABLET ' }, { name: 'A3', type: 'laptop' }, { name: 'A4', type: 'Laptop' }] });
  assert.equal(result.created, 4);
  const byName = Object.fromEntries(assets().map((a) => [a.name, a.type]));
  assert.deepEqual(byName, { A1: 'Tablet', A2: 'Tablet', A3: 'laptop', A4: 'laptop' });
  assert.deepEqual(result.deviceTypesAdded, ['laptop']);
  assert.deepEqual(store.get('settings:asset-manager').assetTypes, ['Tablet', 'Phone', 'laptop']);
});

test('tidy changes existing devices to the listed spelling and records it', async () => {
  store.set('asset:X1', { id: 'X1', name: 'X1', type: 'tablet' });
  store.set('asset:X2', { id: 'X2', name: 'X2', type: 'Phone' });
  store.set('asset:X3', { id: 'X3', name: 'X3', type: 'scanner' });
  store.set('asset:X4', { id: 'X4', name: 'X4', type: 'Scanner' });
  const r = await call('tidyAssetTypes', {});
  assert.equal(r.changed, 2);
  assert.deepEqual(assets().map((a) => a.type).sort(), ['Phone', 'Tablet', 'scanner', 'scanner']);
  assert.deepEqual(r.typesAdded, ['scanner']);
  const h = historyOf('X1')[0];
  assert.deepEqual([h.source, h.changedBy, h.changes[0].from, h.changes[0].to], ['type-tidy', 'acc-1', 'tablet', 'Tablet']);
});

test('saving a device checks the name with one lookup, not a register scan', async () => {
  for (let i = 0; i < 300; i++) store.set(`asset:B${i}`, { id: `B${i}`, name: `B${i}` });
  reads = 0;
  await call('saveAsset', { asset: { name: 'NEW-1' } });
  assert.equal(reads, 0);
});

test('a duplicate name is still refused, but a stale index entry is not', async () => {
  const first = await call('saveAsset', { asset: { name: 'DUP' } });
  await assert.rejects(call('saveAsset', { asset: { name: 'dup' } }), /already exists/);
  store.delete(`asset:${first.id}`);
  const again = await call('saveAsset', { asset: { name: 'DUP' } });
  assert.equal(store.get(nameKey('DUP')).assetId, again.id);
});

test('open faults are counted by Jira across the project', async () => {
  const r = await call('getOpenFaultCount');
  assert.equal(r.count, 7);
  const body = JSON.parse(jiraCalls.find((c) => c.url.includes('approximate-count')).body);
  assert.equal(body.jql, 'project = "OPS" AND cf[100] is not EMPTY AND cf[300] is not EMPTY AND resolution is EMPTY AND statusCategory != Done');
  countResponse = () => json({}, false);
  assert.equal((await call('getOpenFaultCount')).count, null, 'falls back when Jira cannot count');
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), jiraFaultField: null });
  assert.deepEqual(await call('getOpenFaultCount'), { count: 0, configured: false });
});
