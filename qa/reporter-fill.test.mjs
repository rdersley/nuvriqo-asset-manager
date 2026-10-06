import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Filling a ticket's crew code and base from its reporter (src/reporter-fill.js), through the
// crew import (src/crew.js), the ticket-created trigger (src/status-sync.js) and Split Devices
// (src/device-split.js).
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

let issues = {};
let editMeta = {};
let users = {};
const updates = [];
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const requestJira = async (path, options = {}) => {
  const url = String(path);
  if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.startsWith('/rest/api/3/user/search')) { const email = decodeURIComponent(url.split('query=')[1].split('&')[0]); return json(users[email] ? [users[email]] : []); }
  if (url.startsWith('/rest/api/3/field')) return json([{ id: 'customfield_600', name: 'Base' }]);
  const key = url.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)/)?.[1];
  if (key && url.endsWith('/editmeta')) return json({ fields: editMeta });
  if (key && options.method === 'PUT') { const body = JSON.parse(options.body); updates.push({ key, fields: body.fields }); for (const [id, v] of Object.entries(body.fields)) issues[key][id] = v?.id ? editMeta[id].allowedValues.find((o) => o.id === v.id) : v; return { ok: true, status: 204, json: async () => ({}) }; }
  if (key) return issues[key] ? json({ key, fields: issues[key] }) : { ok: false, status: 404, json: async () => ({}) };
  throw new Error(`Unexpected Jira call ${url}`);
};
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) },
  namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }
});
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(key, fn) { this.defs[key] = fn; } getDefinitions() { return this.defs; } } });

await import('../src/crew.js');
const crew = resolvers.at(-1).defs;
const { handler } = await import('../src/status-sync.js');
await import('../src/device-split.js');
const split = resolvers.at(-1).defs;
const call = (defs, name, payload = {}) => defs[name]({ payload, context: {} });

const enc = (v) => Buffer.from(String(v).trim().toLocaleLowerCase('en'), 'utf8').toString('base64url');
const created = (key, project = 'SD') => ({ eventType: 'avi:jira:created:issue', issue: { key, fields: { project: { key: project } } } });
const CREW_FIELD = 'customfield_500';
const BASE_FIELD = 'customfield_600';
const textField = { schema: { type: 'string' } };
const fillLog = () => store.get('internal-crew-ticket-fill:log') || [];

beforeEach(async () => {
  store.clear(); issues = {}; users = {}; updates.length = 0;
  editMeta = { [CREW_FIELD]: textField, [BASE_FIELD]: { schema: { type: 'option' }, allowedValues: [{ id: '10', value: 'DUB' }, { id: '11', value: 'STN' }] } };
  store.set('settings:asset-manager', { jiraCrewCodeField: { id: CREW_FIELD, name: 'Crew code' } });
  await call(crew, 'importCrew', { rows: [
    { crewCode: 'C100', name: 'Jane Doe', email: 'Jane.Doe@example.com', base: 'DUB' },
    { crewCode: 'C200', name: 'Sam Lee', email: 'sam@example.com', base: 'STN' }
  ] });
  await call(crew, 'saveTicketFillSettings', { baseField: { id: BASE_FIELD, name: 'Base' }, fillOnCreate: true, projects: '' });
});

test('import keeps the email lookup in step with the crew record', async () => {
  assert.deepEqual(store.get(`internal-crew-email:${enc('jane.doe@example.com')}`), { crewCodes: ['C100'] });
  await call(crew, 'importCrew', { rows: [{ crewCode: 'C100', email: 'jane@new.example.com' }] });
  assert.equal(store.get(`internal-crew-email:${enc('jane.doe@example.com')}`), undefined, 'old email no longer points at C100');
  assert.deepEqual(store.get(`internal-crew-email:${enc('jane@new.example.com')}`), { crewCodes: ['C100'] });
  await call(crew, 'deleteCrew', { crewCode: 'C100' });
  assert.equal(store.get(`internal-crew-email:${enc('jane@new.example.com')}`), undefined);
});

test('linking a JSM customer adds the account lookup, and rebuild covers older crew', async () => {
  users['sam@example.com'] = { accountId: 'acc-sam', displayName: 'Sam Lee', emailAddress: 'sam@example.com' };
  await call(crew, 'linkCrewCustomers', { limit: 20 });
  assert.deepEqual(store.get(`internal-crew-account:${enc('acc-sam')}`), { crewCodes: ['C200'] });

  store.set(`internal-crew:${enc('C300')}`, { crewCode: 'C300', email: 'old@example.com', location: 'BGY' });
  const r = await call(crew, 'rebuildCrewLookups', {});
  assert.ok(!r.nextCursor);
  assert.deepEqual(store.get(`internal-crew-email:${enc('old@example.com')}`), { crewCodes: ['C300'] });
  assert.ok((await call(crew, 'getTicketFillSettings')).lookupsBuiltAt);
});

test('a new ticket gets its reporter\'s crew code and base', async () => {
  issues['SD-1'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { accountId: 'a1', displayName: 'Jane Doe', emailAddress: 'jane.doe@EXAMPLE.com' } };
  const result = await handler(created('SD-1'));
  assert.equal(result.crewFill, 'filled');
  assert.deepEqual(updates, [{ key: 'SD-1', fields: { [CREW_FIELD]: 'C100', [BASE_FIELD]: { id: '10' } } }]);
  assert.equal(fillLog()[0].result, 'filled');
});

test('a hidden email falls back to the linked JSM account', async () => {
  users['sam@example.com'] = { accountId: 'acc-sam', displayName: 'Sam Lee', emailAddress: 'sam@example.com' };
  await call(crew, 'linkCrewCustomers', { limit: 20 });
  issues['SD-2'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { accountId: 'acc-sam', displayName: 'Sam Lee' } };
  assert.equal((await handler(created('SD-2'))).crewFill, 'filled');
  assert.deepEqual(updates[0].fields, { [CREW_FIELD]: 'C200', [BASE_FIELD]: { id: '11' } });
});

test('values already on the ticket are kept, and a base that is not an option is skipped', async () => {
  issues['SD-3'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { emailAddress: 'jane.doe@example.com' }, [CREW_FIELD]: 'X999' };
  editMeta[BASE_FIELD].allowedValues = [{ id: '11', value: 'STN' }];
  assert.equal((await handler(created('SD-3'))).crewFill, 'nothing-to-fill');
  assert.equal(updates.length, 0);
  assert.match(fillLog()[0].detail, /Crew code: kept-existing, Base: not-an-option/);
});

test('a sub-task uses its parent\'s reporter, not the agent who created it', async () => {
  issues['SD-4'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { emailAddress: 'sam@example.com' } };
  issues['SD-5'] = { project: { key: 'SD' }, issuetype: { subtask: true }, parent: { key: 'SD-4' }, reporter: { emailAddress: 'agent@example.com' } };
  assert.equal((await handler(created('SD-5'))).crewFill, 'filled');
  assert.deepEqual(updates, [{ key: 'SD-5', fields: { [CREW_FIELD]: 'C200', [BASE_FIELD]: { id: '11' } } }]);
});

test('nothing is filled for an unknown or shared email, outside the projects, or when switched off', async () => {
  await call(crew, 'importCrew', { rows: [{ crewCode: 'C201', email: 'sam@example.com', base: 'DUB' }] });
  issues['SD-6'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { emailAddress: 'sam@example.com' } };
  issues['SD-7'] = { project: { key: 'SD' }, issuetype: { subtask: false }, reporter: { emailAddress: 'nobody@example.com' } };
  assert.equal((await handler(created('SD-6'))).crewFill, 'multiple');
  assert.equal((await handler(created('SD-7'))).crewFill, 'not-found');

  await call(crew, 'saveTicketFillSettings', { baseField: { id: BASE_FIELD }, fillOnCreate: true, projects: 'hw, 1bad, x!' });
  assert.deepEqual((await call(crew, 'getTicketFillSettings')).projects, ['HW']);
  assert.equal((await handler(created('SD-7'))).crewFill, undefined);

  await call(crew, 'saveTicketFillSettings', { baseField: { id: BASE_FIELD }, fillOnCreate: false });
  assert.equal((await handler(created('SD-7'))).crewFill, undefined);
  assert.equal((await handler({ eventType: 'avi:jira:updated:issue', issue: { key: 'SD-7' }, changelog: { items: [] } })).crewFill, undefined);
  assert.equal(updates.length, 0);
});

test('Split Devices shows the match and fills the parent on request', async () => {
  issues['SD-8'] = { summary: 'Broken', project: { id: '1', key: 'SD' }, reporter: { displayName: 'Jane Doe', emailAddress: 'jane.doe@example.com' } };
  const preview = await call(split, 'previewDeviceSplit', { issueKey: 'SD-8' });
  assert.equal(preview.reporterFill.status, 'found');
  assert.deepEqual(preview.reporterFill.crew, { crewCode: 'C100', name: 'Jane Doe', base: 'DUB', email: 'Jane.Doe@example.com' });
  assert.deepEqual(preview.reporterFill.rows.map((r) => r.action), ['fill', 'fill']);

  const filled = await call(split, 'fillReporterFields', { issueKey: 'SD-8' });
  assert.equal(filled.result, 'filled');
  assert.deepEqual(updates, [{ key: 'SD-8', fields: { [CREW_FIELD]: 'C100', [BASE_FIELD]: { id: '10' } } }]);
  assert.deepEqual(filled.reporterFill.rows.map((r) => r.action), ['already-set', 'already-set']);
});

test('Split Devices shows nothing when the crew register is not in use (Marketplace)', async () => {
  store.delete('internal-crew-ticket-fill:settings');
  issues['SD-9'] = { summary: 'Broken', project: { id: '1', key: 'SD' }, reporter: { emailAddress: 'jane.doe@example.com' } };
  assert.equal((await call(split, 'previewDeviceSplit', { issueKey: 'SD-9' })).reporterFill, null);
  assert.equal((await handler(created('SD-9'))).crewFill, undefined);
});
