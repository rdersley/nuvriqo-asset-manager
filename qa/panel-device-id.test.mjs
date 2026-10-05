import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// The ticket panel says why its Device ID found no device, and suggests the device it meant.
const store = new Map();
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query }, WhereConditions: { beginsWith: (p) => p } } });
let issueFields = {};
const json = (b) => ({ ok: true, status: 200, json: async () => b });
const requestJira = async (u) => (String(u).startsWith('/rest/api/3/issue/') ? json({ fields: issueFields }) : json({}));
mock.module('@forge/api', { defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) }, namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, f) { this.defs[k] = f; } getDefinitions() { return this.defs; } } });
await import('../src/issue-panel.js');
const panel = resolvers.at(-1).defs;
const context = () => panel.getIssueAssetContext({ payload: { issueKey: 'SD-1' }, context: {} });

beforeEach(() => {
  store.clear();
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraTypeField: { id: 'customfield_200' }, assetTypes: ['Tablet'], deviceIdPatterns: ['Tablet: TAB####', 'DEV####'] });
  store.set('asset:A1', { id: 'A1', name: 'DEV1234', jiraIdentifier: 'DEV1234', serialNumber: 'R58M21ABC', type: 'Tablet' });
  store.set(`asset-name:${Buffer.from('dev1234').toString('base64url')}`, { assetId: 'A1' });
});

test('a serial number in the Device ID field is flagged with the device it belongs to', async () => {
  issueFields = { customfield_100: 'R58M21ABC', customfield_200: { value: 'Tablet' } };
  const { deviceIdCheck } = await context();
  assert.equal(deviceIdCheck.status, 'invalid');
  assert.equal(deviceIdCheck.reason, "Doesn't match the Tablet format (TAB####)");
  assert.deepEqual(deviceIdCheck.suggestion, { assetId: 'A1', deviceId: 'DEV1234', matchedBy: 'serial number' });
});

test('a note containing a Device ID suggests that device; junk suggests none', async () => {
  issueFields = { customfield_100: 'DEV1234 screen cracked' };
  assert.equal((await context()).deviceIdCheck.suggestion.matchedBy, 'Device ID inside the value');
  issueFields = { customfield_100: 'screen cracked' };
  const { deviceIdCheck } = await context();
  assert.deepEqual([deviceIdCheck.status, deviceIdCheck.suggestion], ['invalid', null]);
});

test('a valid but unregistered Device ID says so; a registered one shows no warning', async () => {
  issueFields = { customfield_100: 'TAB0099' };
  assert.deepEqual((await context()).deviceIdCheck, { status: 'unregistered', value: 'TAB0099' });
  issueFields = { customfield_100: 'DEV1234' };
  const ctx = await context();
  assert.equal(ctx.primaryAsset.id, 'A1');
  assert.equal(ctx.deviceIdCheck, null);
});
