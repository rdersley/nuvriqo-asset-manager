import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkDeviceId, compileDeviceIdPatterns } from '../src/device-id-rule.js';

// Bad data in the Jira Device ID field: the format rule, preview scan, clean-up list and fixes.
const store = new Map();
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query }, WhereConditions: { beginsWith: (p) => p } } });

let tickets = [];
const puts = [];
const json = (b, ok = true, status = 200) => ({ ok, status, json: async () => b });
const requestJira = async (u, init) => {
  const url = String(u?.value ?? u);
  if (url.includes('mypermissions')) return json({ permissions: { ADMINISTER: { havePermission: true } } });
  if (url.endsWith('/rest/api/3/field')) return json([{ id: 'customfield_100', name: 'Device ID', schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } }]);
  if (url.includes('/search/jql')) {
    const { jql } = JSON.parse(init.body);
    const phrase = /~ "\\"(.*)\\""/.exec(jql)?.[1];
    const list = phrase !== undefined ? tickets.filter((t) => String(t.fields.customfield_100 || '').toLowerCase().includes(phrase.toLowerCase())) : tickets.filter((t) => t.fields.customfield_100);
    return json({ issues: list.map((t) => ({ key: t.key, fields: { ...t.fields } })) });
  }
  const put = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url);
  if (put && init?.method === 'PUT') {
    const ticket = tickets.find((t) => t.key === put[1]);
    if (ticket.locked) return json({ errorMessages: ['No permission'] }, false, 403);
    puts.push({ key: put[1], fields: JSON.parse(init.body).fields });
    Object.assign(ticket.fields, JSON.parse(init.body).fields);
    return json({});
  }
  return json({});
};
mock.module('@forge/api', { defaultExport: { asUser: () => ({ requestJira }), asApp: () => ({ requestJira }) }, namedExports: { route: (s, ...v) => ({ value: s.reduce((o, x, i) => o + x + (v[i] ?? ''), '') }) } });
const resolvers = [];
mock.module('@forge/resolver', { defaultExport: class { constructor() { this.defs = {}; resolvers.push(this); } define(k, f) { this.defs[k] = f; } getDefinitions() { return this.defs; } } });
await import('../src/index.js');
const main = resolvers.at(-1).defs;
const call = (name, payload = {}) => main[name]({ payload, context: { accountId: 'acc-1' } });
const nameKey = (n) => `asset-name:${Buffer.from(n.toLowerCase()).toString('base64url')}`;
const devices = () => [...store.entries()].filter(([k]) => k.startsWith('asset:')).map(([, v]) => v);
const ticket = (key, value) => ({ key, fields: { customfield_100: value, summary: key, created: '2026-10-01T00:00:00Z' } });

beforeEach(() => {
  store.clear(); puts.length = 0;
  store.set('settings:asset-manager', { jiraAssetField: { id: 'customfield_100', name: 'Device ID' }, jiraProjectKey: 'OPS', deviceIdPatterns: ['DEV####'] });
  store.set('asset:A1', { id: 'A1', name: 'DEV1234', jiraIdentifier: 'DEV1234', serialNumber: 'R58M21ABC' });
  store.set(nameKey('DEV1234'), { assetId: 'A1', name: 'DEV1234' });
  tickets = [ticket('OPS-1', 'DEV1234'), ticket('OPS-2', 'R58M21ABC'), ticket('OPS-3', 'R58M21ABC'), ticket('OPS-4', 'DEV9999'), ticket('OPS-5', 'screen broken'), ticket('OPS-6', '35123456789'), ticket('OPS-7', 'DEV1234 cracked')];
});

test('format patterns: # digit, @ letter, ? one, * any; whole value, any case', () => {
  const rule = compileDeviceIdPatterns(['DEV####', 'VPOS-*', '@@?##']);
  assert.equal(checkDeviceId('dev1234', rule).ok, true);
  assert.equal(checkDeviceId('VPOS-anything', rule).ok, true);
  assert.equal(checkDeviceId('AB-12', rule).ok, true);
  assert.equal(checkDeviceId('DEV12345', rule).reason, "Doesn't match the Device ID format");
  assert.equal(checkDeviceId('35123456789', rule).reason, 'Numbers only (often a serial number)');
  assert.equal(checkDeviceId('N/A', rule).reason, 'Placeholder, not a device');
  assert.equal(checkDeviceId('  ', rule), null);
  assert.equal(checkDeviceId('anything4', []).ok, true, 'no patterns: basic checks only');
  assert.equal(checkDeviceId('DEV.123', compileDeviceIdPatterns(['DEV.###'])).ok, true, 'other characters are literal');
  assert.equal(checkDeviceId('DEVX123', compileDeviceIdPatterns(['DEV.###'])).ok, false);
});

test('preview reports what a scan would do and changes no devices', async () => {
  const r = await call('previewJiraScan');
  assert.deepEqual(r.found, [{ identifier: 'DEV1234', registered: true, type: '' }, { identifier: 'DEV9999', registered: false, type: '' }]);
  assert.deepEqual(r.rejected.map((x) => [x.value, x.tickets]).sort(), [['35123456789', 1], ['DEV1234 cracked', 1], ['R58M21ABC', 2], ['screen broken', 1]]);
  assert.equal(devices().length, 1, 'no device created');
});

test('the real scan creates only values that match the format', async () => {
  await call('syncAssetsFromJira', { restart: true });
  assert.deepEqual(devices().map((d) => d.jiraIdentifier || d.name).sort(), ['DEV1234', 'DEV9999']);
});

test('the clean-up list suggests the device for serials and embedded IDs', async () => {
  await call('previewJiraScan');
  const { values } = await call('getDeviceIdReview');
  const byValue = Object.fromEntries(values.map((v) => [v.value, v]));
  assert.equal(values[0].value, 'R58M21ABC', 'most tickets first');
  assert.equal(byValue.R58M21ABC.ticketCount, 2);
  assert.deepEqual([byValue.R58M21ABC.suggestion.deviceId, byValue.R58M21ABC.suggestion.matchedBy], ['DEV1234', 'serial number']);
  assert.equal(byValue['DEV1234 cracked'].suggestion.matchedBy, 'Device ID inside the value');
  assert.equal(byValue['screen broken'].suggestion, null);
});

test('a rescan counts tickets afresh instead of adding to the last run', async () => {
  await call('previewJiraScan');
  await call('previewJiraScan');
  const { values } = await call('getDeviceIdReview');
  assert.equal(values.find((v) => v.value === 'R58M21ABC').ticketCount, 2);
});

test('fix writes the right Device ID into every ticket with the bad value', async () => {
  await call('previewJiraScan');
  const r = await call('resolveDeviceIdValue', { value: 'R58M21ABC', action: 'fix', deviceId: 'DEV1234' });
  assert.deepEqual(r.updated.sort(), ['OPS-2', 'OPS-3']);
  assert.equal(r.done, true);
  assert.deepEqual(tickets.filter((t) => ['OPS-2', 'OPS-3'].includes(t.key)).map((t) => t.fields.customfield_100), ['DEV1234', 'DEV1234']);
  assert.equal(tickets.find((t) => t.key === 'OPS-1').fields.customfield_100, 'DEV1234', 'other tickets untouched');
  assert.equal((await call('getDeviceIdReview')).values.some((v) => v.value === 'R58M21ABC'), false);
  const h = [...store.entries()].find(([k]) => k.startsWith('asset-history:A1:'))[1];
  assert.match(h.message, /Device ID set to DEV1234 on OPS-\d, OPS-\d \(was “R58M21ABC”\)/);
});

test('fix refuses a device that is not registered or breaks the format', async () => {
  await call('previewJiraScan');
  await assert.rejects(call('resolveDeviceIdValue', { value: 'R58M21ABC', action: 'fix', deviceId: 'NOPE1' }), /not a device in Asset Manager/);
  assert.equal(puts.length, 0);
});

test('clear empties the field; ignore hides the value; failures keep it open', async () => {
  await call('previewJiraScan');
  const cleared = await call('resolveDeviceIdValue', { value: 'screen broken', action: 'clear' });
  assert.deepEqual([cleared.updated, cleared.done], [['OPS-5'], true]);
  assert.equal(tickets.find((t) => t.key === 'OPS-5').fields.customfield_100, null);
  await call('resolveDeviceIdValue', { value: '35123456789', action: 'ignore' });
  const list = await call('getDeviceIdReview');
  assert.equal(list.ignored, 1);
  assert.equal(list.values.some((v) => v.value === '35123456789'), false);
  tickets.find((t) => t.key === 'OPS-7').locked = true;
  const failed = await call('resolveDeviceIdValue', { value: 'DEV1234 cracked', action: 'fix', deviceId: 'DEV1234' });
  assert.deepEqual([failed.updated.length, failed.failed[0].key, failed.done], [0, 'OPS-7', false]);
  assert.equal((await call('getDeviceIdReview')).values.some((v) => v.value === 'DEV1234 cracked'), true);
});

test('a value Jira search cannot find stays on the list with its tickets', async () => {
  await call('previewJiraScan');
  tickets.find((t) => t.key === 'OPS-5').fields.customfield_100 = 'renamed meanwhile';
  const r = await call('resolveDeviceIdValue', { value: 'screen broken', action: 'clear' });
  assert.deepEqual([r.notFound, r.done, r.issueKeys], [true, false, ['OPS-5']]);
  assert.equal((await call('getDeviceIdReview')).values.some((v) => v.value === 'screen broken'), true);
});

test('a format can belong to a device type', () => {
  const rule = compileDeviceIdPatterns(['Tablet: TAB####', 'vpos: VPOS-*', 'DEV####', 'Not a type: X##'], ['Tablet', 'vPOS']);
  assert.deepEqual(rule.map((r) => [r.type, r.pattern]), [['Tablet', 'TAB####'], ['vPOS', 'VPOS-*'], [null, 'DEV####'], [null, 'Not a type: X##']]);
  assert.deepEqual(checkDeviceId('tab0001', rule), { ok: true, type: 'Tablet' });
  assert.deepEqual(checkDeviceId('VPOS-12', rule), { ok: true, type: 'vPOS' });
  assert.deepEqual(checkDeviceId('DEV0001', rule), { ok: true, type: null });
  assert.equal(checkDeviceId('ABC9999', rule, 'tablet').reason, "Doesn't match the Tablet format (TAB####)");
  assert.equal(checkDeviceId('ABC9999', rule, 'Phone').reason, "Doesn't match the Device ID format");
  assert.equal(checkDeviceId('VPOS-12', rule, 'Tablet').ok, true, 'another type\'s format still counts as a Device ID');
});

test('the scan gives a new device the type its Device ID matched', async () => {
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), assetTypes: ['Tablet', 'vPOS'], deviceIdPatterns: ['Tablet: TAB####', 'vPOS: VPOS-*'] });
  tickets = [ticket('OPS-10', 'TAB0001'), ticket('OPS-11', 'VPOS-77'), ticket('OPS-12', 'DEV5555')];
  const preview = await call('previewJiraScan');
  assert.deepEqual(preview.found.map((f) => [f.identifier, f.type]), [['TAB0001', 'Tablet'], ['VPOS-77', 'vPOS']]);
  await call('syncAssetsFromJira', { restart: true });
  const types = Object.fromEntries(devices().map((d) => [d.jiraIdentifier || d.name, d.type]));
  assert.deepEqual([types.TAB0001, types['VPOS-77'], types.DEV5555], ['Tablet', 'vPOS', undefined]);
});

test('fix checks the chosen device against its own type format', async () => {
  await call('previewJiraScan');
  store.set('settings:asset-manager', { ...store.get('settings:asset-manager'), assetTypes: ['Tablet'], deviceIdPatterns: ['Tablet: TAB####'] });
  store.set('asset:A1', { ...store.get('asset:A1'), type: 'Tablet' });
  await assert.rejects(call('resolveDeviceIdValue', { value: 'R58M21ABC', action: 'fix', deviceId: 'DEV1234' }), /DEV1234 does not pass the Device ID format rule \(Doesn't match the Tablet format \(TAB####\)\)/);
  assert.equal(puts.length, 0);
});

test('a scanned barcode value suggests the Device ID inside it', async () => {
  store.set('asset:B1', { id: 'B1', name: 'RYRBP24481', jiraIdentifier: 'RYRBP24481' });
  tickets = [ticket('OPS-20', 'BP50=RYRBP24481^68:AA:D2:17:F5:97')];
  await call('previewJiraScan');
  const { values } = await call('getDeviceIdReview');
  assert.deepEqual([values[0].value, values[0].suggestion.deviceId, values[0].suggestion.matchedBy], ['BP50=RYRBP24481^68:AA:D2:17:F5:97', 'RYRBP24481', 'Device ID inside the value']);
});
