import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const requests = [];
mock.module('@forge/api', {
  defaultExport: { asUser: () => ({ requestJira: async (path) => { requests.push(String(path)); return { ok: true, json: async () => ({ permissions: { ADMINISTER: { havePermission: true } } }) }; } }) },
  namedExports: { route: (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '') }
});
const { licenceState, requireActiveLicence, licensedResolver, LICENCE_INACTIVE_CODE, LICENCE_INACTIVE_MESSAGE } = await import('../src/licence.js');
const { guardResolver } = await import('../src/auth.js');
const ui = await import('../shared/licence.js');

function fakeResolver() { const defs = {}; return { defs, define: (key, handler) => { defs[key] = handler; } }; }
const prod = (license) => ({ environmentType: 'PRODUCTION', ...(license === undefined ? {} : { license }) });

test('production requires an active licence (isActive or active)', () => {
  assert.equal(licenceState(prod({ isActive: true })).active, true);
  assert.equal(licenceState(prod({ active: true })).active, true);
  assert.doesNotThrow(() => requireActiveLicence(prod({ isActive: true })));
});

test('production fails closed when the licence is missing or inactive', () => {
  for (const context of [prod(undefined), prod(null), prod({}), prod({ isActive: false }), prod({ isActive: 'true' }), { environmentType: 'production' }]) {
    assert.equal(licenceState(context).enforced, true);
    assert.throws(() => requireActiveLicence(context), new RegExp(LICENCE_INACTIVE_CODE));
  }
});

test('non-production environments are never blocked', () => {
  for (const environmentType of ['DEVELOPMENT', 'STAGING', '', undefined]) {
    const context = { environmentType, license: { isActive: false } };
    assert.equal(licenceState(context).enforced, false);
    assert.doesNotThrow(() => requireActiveLicence(context));
  }
  assert.doesNotThrow(() => requireActiveLicence(undefined));
});

test('licensedResolver blocks every resolver in unlicensed production and passes otherwise', async () => {
  const resolver = licensedResolver(fakeResolver());
  resolver.define('getPortalAssets', async ({ payload }) => `ok:${payload.n}`);
  await assert.rejects(resolver.defs.getPortalAssets({ payload: { n: 1 }, context: prod({ isActive: false }) }), new RegExp(LICENCE_INACTIVE_CODE));
  assert.equal(await resolver.defs.getPortalAssets({ payload: { n: 2 }, context: prod({ isActive: true }) }), 'ok:2');
  assert.equal(await resolver.defs.getPortalAssets({ payload: { n: 3 }, context: { environmentType: 'DEVELOPMENT' } }), 'ok:3');
});

test('licence check runs before the admin permission call, so unlicensed calls cost no Jira request', async () => {
  const resolver = guardResolver(licensedResolver(fakeResolver()), new Set(['saveSettings']));
  resolver.define('saveSettings', async () => 'saved');
  requests.length = 0;
  await assert.rejects(resolver.defs.saveSettings({ payload: {}, context: prod(undefined) }), new RegExp(LICENCE_INACTIVE_CODE));
  assert.equal(requests.length, 0);
  assert.equal(await resolver.defs.saveSettings({ payload: {}, context: prod({ isActive: true }) }), 'saved');
  assert.equal(requests.length, 1);
});

test('Marketplace resolvers are all licence-wrapped', () => {
  for (const file of ['index.js', 'ticket-sync.js', 'issue-panel.js', 'device-split.js', 'portal-assets.js']) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.match(source, /licensedResolver\(new Resolver\(\)\)/, `${file} must use licensedResolver`);
  }
  assert.match(fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8'), /licensing:\s*\r?\n\s+enabled:\s*true/);
});

test('UI helper recognises the Forge-wrapped licence error and shows the friendly message', async () => {
  let thrown;
  try { requireActiveLicence(prod(undefined)); } catch (error) { thrown = error; }
  const bridged = new Error(`There was an error invoking the function - ${thrown.message}`);
  assert.equal(ui.LICENCE_INACTIVE_CODE, LICENCE_INACTIVE_CODE);
  assert.equal(ui.LICENCE_INACTIVE_MESSAGE, LICENCE_INACTIVE_MESSAGE);
  assert.equal(ui.isLicenceInactive(bridged), true);
  assert.equal(ui.errorMessage(bridged, 'fallback'), LICENCE_INACTIVE_MESSAGE);
  assert.equal(ui.isLicenceInactive(new Error('Only Jira administrators can perform this action.')), false);
  assert.equal(ui.errorMessage(new Error('boom'), 'fallback'), 'boom');
  assert.equal(ui.errorMessage(null, 'fallback'), 'fallback');
});
