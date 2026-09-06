import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const backend = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../static/src/main.jsx', import.meta.url), 'utf8');
const manifest = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const mainVite = fs.readFileSync(new URL('../static/vite.config.js', import.meta.url), 'utf8');
const fieldVite = fs.readFileSync(new URL('../field-static/vite.config.js', import.meta.url), 'utf8');

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const normaliseName = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
function fieldValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate ? [String(candidate).trim()] : [];
  }
  return [];
}
function discoverUniqueAssetNames(values) {
  const names = new Map();
  for (const value of values) for (const name of fieldValues(value)) { const key = normaliseName(name); if (key && !names.has(key)) names.set(key, name); }
  return [...names.values()];
}

test('Jira field values support text, select, object and multi-value shapes', () => {
  assert.deepEqual(fieldValues(' TEST DEVICE 001 '), ['TEST DEVICE 001']);
  assert.deepEqual(fieldValues({ value: 'TEST DEVICE 002' }), ['TEST DEVICE 002']);
  assert.deepEqual(fieldValues({ name: 'TEST DEVICE 003' }), ['TEST DEVICE 003']);
  assert.deepEqual(fieldValues([{ value: 'A' }, { name: 'B' }, ' C ']), ['A', 'B', 'C']);
  assert.deepEqual(fieldValues(null), []);
  assert.deepEqual(fieldValues({ unexpected: 'ignored' }), []);
});

test('device-name matching is case-insensitive and whitespace-normalised', () => {
  assert.equal(normaliseName('  TEST   DEVICE 001 '), 'test device 001');
  assert.equal(normaliseName('Test Device 001'), normaliseName('test   device 001'));
});

test('Jira discovery simulation de-duplicates equivalent device names', () => {
  const discovered = discoverUniqueAssetNames(['TEST DEVICE 001',' test   device 001 ',{ value: 'TEST DEVICE 002' },[{ name: 'TEST DEVICE 003' }, { value: 'TEST DEVICE 002' }]]);
  assert.equal(discovered.length, 3);
});

test('randomised name simulation never creates duplicate normalised names', () => {
  const raw = []; for (let i = 0; i < 1000; i += 1) { const id = i % 125; raw.push(i % 2 ? ` Device   ${id} ` : { value: `DEVICE ${id}` }); }
  const discovered = discoverUniqueAssetNames(raw);
  assert.equal(discovered.length, 125);
  assert.equal(new Set(discovered.map(normaliseName)).size, 125);
});

test('backend retains critical Jira-sync and safety contracts', () => {
  assert.match(backend, /jiraAssetField:\s*null/);
  assert.match(backend, /resolveJiraAssetField/);
  assert.match(backend, /device id/i);
  assert.match(backend, /nextPageToken/);
  assert.match(backend, /syncAssetsFromJira/);
  assert.match(backend, /fieldValues\(issue\.fields\?\.\[field\.id\]\)/);
  assert.match(backend, /Could not verify whether this device is linked to Jira tickets/);
  assert.match(backend, /Clear the configured Jira asset field or unlink those tickets/);
  assert.doesNotMatch(backend, /"Device"\.AssetId/);
});

test('configured Jira field is persisted as an identifier separate from device name', () => {
  assert.match(backend, /jiraIdentifier:\s*clean\(input\.jiraIdentifier/);
  assert.match(backend, /jiraIdentifierFieldId/);
  assert.match(backend, /jiraIdentifierFieldName/);
  assert.ok(/asset\.jiraIdentifier\s*\|\|\s*asset\.name/.test(backend) || /asset\?\.jiraIdentifier\s*\|\|\s*asset\?\.name/.test(backend));
  assert.match(backend, /byLegacyName/);
  assert.match(backend, /byLegacyName\.get\(normalized\)/);
});

test('new Jira-discovered assets keep identifier and device name separately', () => {
  assert.match(backend, /name:identifier/);
  assert.match(backend, /jiraIdentifier:identifier/);
  assert.match(backend, /jiraIdentifierFieldId:field\.id/);
  assert.match(backend, /jiraIdentifierFieldName:field\.name/);
});

test('Jira-discovered assets have deterministic ids and reconcile old duplicates', () => {
  assert.match(backend, /makeJiraAssetId/);
  assert.match(backend, /createHash\('sha256'\)/);
  assert.match(backend, /id:deterministicId/);
  assert.match(backend, /reconcileJiraAssets/);
  assert.match(backend, /group\.length<2/);
  assert.match(backend, /kvs\.delete\(`\$\{ASSET_PREFIX\}\$\{duplicate\.id\}`\)/);
  assert.match(backend, /reconciled/);
});

test('reporting does not start a second competing Jira sync', () => {
  const reportResolver = backend.slice(backend.indexOf("resolver.define('getAssetReport'"));
  assert.doesNotMatch(reportResolver.split('export const handler')[0], /syncAssetsFromJira\(false\)/);
});

test('asset search can find the configured Jira identifier', () => {
  assert.match(backend, /jiraIdentifier/);
  assert.ok(/normaliseName\(a\.jiraIdentifier\)\.includes\(query\)/.test(backend) || /\[a\.id,a\.name,a\.jiraIdentifier/.test(backend));
});

test('Jira metadata mappings use the latest populated value for each mapped field', () => {
  assert.match(backend, /jiraLocationField/);
  assert.match(backend, /jiraTypeField/);
  assert.match(backend, /jiraCrewCodeField/);
  assert.match(backend, /latestFieldValueForIdentifier/);
  assert.match(backend, /issueMatchesIdentifier/);
  assert.match(backend, /if\(value\)return value/);
});

test('crew code ownership works without a Jira account', () => {
  assert.match(backend, /mappedCrewPerson/);
  assert.match(backend, /crewPerson\?\.displayName\|\|crewCode/);
  assert.match(backend, /holderAccountId=crewPerson\?\.accountId\|\|''/);
  assert.match(backend, /m\.crewCode&&\(m\.displayName\|\|m\.accountId\)/);
});

test('manual holder entry stays free text while optional Jira identity lookup remains available', () => {
  assert.match(frontend, /Enter person, crew code, or search Jira/);
  assert.match(frontend, /assigneeAccountId:\s*''\s*,\s*assigneeName:\s*value/);
  assert.match(frontend, /asset\.assigneeAccountId\s*&&\s*query\s*===\s*asset\.assigneeName/);
  assert.match(frontend, /invoke\('searchUsers',\s*\{\s*query\s*\}\)/);
  assert.match(frontend, /assigneeAccountId:\s*user\.accountId/);
});

test('placeholder identifiers are rejected for discovery and fault matching', () => {
  assert.match(backend, /validIdentifier/);
  assert.match(backend, /\['\.', '-', 'n\/a', 'na', 'none', 'null', 'unknown'\]/);
  assert.match(backend, /autoDiscovered&&!validIdentifier\(identifier\)/);
  assert.match(backend, /if\(validIdentifier\(targetIdentifier\)\)/);
  assert.match(backend, /issueMatchesIdentifier\(issue,field\.id,targetIdentifier\)/);
});

test('configuration UI exposes field mappings and crew ownership controls', () => {
  assert.match(frontend, /Jira location \/ base field/);
  assert.match(frontend, /Jira device type field/);
  assert.match(frontend, /Jira crew code field/);
});

test('asset register exposes the latest fault per device', () => {
  assert.match(backend, /latestFault:tickets\[0\]/);
  assert.match(frontend, /report\?\.latestFault/);
  assert.match(frontend, /<th>Fault<\/th>/);
});

test('Forge Custom UI resources are configured for relative Vite assets', () => {
  assert.match(mainVite, /base:\s*['"]\.\/['"]/);
  assert.match(fieldVite, /base:\s*['"]\.\/['"]/);
  assert.match(manifest, /path:\s*static\/dist/);
  assert.match(manifest, /path:\s*field-static\/dist/);
});

test('manifest keeps core storage and Jira read scopes', () => {
  for (const scope of ['storage:app', 'read:jira-work', 'read:jira-user']) assert.ok(manifest.includes(scope), `Missing required scope: ${scope}`);
});
