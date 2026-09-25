import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let permissionResponse = { ok: true, body: { permissions: { ADMINISTER: { havePermission: false } } } };
const requests = [];
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira: async (path) => { requests.push(String(path)); return { ok: permissionResponse.ok, json: async () => permissionResponse.body }; } }) },
  namedExports: { route: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '') }
});
const { guardResolver, isJiraAdmin } = await import('../src/auth.js');

const asAdmin = (isAdmin) => { permissionResponse = { ok: true, body: { permissions: { ADMINISTER: { havePermission: isAdmin } } } }; };
function fakeResolver() { const defs = {}; return { defs, define: (key, handler) => { defs[key] = handler; } }; }

test('admin check asks Jira for the caller\'s ADMINISTER permission', async () => {
  requests.length = 0; asAdmin(true);
  assert.equal(await isJiraAdmin(), true);
  assert.match(requests[0], /\/rest\/api\/3\/mypermissions\?permissions=ADMINISTER/);
});

test('failed or malformed permission responses are treated as not admin', async () => {
  permissionResponse = { ok: false, body: {} };
  assert.equal(await isJiraAdmin(), false);
  permissionResponse = { ok: true, body: {} };
  assert.equal(await isJiraAdmin(), false);
});

test('listed resolvers reject non-admins without running the handler', async () => {
  const resolver = guardResolver(fakeResolver(), new Set(['saveSettings']));
  let ran = false;
  resolver.define('saveSettings', async () => { ran = true; return 'saved'; });
  asAdmin(false);
  await assert.rejects(resolver.defs.saveSettings({ payload: {} }), /Only Jira administrators/);
  assert.equal(ran, false);
  asAdmin(true);
  assert.equal(await resolver.defs.saveSettings({ payload: {} }), 'saved');
});

test('unlisted resolvers stay open and skip the permission call', async () => {
  const resolver = guardResolver(fakeResolver(), new Set(['saveSettings']));
  resolver.define('listAssets', async () => 'assets');
  requests.length = 0; asAdmin(false);
  assert.equal(await resolver.defs.listAssets({}), 'assets');
  assert.equal(requests.length, 0);
});

test('"all" guards every resolver', async () => {
  const resolver = guardResolver(fakeResolver(), 'all');
  resolver.define('getCrewReport', async () => 'report');
  asAdmin(false);
  await assert.rejects(resolver.defs.getCrewReport({}), /Only Jira administrators/);
});

test('backends register the expected admin guards', () => {
  const backend = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const crew = fs.readFileSync(new URL('../src/crew.js', import.meta.url), 'utf8');
  for (const key of ['saveSettings', 'syncAssetsFromJira', 'bulkImportAssets', 'previewAssetImportReconciliation', 'reconcileAssetImport', 'bulkRemoveAssets', 'publishPortalPlusSnapshot']) assert.match(backend, new RegExp(`ADMIN_RESOLVERS = new Set\\(\\[[^\\]]*'${key}'`));
  assert.match(backend, /guardResolver\(new Resolver\(\), ADMIN_RESOLVERS\)/);
  assert.match(crew, /guardResolver\(new Resolver\(\), 'all'\)/);
});
