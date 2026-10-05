import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// SOTI MobiControl read-only sync against a fake SOTI server.
const store = new Map(), secrets = new Map();
function query() {
  const st = { prefix: '', limit: 100, cursor: null };
  const b = { where: (_f, p) => { st.prefix = p; return b; }, limit: (n) => { st.limit = n; return b; }, cursor: (c) => { st.cursor = c; return b; },
    getMany: async () => { const keys = [...store.keys()].filter((k) => k.startsWith(st.prefix)).sort(); const s = st.cursor ? Number(st.cursor) : 0; return { results: keys.slice(s, s + st.limit).map((key) => ({ key, value: store.get(key) })), nextCursor: s + st.limit < keys.length ? String(s + st.limit) : undefined }; } };
  return b;
}
mock.module('@forge/kvs', { namedExports: { kvs: {
  get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); }, query,
  getSecret: async (k) => secrets.get(k), setSecret: async (k, v) => { secrets.set(k, v); }, deleteSecret: async (k) => { secrets.delete(k); },
}, WhereConditions: { beginsWith: (p) => p } } });

// Fake SOTI: token endpoint, paged device list, installed apps.
let sotiDevices = [], tokenCalls = 0, expireNext = false;
const calls = [];
const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
const fetchMock = async (url, init = {}) => {
  calls.push({ url, init });
  const u = new URL(url);
  if (u.pathname === '/MobiControl/api/token') {
    tokenCalls += 1;
    const auth = Buffer.from(String(init.headers.Authorization).replace('Basic ', ''), 'base64').toString();
    const form = new URLSearchParams(init.body);
    if (auth !== 'client-1:secret-1' || form.get('password') !== 'pw') return res(401, {});
    return res(200, { access_token: `tok-${tokenCalls}`, expires_in: 3600, token_type: 'bearer' });
  }
  if (expireNext) { expireNext = false; return res(401, {}); }
  if (!String(init.headers?.Authorization).startsWith('Bearer tok-')) return res(401, {});
  const apps = /^\/MobiControl\/api\/devices\/([^/]+)\/installedApplications$/.exec(u.pathname);
  if (apps) return res(200, decodeURIComponent(apps[1]) === 'S-1' ? [{ ApplicationId: 'com.pos.app', Version: '4.2.1' }, { ApplicationId: 'com.other', Version: '1' }] : []);
  if (u.pathname === '/MobiControl/api/devices') {
    const skip = Number(u.searchParams.get('skip')), take = Number(u.searchParams.get('take'));
    return res(200, sotiDevices.slice(skip, skip + take));
  }
  return res(404, {});
};
mock.module('@forge/api', { defaultExport: { fetch: fetchMock } });
const soti = await import('../src/soti.js');

const nameKey = (n) => `asset-name:${Buffer.from(n.toLowerCase()).toString('base64url')}`;
const asset = (id) => store.get(`asset:${id}`);
const history = (id) => [...store.entries()].filter(([k]) => k.startsWith(`asset-history:${id}:`)).map(([, v]) => v);
const sotiDevice = (o) => ({ DeviceId: o.id, DeviceName: o.name, HardwareSerialNumber: o.serial, Model: o.model, Manufacturer: o.make, Platform: 'Android', OSVersion: o.os || '13', IsAgentOnline: o.online ?? true, LastCheckInTime: o.seen || '2026-10-04T10:00:00Z', Path: '\\\\Fleet\\DUB' });

beforeEach(async () => {
  store.clear(); secrets.clear(); calls.length = 0; tokenCalls = 0; expireNext = false;
  await soti.saveSotiSettings({ host: 'a123456.mobicontrol.cloud/MobiControl/WebConsole', clientId: 'client-1', clientSecret: 'secret-1', username: 'api-user', password: 'pw', trackedApps: ['POS = com.pos.app'] });
  store.set('asset:A1', { id: 'A1', name: 'DEV1234', jiraIdentifier: 'DEV1234', serialNumber: '', model: 'Old model', type: 'Tablet' });
  store.set(nameKey('DEV1234'), { assetId: 'A1' });
  store.set('asset:A2', { id: 'A2', name: 'DEV5555', jiraIdentifier: 'DEV5555', serialNumber: 'R58SERIAL2' });
  store.set('asset:A3', { id: 'A3', name: 'DEV7777', jiraIdentifier: 'DEV7777' });
  sotiDevices = [
    sotiDevice({ id: 'S-1', name: 'DEV1234', serial: 'R58SERIAL1', model: 'Galaxy Tab A8', make: 'Samsung' }),
    sotiDevice({ id: 'S-2', name: 'NAME-IN-SOTI', serial: 'R58SERIAL2', model: 'TC52', make: 'Zebra', seen: '2026-07-01T00:00:00Z', online: false }),
    sotiDevice({ id: 'S-3', name: 'DEV9999', serial: 'R58SERIAL3', model: 'TC52', make: 'Zebra' }),
  ];
});

test('settings: address normalised, SOTI-hosted only, secrets kept out of the settings', async () => {
  const s = await soti.sotiSettings();
  assert.equal(s.host, 'https://a123456.mobicontrol.cloud');
  assert.deepEqual([s.clientId, s.username, s.hasSecret, s.hasPassword], ['client-1', 'api-user', true, true]);
  assert.equal(JSON.stringify(s).includes('secret-1'), false);
  assert.equal(JSON.stringify([...store.values()]).includes('secret-1'), false, 'secret only in secret storage');
  await assert.rejects(soti.saveSotiSettings({ host: 'https://evil.example.com' }), /SOTI-hosted address/);
  await soti.saveSotiSettings({ host: 'https://x1.mobicontrolcloud.com', clientId: 'client-1', clientSecret: '', username: 'api-user', password: '' });
  assert.equal((await soti.sotiSettings()).hasSecret, true, 'blank secret keeps the saved one');
});

test('test connection signs in and reports which SOTI fields were found', async () => {
  const r = await soti.testConnection();
  assert.equal(r.fieldsFound.serial, 'HardwareSerialNumber');
  assert.equal(r.sampleDevice.os, 'Android 13');
  const tokenCall = calls.find((c) => c.url.endsWith('/MobiControl/api/token'));
  assert.equal(new URLSearchParams(tokenCall.init.body).get('grant_type'), 'password');
  await soti.saveSotiSettings({ host: 'a123456.mobicontrol.cloud', clientId: 'client-1', clientSecret: 'wrong', username: 'api-user', password: 'pw' });
  await assert.rejects(soti.testConnection(), /SOTI sign-in failed \(401\)/);
});

test('a sync matches by name and serial, fills empty fields, flags differences, tracks apps', async () => {
  const r = await soti.syncStep({ restart: true });
  assert.equal(r.complete, true);
  assert.deepEqual([r.seen, r.matched, r.unmatched], [3, 2, 1]);
  // A1 matched by Device ID: empty serial filled; its model differs, so it is not overwritten.
  assert.deepEqual([asset('A1').serialNumber, asset('A1').model], ['R58SERIAL1', 'Old model']);
  assert.equal(asset('A1').manufacturer, 'Samsung');
  assert.deepEqual(asset('A1').soti.apps, { POS: '4.2.1' });
  assert.equal(asset('A1').soti.os, 'Android 13');
  assert.match(history('A1')[0].message, /Filled from SOTI: serial number, manufacturer/);
  // A2 matched by serial although SOTI names it differently.
  assert.equal(asset('A2').soti.deviceId, 'S-2');
  assert.equal(asset('A2').soti.online, false);
  const report = await soti.sotiReport();
  assert.deepEqual(report.differences.map((d) => [d.assetId, d.differences.map((x) => [x.field, x.register, x.soti])]), [['A1', [['model', 'Old model', 'Galaxy Tab A8']]]]);
  assert.deepEqual(report.sotiOnly.map((d) => d.name), ['DEV9999']);
  assert.deepEqual(report.registerOnly.map((d) => d.name), ['DEV7777']);
  assert.deepEqual(report.stale.map((d) => d.name), ['DEV5555'], 'not seen for 30+ days');
});

test('the second sync links by SOTI device id and keeps decisions', async () => {
  await soti.syncStep({ restart: true });
  await soti.resolveDifference('A1', 'keep');
  store.set('asset:A1', { ...asset('A1'), name: 'RENAMED' });
  const r = await soti.syncStep({ restart: true });
  assert.equal(r.matched, 2, 'still matched after a rename, by the stored SOTI id');
  assert.equal((await soti.sotiReport()).differences.length, 0, 'a kept difference stays quiet');
  sotiDevices[0].Model = 'Galaxy Tab A9';
  await soti.syncStep({ restart: true });
  assert.equal((await soti.sotiReport()).differences.length, 1, 'a new SOTI value raises it again');
  await soti.resolveDifference('A1', 'soti');
  assert.equal(asset('A1').model, 'Galaxy Tab A9');
});

test('a device only in SOTI can be added; a device that left SOTI drops off its list', async () => {
  await soti.syncStep({ restart: true });
  const added = await soti.addSotiDevice('S-3', 'Scanner');
  assert.deepEqual([added.name, added.serialNumber, added.type, added.soti.deviceId], ['DEV9999', 'R58SERIAL3', 'Scanner', 'S-3']);
  assert.equal(store.get(nameKey('DEV9999')).assetId, added.id);
  assert.equal((await soti.sotiReport()).sotiOnly.length, 0);
  sotiDevices.push(sotiDevice({ id: 'S-4', name: 'GONE-SOON', serial: 'X' }));
  await soti.syncStep({ restart: true });
  assert.equal((await soti.sotiReport()).sotiOnly.length, 1);
  sotiDevices.pop();
  await soti.syncStep({ restart: true });
  assert.equal((await soti.sotiReport()).sotiOnly.length, 0);
});

test('a long sync resumes page by page; an expired token is renewed once', async () => {
  sotiDevices = Array.from({ length: 250 }, (_, i) => sotiDevice({ id: `P-${i}`, name: `PX${i}`, serial: `SER${i}` }));
  let r = await soti.syncStep({ restart: true, timeBudgetMs: 0 });
  assert.deepEqual([r.complete, r.skip], [false, 100]);
  expireNext = true;
  r = await soti.syncStep({ timeBudgetMs: 0 });
  assert.deepEqual([r.complete, r.skip], [false, 200]);
  r = await soti.syncStep({ timeBudgetMs: 60000 });
  assert.deepEqual([r.complete, r.seen, r.unmatched], [true, 250, 250]);
  assert.equal(tokenCalls, 2, 'one sign-in, one renewal');
});

test('the hourly job starts a sync, continues one in progress, and skips when recent', async () => {
  assert.equal((await soti.scheduled()).complete, true);
  assert.equal((await soti.scheduled()).skipped, 'recent');
  await soti.saveSotiSettings({ host: '', clientId: 'client-1', autoSync: false });
  assert.equal((await soti.scheduled()).skipped, 'not-configured');
});
