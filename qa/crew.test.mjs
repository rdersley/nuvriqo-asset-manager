import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory Forge KVS with sorted prefix queries and cursors.
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
      const next = start + state.limit < keys.length ? String(start + state.limit) : undefined;
      return { results: keys.slice(start, start + state.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: next };
    }
  };
  return builder;
}
mock.module('@forge/kvs', { namedExports: {
  kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query },
  WhereConditions: { beginsWith: (p) => p }
} });

let users = {};
let ticketPages = [];
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const requestJira = async (path, options = {}) => {
  const url = String(path);
  if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.startsWith('/rest/api/3/user/search')) { const email = decodeURIComponent(url.split('query=')[1].split('&')[0]); return json(users[email] ? [users[email]] : []); }
  if (url.startsWith('/rest/api/3/search/jql')) { const body = JSON.parse(options.body); const i = body.nextPageToken ? Number(body.nextPageToken) : 0; return json({ issues: ticketPages[i] || [], nextPageToken: i + 1 < ticketPages.length ? String(i + 1) : undefined }); }
  throw new Error(`Unexpected Jira call ${url}`);
};
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});
let defs;
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; defs = this.defs; } define(key, fn) { this.defs[key] = fn; } getDefinitions() { return this.defs; } } });
await import('../src/crew.js');
const call = (name, payload = {}) => defs[name]({ payload, context: {} });

const enc = (v) => Buffer.from(String(v).trim().toLocaleLowerCase('en'), 'utf8').toString('base64url');
const crewKey = (code) => `internal-crew:${enc(code)}`;
const addCrew = (n, extra = () => ({})) => { for (let i = 0; i < n; i += 1) store.set(crewKey(`C${String(i).padStart(5, '0')}`), { crewCode: `C${String(i).padStart(5, '0')}`, name: `Crew ${i}`, ...extra(i) }); };

beforeEach(() => { store.clear(); users = {}; ticketPages = []; store.set('settings:asset-manager', { jiraCrewCodeField: { id: 'customfield_500' }, jiraAssetField: { id: 'customfield_100' } }); });

test('crew and crew-device pages cover the whole register, 1,000 per call', async () => {
  addCrew(2500);
  let cursor = null, crew = 0, calls = 0;
  do { const page = await call('getCrewPage', { cursor }); crew += page.items.length; cursor = page.nextCursor; calls += 1; } while (cursor);
  assert.equal(crew, 2500); assert.equal(calls, 3);

  for (let i = 0; i < 1500; i += 1) store.set(`asset:A${String(i).padStart(5, '0')}`, { id: `A${i}`, name: `Device ${i}`, ...(i % 2 ? { crewCode: `C${i}` } : {}) });
  cursor = null; let assets = 0;
  do { const page = await call('getCrewAssetPage', { cursor }); assets += page.items.length; cursor = page.nextCursor; } while (cursor);
  assert.equal(assets, 750, 'only assets with a crew code, past the old 500 cap');
});

test('crew tickets page with a continuation token', async () => {
  ticketPages = Array.from({ length: 12 }, (_, p) => [{ key: `SD-${p}`, fields: { customfield_500: 'C00001' } }]);
  const first = await call('getCrewTicketPage', {});
  assert.equal(first.issues.length, 10); assert.ok(first.nextPageToken);
  const second = await call('getCrewTicketPage', { nextPageToken: first.nextPageToken });
  assert.equal(second.issues.length, 2); assert.equal(second.nextPageToken, null);
});

test('customer linking finds candidates beyond the first 500 crew and reports remaining exactly', async () => {
  addCrew(600, (i) => (i >= 550 ? { email: `crew${i}@example.com` } : {}));
  users['crew550@example.com'] = { accountId: 'acc-550', displayName: 'Crew 550', emailAddress: 'crew550@example.com' };
  const result = await call('linkCrewCustomers', { limit: 20 });
  assert.equal(result.processed, 20);
  assert.equal(result.linked, 1);
  assert.equal(result.remaining, 30);
  assert.equal(store.get(crewKey('C00550')).jsmCustomerAccountId, 'acc-550');
});

test('linked customers are applied to devices anywhere in the register', async () => {
  store.set(crewKey('C00550'), { crewCode: 'C00550', name: 'Crew 550', jsmCustomerLinkStatus: 'linked', jsmCustomerAccountId: 'acc-550', jsmCustomerDisplayName: 'Crew 550' });
  for (let i = 0; i < 1200; i += 1) { const id = `A${String(i).padStart(5, '0')}`; store.set(`asset:${id}`, { id, name: `Device ${i}` }); }
  store.set('asset:A01150', { id: 'A01150', name: 'Late device', crewCode: 'C00550' });
  store.set('asset:A01151', { id: 'A01151', name: 'Someone else', crewCode: 'C00550', assigneeName: 'Different Person' });
  let cursor = null, linked = 0;
  do { const r = await call('applyCrewCustomerLinks', { cursor }); linked += r.assetsLinked; cursor = r.nextCursor; } while (cursor);
  assert.equal(linked, 1);
  assert.equal(store.get('asset:A01150').assigneeAccountId, 'acc-550');
  assert.equal(store.get('asset:A01151').assigneeAccountId, undefined, 'a conflicting holder name is never overwritten');
});

test('reconciliation pages and counts past 500 exceptions', async () => {
  store.set('internal-device-usage:current-session', { sessionId: 'S2', importedRows: 900, reviewCount: 800 });
  for (let i = 0; i < 800; i += 1) store.set(`internal-device-usage-exception:S2:${String(i).padStart(5, '0')}`, { deviceIdentifier: `D${i}`, state: 'assignment-mismatch' });
  const page = await call('getUsageReconciliation', { offset: 500, limit: 250 });
  assert.equal(page.filteredCount, 800);
  assert.equal(page.rows.length, 250);
  assert.equal(page.partial, false);
});

test('storage cleanup removes exceptions from earlier sessions and keeps the current one', async () => {
  store.set('internal-device-usage:current-session', { sessionId: 'S2' });
  for (let i = 0; i < 30; i += 1) store.set(`internal-device-usage-exception:S1:${i}`, {});
  for (let i = 0; i < 5; i += 1) store.set(`internal-device-usage-exception:S2:${i}`, {});
  let r; do { r = await call('cleanupDeviceUsageStorage', { limit: 10 }); } while (r.remaining);
  const left = [...store.keys()].filter((k) => k.startsWith('internal-device-usage-exception:'));
  assert.equal(left.length, 5);
  assert.ok(left.every((k) => k.includes(':S2:')));
});
