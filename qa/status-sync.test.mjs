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
let editMeta = {};
const jiraUpdates = [];
const requestJira = async (path, options = {}) => {
  const url = String(path); jiraCalls.push(url);
  if (url.startsWith('/rest/api/3/mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.endsWith('/editmeta')) return json({ fields: editMeta });
  if (options.method === 'PUT') { jiraUpdates.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 204, json: async () => ({}) }; }
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

beforeEach(() => { store.clear(); jiraCalls.length = 0; jiraUpdates.length = 0; editMeta = {}; kvsOps = 0; store.set('settings:asset-manager', structuredClone(SETTINGS)); });

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

// HW-51409: vPos Device ID - Existing RYRS408034, Replacement RYRS506641, Crew MORGPI, RYR, PFO.
const HW = {
  ...SETTINGS,
  jiraCrewCodeField: { id: 'customfield_300' }, jiraClientField: { id: 'customfield_301' }, jiraLocationField: { id: 'customfield_302' }, jiraTypeField: { id: 'customfield_303' },
  crewMappings: [{ crewCode: 'MORGPI', accountId: '', displayName: 'Pia Morgan' }],
  statusRules: [{ projects: ['HW'], ticketStatus: 'Waiting Device Return', deviceStatus: 'Repair' }],
  replacement: { enabled: true, projects: ['HW'], ticketStatus: 'Dispatched', deviceStatus: 'In Use', pairs: [{ existingField: { id: 'customfield_201', name: 'vPos Device ID - Existing' }, replacementField: { id: 'customfield_202', name: 'vPos Device ID - Replacement' } }] }
};
const hwFields = (extra = {}) => ({ project: { key: 'HW' }, customfield_100: null, customfield_201: 'RYRS408034', customfield_202: 'RYRS506641', customfield_300: 'MORGPI', customfield_301: { value: 'RYR - Ryanair' }, customfield_302: { value: 'PFO' }, customfield_303: { value: 'Samsung A03' }, ...extra });

test('HW status rules find the device in the "existing" field when Device ID is empty', async () => {
  store.set('settings:asset-manager', structuredClone(HW));
  const oldId = device('RYRS408034', 'In Use');
  issueFields = hwFields();
  await handler(statusEvent('HW-51409', 'Waiting Device Return'));
  assert.equal(store.get(`asset:${oldId}`).status, 'Repair');
});

test('a replacement takes over the old device holder, client and location', async () => {
  store.set('settings:asset-manager', structuredClone(HW));
  const oldId = device('RYRS408034', 'Repair');
  // The old device's details differ from the ticket's, and win.
  store.set(`asset:${oldId}`, { ...store.get(`asset:${oldId}`), crewCode: 'HOLDER', assigneeName: 'Old Holder', client: 'RYS - Malta Air', location: 'STN' });
  const newId = device('RYRS506641', 'Available');
  issueFields = hwFields();
  const result = await handler(statusEvent('HW-51409', 'Dispatched'));
  const replacement = store.get(`asset:${newId}`);
  assert.deepEqual([replacement.status, replacement.crewCode, replacement.assigneeName, replacement.client, replacement.location], ['In Use', 'HOLDER', 'Old Holder', 'RYS - Malta Air', 'STN']);
  assert.match(history(newId).at(-1).message, /replacement for RYRS408034 on HW-51409/);
  assert.equal(store.get(`asset:${oldId}`).status, 'Repair', 'the old device is left alone');
  assert.match(history(oldId).at(-1).message, /Replaced by RYRS506641 on HW-51409/);
  assert.deepEqual(result.replacements, [{ replaced: 'RYRS408034', by: newId, created: false }]);
});

test('an unregistered replacement device is created with the discovery id scheme', async () => {
  store.set('settings:asset-manager', structuredClone(HW));
  const oldId = device('RYRS408034', 'Repair');
  store.set(`asset:${oldId}`, { ...store.get(`asset:${oldId}`), type: 'vPOS Device Set', crewCode: 'MORGPI', assigneeName: 'Pia Morgan', client: 'RYR - Ryanair', location: 'PFO' });
  issueFields = hwFields();
  await handler(statusEvent('HW-51409', 'Dispatched'));
  const newId = jiraAssetId('customfield_100', 'RYRS506641');
  const created = store.get(`asset:${newId}`);
  assert.equal(created.name, 'RYRS506641');
  assert.equal(created.type, 'vPOS Device Set');
  assert.equal(created.status, 'In Use');
  assert.equal(created.crewCode, 'MORGPI');
  assert.equal(store.get(`asset-name:${Buffer.from('ryrs506641').toString('base64url')}`).assetId, newId);
  assert.equal(log()[0].result, 'replacement-created');
});

test('without a registered old device the ticket fields supply holder, client, location and type', async () => {
  store.set('settings:asset-manager', structuredClone(HW));
  issueFields = hwFields();
  await handler(statusEvent('HW-51409', 'Dispatched'));
  const created = store.get(`asset:${jiraAssetId('customfield_100', 'RYRS506641')}`);
  assert.deepEqual([created.crewCode, created.assigneeName, created.client, created.location, created.type], ['MORGPI', 'Pia Morgan', 'RYR - Ryanair', 'PFO', 'Samsung A03']);
});

test('replacements do nothing when switched off or at other statuses', async () => {
  store.set('settings:asset-manager', { ...structuredClone(HW), replacement: { ...HW.replacement, enabled: false }, statusAutomationEnabled: false });
  issueFields = hwFields();
  assert.equal((await handler(statusEvent('HW-1', 'Dispatched'))).skipped, 'automation-off');
  store.set('settings:asset-manager', structuredClone(HW));
  await handler(statusEvent('HW-1', 'Delivered'));
  assert.equal(store.get(`asset:${jiraAssetId('customfield_100', 'RYRS506641')}`), undefined);
});

test('saving configuration keeps valid replacement pairs only', async () => {
  await main.saveSettings({ payload: { settings: { ...SETTINGS, replacement: { enabled: true, projects: 'hw', ticketStatus: 'Dispatched', deviceStatus: 'in use', pairs: [HW.replacement.pairs[0], { existingField: { id: 'summary' }, replacementField: { id: 'customfield_9' } }] } } }, context: {} });
  const saved = store.get('settings:asset-manager').replacement;
  assert.deepEqual(saved, { enabled: true, projects: ['HW'], ticketStatus: 'Dispatched', deviceStatus: 'In Use', pairs: [HW.replacement.pairs[0]] });
});

// Device ID checked when a ticket is saved, so bad values reach the clean-up list before a scan.
const review = (value) => store.get(`device-id-review:${Buffer.from(value.toLowerCase()).toString('base64url')}`);
const withFormat = () => store.set('settings:asset-manager', { ...structuredClone(SETTINGS), jiraProjectKey: 'SD', assetTypes: ['Tablet'], jiraTypeField: { id: 'customfield_200' }, deviceIdPatterns: ['Tablet: TAB####'] });

test('a new ticket with a bad Device ID goes onto the clean-up list', async () => {
  withFormat();
  issueFields = { project: { key: 'SD' }, customfield_100: 'R58M21ABC', customfield_200: { value: 'Tablet' } };
  const result = await handler({ eventType: 'avi:jira:created:issue', issue: { key: 'SD-9' } });
  assert.deepEqual(result.deviceIdRejected, ['R58M21ABC']);
  const record = review('R58M21ABC');
  assert.deepEqual([record.status, record.ticketCount, record.issueKeys, record.reason], ['open', 1, ['SD-9'], "Doesn't match the Tablet format (TAB####)"]);
  await handler({ eventType: 'avi:jira:created:issue', issue: { key: 'SD-9' } });
  assert.equal(review('R58M21ABC').ticketCount, 1, 'the same ticket is not counted twice');
});

test('editing the Device ID to a bad value is caught; a good value or another project is not', async () => {
  withFormat();
  const edit = (key) => ({ eventType: 'avi:jira:updated:issue', issue: { key }, changelog: { items: [{ fieldId: 'customfield_100', toString: 'x' }] } });
  issueFields = { project: { key: 'SD' }, customfield_100: 'screen broken' };
  await handler(edit('SD-10'));
  assert.equal(review('screen broken').issueKeys[0], 'SD-10');
  issueFields = { project: { key: 'SD' }, customfield_100: 'TAB0001' };
  assert.deepEqual((await handler(edit('SD-11'))).deviceIdRejected, []);
  issueFields = { project: { key: 'OTHER' }, customfield_100: 'junk value' };
  await handler(edit('OTHER-1'));
  assert.equal(review('junk value'), undefined);
});

test('an ignored value stays ignored when another ticket uses it', async () => {
  withFormat();
  store.set(`device-id-review:${Buffer.from('r58m21abc').toString('base64url')}`, { value: 'R58M21ABC', status: 'ignored', ticketCount: 3, issueKeys: ['SD-1'] });
  issueFields = { project: { key: 'SD' }, customfield_100: 'R58M21ABC' };
  await handler({ eventType: 'avi:jira:created:issue', issue: { key: 'SD-12' } });
  assert.deepEqual([review('R58M21ABC').status, review('R58M21ABC').ticketCount], ['ignored', 4]);
});

test('edits to other fields do no Device ID work at all', async () => {
  withFormat(); kvsOps = 0;
  await handler({ eventType: 'avi:jira:updated:issue', issue: { key: 'SD-13' }, changelog: { items: [{ fieldId: 'summary', toString: 'x' }] } });
  assert.equal(kvsOps, 0);
  assert.equal(jiraCalls.length, 0);
});

// Device type filled from the register when the Device ID is a registered device.
const TYPE_OPTIONS = { customfield_200: { schema: { type: 'option' }, allowedValues: [{ id: '10', value: 'vPOS' }, { id: '11', value: 'PED' }] } };
const typed = (identifier, type) => { const id = device(identifier, 'In Use'); store.set(`asset:${id}`, { ...store.get(`asset:${id}`), type }); return id; };

test('a new ticket with a registered Device ID gets the device type from the register', async () => {
  withFormat(); editMeta = TYPE_OPTIONS;
  const id = typed('RYRS402403', 'vpos');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRS402403', customfield_200: null };
  const result = await handler({ eventType: 'avi:jira:created:issue', issue: { key: 'SD-20' } });
  assert.equal(result.deviceType, 'filled');
  assert.deepEqual(jiraUpdates, [{ url: '/rest/api/3/issue/SD-20', body: { fields: { customfield_200: { id: '10' } } } }]);
  assert.match(history(id).at(-1).message, /Device type vpos filled in on SD-20/);
});

test('changing the Device ID fills the type; a type already on the ticket is never changed', async () => {
  withFormat(); editMeta = TYPE_OPTIONS;
  typed('RYRBP12345', 'PED');
  const edit = (key) => ({ eventType: 'avi:jira:updated:issue', issue: { key }, changelog: { items: [{ fieldId: 'customfield_100', toString: 'RYRBP12345' }] } });
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRBP12345' };
  assert.equal((await handler(edit('SD-21'))).deviceType, 'filled');
  assert.deepEqual(jiraUpdates.at(-1).body, { fields: { customfield_200: { id: '11' } } });
  jiraUpdates.length = 0;
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRBP12345', customfield_200: { value: 'vPOS' } };
  assert.equal((await handler(edit('SD-22'))).deviceType, undefined);
  assert.equal(jiraUpdates.length, 0);
});

test('the type is left alone when it is not an option, the device is unknown, or the setting is off', async () => {
  withFormat(); editMeta = TYPE_OPTIONS;
  const created = (key) => handler({ eventType: 'avi:jira:created:issue', issue: { key } });
  typed('RYRDPP123', 'Printer');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRDPP123' };
  assert.equal((await created('SD-23')).deviceType, 'type-not-an-option');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRS999999' };
  assert.equal((await created('SD-24')).deviceType, 'device-not-in-register');
  typed('RYRG000001', 'Other');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRG000001' };
  assert.equal((await created('SD-25')).deviceType, 'no-type-in-register');
  typed('RYRS402403', 'vPOS');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRS402403' };
  editMeta = {};
  assert.equal((await created('SD-26')).deviceType, 'type-field-not-on-screen');
  editMeta = TYPE_OPTIONS;
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), fillTicketTypeFromRegister: false });
  assert.equal((await created('SD-27')).deviceType, undefined);
  assert.equal(jiraUpdates.length, 0);
});

test('a text Device type field gets the register spelling', async () => {
  withFormat(); editMeta = { customfield_200: { schema: { type: 'string' } } };
  typed('RYRS402403', 'vPOS');
  issueFields = { project: { key: 'SD' }, customfield_100: 'RYRS402403' };
  await handler({ eventType: 'avi:jira:created:issue', issue: { key: 'SD-28' } });
  assert.deepEqual(jiraUpdates.at(-1).body, { fields: { customfield_200: 'vPOS' } });
});

test('the fill setting is saved, on unless turned off', async () => {
  await main.saveSettings({ payload: { settings: { ...SETTINGS } }, context: {} });
  assert.equal(store.get('settings:asset-manager').fillTicketTypeFromRegister, true);
  await main.saveSettings({ payload: { settings: { ...SETTINGS, fillTicketTypeFromRegister: false } }, context: {} });
  assert.equal(store.get('settings:asset-manager').fillTicketTypeFromRegister, false);
});
