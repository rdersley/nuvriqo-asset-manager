import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normaliseStatusRules, statusChangeFromEvent, matchStatusRule } from '../src/status-automation.js';

// In-memory KVS that counts operations, so "no work for non-status edits" can be asserted.
const store = new Map();
let kvsOps = 0;
mock.module('@forge/kvs', { namedExports: {
  kvs: { get: async (k) => { kvsOps += 1; return store.get(k); }, set: async (k, v) => { kvsOps += 1; store.set(k, v); }, delete: async (k) => { kvsOps += 1; store.delete(k); }, query: () => ({ where() { return this; }, limit() { return this; }, cursor() { return this; }, getMany: async () => ({ results: [] }) }) },
  WhereConditions: { beginsWith: (p) => p }
} });
let issueFields = {};
const jiraCalls = [];
const json = (body) => ({ ok: true, status: 200, json: async () => body });
const requestJira = async (path) => {
  const url = String(path); jiraCalls.push(url);
  if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.startsWith('/rest/api/3/issue/')) return json({ fields: issueFields });
  throw new Error(`Unexpected Jira call ${url}`);
};
mock.module('@forge/api', { defaultExport: { asApp: () => ({ requestJira }), asUser: () => ({ requestJira }) }, namedExports: { route: (s, ...v) => s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, fn) { this.defs[k] = fn; } getDefinitions() { return this.defs; } } });

const { handler } = await import('../src/status-sync.js');
await import('../src/index.js');
const main = resolvers.at(-1).defs;

const jiraAssetId = (fieldId, id) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${id.toLowerCase()}`).digest('hex').slice(0, 24).toUpperCase()}`;
const statusEvent = (key, to, from = 'Open') => ({ issue: { key }, changelog: { items: [{ field: 'status', fieldId: 'status', fromString: from, toString: to }] } });
const SETTINGS = { statuses: ['Available', 'In Use', 'Repair'], jiraAssetField: { id: 'customfield_100' }, statusAutomationEnabled: true, statusRules: [{ projects: ['SD', 'HW'], ticketStatus: 'Dispatched', deviceStatus: 'In Use' }, { projects: ['HW'], ticketStatus: 'HW Waiting Device Return', deviceStatus: 'Repair' }] };
const device = (identifier, status) => { const id = jiraAssetId('customfield_100', identifier); store.set(`asset:${id}`, { id, name: identifier, jiraIdentifier: identifier, status }); return id; };
const history = (id) => [...store.keys()].filter((k) => k.startsWith(`asset-history:${id}:`)).map((k) => store.get(k));
const log = () => store.get('status-automation:log') || [];

beforeEach(() => { store.clear(); jiraCalls.length = 0; kvsOps = 0; store.set('settings:asset-manager', structuredClone(SETTINGS)); });

test('rules keep configured device-status spelling and drop incomplete or unknown ones', () => {
  const rules = normaliseStatusRules([
    { projects: 'sd, HW, bad key!', ticketStatus: ' Dispatched ', deviceStatus: 'in use' },
    { projects: [], ticketStatus: 'Waiting', deviceStatus: 'Not a status' },
    { projects: 'SD', ticketStatus: '', deviceStatus: 'Repair' }
  ], ['Available', 'In Use', 'Repair']);
  assert.deepEqual(rules, [{ projects: ['SD', 'HW'], ticketStatus: 'Dispatched', deviceStatus: 'In Use' }]);
});

test('only status changes are recognised, and rules match project and status case-insensitively', () => {
  assert.equal(statusChangeFromEvent({ changelog: { items: [{ field: 'summary', toString: 'x' }] } }), null);
  assert.deepEqual(statusChangeFromEvent(statusEvent('SD-1', 'Dispatched')), { from: 'Open', to: 'Dispatched' });
  const rules = normaliseStatusRules(SETTINGS.statusRules, SETTINGS.statuses);
  assert.equal(matchStatusRule(rules, 'hw', 'hw waiting device return')?.deviceStatus, 'Repair');
  assert.equal(matchStatusRule(rules, 'SD', 'HW Waiting Device Return'), null, 'rule limited to HW');
  assert.equal(matchStatusRule(normaliseStatusRules([{ projects: '', ticketStatus: 'Dispatched', deviceStatus: 'In Use' }], SETTINGS.statuses), 'ANY', 'Dispatched')?.deviceStatus, 'In Use');
});

test('a ticket moving to Dispatched sets its device status and records why', async () => {
  const id = device('RYR_WM_7', 'Available');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYR_WM_7' };
  const result = await handler(statusEvent('SD-100', 'Dispatched'));
  assert.equal(result.updated, id);
  assert.equal(store.get(`asset:${id}`).status, 'In Use');
  assert.match(history(id)[0].message, /Status set to In Use by SD-100 \(ticket moved to Dispatched\)/);
  assert.deepEqual(history(id)[0].changes, [{ field: 'status', from: 'Available', to: 'In Use' }]);
  assert.equal(log()[0].result, 'updated');
});

test('HW tickets use the same Device ID field and their own rules', async () => {
  const id = device('RYR_STN_12', 'In Use');
  issueFields = { project: { key: 'HW' }, customfield_100: { value: 'RYR_STN_12' } };
  await handler(statusEvent('HW-9', 'HW Waiting Device Return'));
  assert.equal(store.get(`asset:${id}`).status, 'Repair');
});

test('edits that are not status changes do no work at all', async () => {
  const result = await handler({ issue: { key: 'SD-1' }, changelog: { items: [{ field: 'summary', fromString: 'a', toString: 'b' }] } });
  assert.equal(result.skipped, 'not-a-status-change');
  assert.equal(kvsOps, 0);
  assert.equal(jiraCalls.length, 0);
});

test('ambiguous or unknown devices are skipped and logged, never guessed', async () => {
  device('RYR_WM_7', 'Available');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYR_WM_7 | RYR_WM_6' };
  assert.equal((await handler(statusEvent('SD-2', 'Dispatched'))).skipped, 'multiple-devices');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYR_XX_99' };
  assert.equal((await handler(statusEvent('SD-3', 'Dispatched'))).skipped, 'device-not-in-register');
  issueFields = { project: { key: 'SD' }, customfield_100: null };
  assert.equal((await handler(statusEvent('SD-4', 'Dispatched'))).skipped, 'no-device-on-ticket');
  assert.deepEqual(log().map((e) => e.result), ['no-device-on-ticket', 'device-not-in-register', 'multiple-devices']);
  assert.equal(store.get(`asset:${jiraAssetId('customfield_100', 'RYR_WM_7')}`).status, 'Available');
});

test('nothing happens when automation is off or no rule matches', async () => {
  const id = device('RYR_WM_7', 'Available');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYR_WM_7' };
  assert.equal((await handler(statusEvent('SD-5', 'Resolved'))).skipped, 'no-matching-rule');
  store.set('settings:asset-manager', { ...SETTINGS, statusAutomationEnabled: false });
  assert.equal((await handler(statusEvent('SD-6', 'Dispatched'))).skipped, 'automation-off');
  assert.equal(store.get(`asset:${id}`).status, 'Available');
});

test('saving configuration keeps the rules and the on/off switch', async () => {
  await main.saveSettings({ payload: { settings: { ...SETTINGS, statusRules: [{ projects: 'SD, HW', ticketStatus: 'Dispatched', deviceStatus: 'in use' }] } }, context: {} });
  const saved = store.get('settings:asset-manager');
  assert.equal(saved.statusAutomationEnabled, true);
  assert.deepEqual(saved.statusRules, [{ projects: ['SD', 'HW'], ticketStatus: 'Dispatched', deviceStatus: 'In Use' }]);
});
