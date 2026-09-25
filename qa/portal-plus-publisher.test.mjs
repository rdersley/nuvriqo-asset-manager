import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const store = new Map();
mock.module('@forge/kvs', { namedExports: {
  kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query: () => { throw new Error('publisher must not scan KVS'); } },
  WhereConditions: { beginsWith: (p) => p }
} });

// Stub Jira (app context only): project, fields, JQL search, property PUT, org lookup.
let searchPages = [];
let putStatus = 200;
const calls = [];
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const requestJira = (as) => async (path, options = {}) => {
  const url = String(path);
  calls.push({ as, url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
  if (url === '/rest/api/3/project/SD') return json({ id: '10001', key: 'SD' });
  if (url === '/rest/api/3/field') return json([{ id: 'customfield_100', name: 'Device ID', schema: { type: 'string' } }, { id: 'customfield_300', name: 'Organizations', schema: { custom: 'com.atlassian.servicedesk:sd-customer-organizations' } }]);
  if (url === '/rest/api/3/search/jql') { const i = calls.filter((c) => c.url === url).length - 1; return json(searchPages[i] || { issues: [] }); }
  if (url.startsWith('/rest/api/3/project/10001/properties/')) return json({}, putStatus);
  if (url.startsWith('/rest/servicedeskapi/organization')) return json({ values: [{ id: '1', name: 'Ryanair' }], isLastPage: true });
  throw new Error(`Unexpected Jira call ${url}`);
};
mock.module('@forge/api', {
  defaultExport: { asApp: () => ({ requestJira: requestJira('app') }), asUser: () => ({ requestJira: requestJira('user') }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(key, fn) { this.defs[key] = fn; } getDefinitions() { return this.defs; } } });

const { refreshPortalPlusSnapshot, fitSnapshot, PORTAL_PLUS_STATUS_KEY } = await import('../src/portal-plus-publisher.js');
await import('../src/portal-assets.js');
const portal = resolvers.at(-1).defs;

const jiraAssetId = (fieldId, id) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${id.toLowerCase()}`).digest('hex').slice(0, 24).toUpperCase()}`;
const org = (id, name) => ({ id, name });
const issue = (device, orgs) => ({ fields: { customfield_100: device, customfield_300: orgs } });

beforeEach(() => {
  store.clear(); calls.length = 0; putStatus = 200; searchPages = [];
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100' }, jiraProjectKey: 'SD' });
});

test('publishes an organisation-scoped snapshot to the configured project', async () => {
  store.set(`asset:${jiraAssetId('customfield_100', 'RYR_1')}`, { id: 'J1', name: 'RYR_1', jiraIdentifier: 'RYR_1', status: 'In Use', serialNumber: 'PRIVATE-SERIAL' });
  store.set(`asset-name:${Buffer.from('laptop 7').toString('base64url')}`, { assetId: 'M7' });
  store.set('asset:M7', { id: 'M7', name: 'Laptop 7', status: 'Available' });
  searchPages = [{ issues: [issue('RYR_1', [org('1', 'Ryanair')]), issue('Laptop 7', [org('1', 'Ryanair'), org('2', 'Lauda')])], nextPageToken: 'p2' }, { issues: [issue('UNKNOWN', [org('2', 'Lauda')])] }];

  const result = await refreshPortalPlusSnapshot();
  assert.equal(result.ok, true);
  const search = calls.find((c) => c.url === '/rest/api/3/search/jql');
  assert.match(search.body.jql, /^project = "SD" AND cf\[100\] is not EMPTY AND cf\[300\] is not EMPTY/);
  assert.deepEqual(search.body.fields, ['customfield_100', 'customfield_300'], 'requests the organisation field (v3 omitted it)');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/rest/api/3/project/10001/properties/nuvriqo.asset-manager.portal');
  const byOrg = Object.fromEntries(put.body.organisations.map((o) => [o.name, o.assets.map((a) => a.id).sort()]));
  assert.deepEqual(byOrg, { Ryanair: ['J1', 'M7'], Lauda: ['M7'] });
  assert.equal(JSON.stringify(put.body).includes('PRIVATE-SERIAL'), false);
  assert.ok(calls.every((c) => c.as === 'app'), 'runs as the app so the scheduled trigger works');
  assert.equal(store.get(PORTAL_PLUS_STATUS_KEY).assetCount, 3);
});

test('large snapshots are trimmed to fit the 32 KB property limit', () => {
  const organisations = Array.from({ length: 6 }, (_, o) => ({ id: String(o), name: `Org ${o}`, assets: Array.from({ length: 50 }, (_, i) => ({ id: `a${o}-${i}`, deviceId: `DEVICE-${o}-${i}`, name: `A fairly long device name ${o}-${i}`, type: 'Handheld', manufacturer: 'Zebra', model: 'TC52', holder: 'Crew member name', status: 'In Use', location: 'DUB' })) }));
  const { snapshot, trimmed } = fitSnapshot({ provider: 'nuvriqo-asset-manager', contractVersion: 1, organisations });
  assert.equal(trimmed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 30000);
  assert.ok(snapshot.organisations.every((o) => o.assets.length > 0));
});

test('skips cleanly when not configured and records failures without throwing', async () => {
  store.set('settings:asset-manager', {});
  assert.equal((await refreshPortalPlusSnapshot()).skipped, true);

  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100' }, jiraProjectKey: 'SD' });
  searchPages = [{ issues: [] }];
  putStatus = 403;
  const result = await refreshPortalPlusSnapshot();
  assert.equal(result.ok, false);
  assert.match(store.get(PORTAL_PLUS_STATUS_KEY).error, /Unable to publish Portal\+ asset snapshot \(403\)/);
});

test('portal organisation lookup is scoped to the signed-in account', async () => {
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100' } });
  searchPages = [{ issues: [] }];
  await portal.getPortalAssets({ payload: {}, context: { accountId: 'acc-123' } });
  const lookup = calls.find((c) => c.url.startsWith('/rest/servicedeskapi/organization'));
  assert.equal(lookup.as, 'app');
  assert.match(lookup.url, /accountId=acc-123/);
  calls.length = 0;
  const empty = await portal.getPortalAssets({ payload: {}, context: {} });
  assert.equal(calls.some((c) => c.url.startsWith('/rest/servicedeskapi/organization')), false);
  assert.match(empty.reason, /not a member/);
});
