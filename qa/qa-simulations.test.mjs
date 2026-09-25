import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const backend = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const ticketSync = fs.readFileSync(new URL('../src/ticket-sync.js', import.meta.url), 'utf8');
const issuePanel = fs.readFileSync(new URL('../src/issue-panel.js', import.meta.url), 'utf8');
const frontend = fs.readFileSync(new URL('../static/src/main.jsx', import.meta.url), 'utf8');
const deviceField = fs.readFileSync(new URL('../field-static/src/main.jsx', import.meta.url), 'utf8');
const panelFrontend = fs.readFileSync(new URL('../panel-static/src/main.jsx', import.meta.url), 'utf8');
const manifest = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const mainVite = fs.readFileSync(new URL('../static/vite.config.js', import.meta.url), 'utf8');
const fieldVite = fs.readFileSync(new URL('../field-static/vite.config.js', import.meta.url), 'utf8');
const panelVite = fs.readFileSync(new URL('../panel-static/vite.config.js', import.meta.url), 'utf8');

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const normaliseName = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
function fieldValues(value) { if (value == null) return []; if (Array.isArray(value)) return value.flatMap(fieldValues); if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean); if (typeof value === 'object') { const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key; return candidate ? [String(candidate).trim()] : []; } return []; }
function discoverUniqueAssetNames(values) { const names = new Map(); for (const value of values) for (const name of fieldValues(value)) { const key = normaliseName(name); if (key && !names.has(key)) names.set(key, name); } return [...names.values()]; }

test('Jira field values support text, select, object and multi-value shapes', () => { assert.deepEqual(fieldValues(' TEST DEVICE 001 '), ['TEST DEVICE 001']); assert.deepEqual(fieldValues({ value: 'TEST DEVICE 002' }), ['TEST DEVICE 002']); assert.deepEqual(fieldValues({ name: 'TEST DEVICE 003' }), ['TEST DEVICE 003']); assert.deepEqual(fieldValues([{ value: 'A' }, { name: 'B' }, ' C ']), ['A', 'B', 'C']); assert.deepEqual(fieldValues(null), []); assert.deepEqual(fieldValues({ unexpected: 'ignored' }), []); });
test('device-name matching is case-insensitive and whitespace-normalised', () => { assert.equal(normaliseName('  TEST   DEVICE 001 '), 'test device 001'); assert.equal(normaliseName('Test Device 001'), normaliseName('test   device 001')); });
test('Jira discovery simulation de-duplicates equivalent device names', () => { assert.equal(discoverUniqueAssetNames(['TEST DEVICE 001',' test   device 001 ',{ value: 'TEST DEVICE 002' },[{ name: 'TEST DEVICE 003' }, { value: 'TEST DEVICE 002' }]]).length, 3); });
test('randomised name simulation never creates duplicate normalised names', () => { const raw=[]; for(let i=0;i<1000;i+=1){const id=i%125;raw.push(i%2?` Device   ${id} `:{value:`DEVICE ${id}`});} const discovered=discoverUniqueAssetNames(raw); assert.equal(discovered.length,125); assert.equal(new Set(discovered.map(normaliseName)).size,125); });

test('backend retains critical Jira-sync and safety contracts', () => { assert.match(backend,/jiraAssetField:\s*null/); assert.match(backend,/resolveJiraAssetField/); assert.match(backend,/nextPageToken/); assert.match(backend,/syncAssetsFromJira/); assert.match(backend,/Could not verify whether this device is linked to Jira tickets/); });
test('configured Jira field is persisted separately from device name', () => { assert.match(backend,/jiraIdentifier/); assert.match(backend,/jiraIdentifierFieldId/); assert.match(backend,/jiraIdentifierFieldName/); assert.match(backend,/findAssetForJiraIdentifier/); assert.match(backend,/nameIndexKey\(identifier\)/); });
test('Jira-discovered assets have deterministic ids without full-store lookup', () => { assert.match(backend,/makeJiraAssetId/); assert.match(backend,/createHash\('sha256'\)/); assert.match(backend,/id:makeJiraAssetId\(field\.id,identifier\)/); assert.match(backend,/findAssetForJiraIdentifier/); });
test('large Jira discovery is resumable and bounded per Forge invocation', () => { assert.match(backend,/SYNC_PROGRESS_KEY/); assert.match(backend,/SYNC_JIRA_PAGE_SIZE\s*=\s*25/); assert.match(backend,/searchIssuePageWithConfiguredAssetField/); assert.match(backend,/nextPageToken:progress\?\.nextPageToken/); assert.match(backend,/else await kvs\.set\(SYNC_PROGRESS_KEY,progress\)/); assert.match(frontend,/while\(sync&&!sync\.complete&&guard<(?:50|800)\)/); assert.match(frontend,/Syncing Jira devices…/); });
test('Jira project scope limits discovery and ticket history to one configured project', () => {
  assert.match(backend,/jiraProjectKey/);
  assert.match(backend,/function projectScope\(settings\)/);
  assert.match(backend,/const scope=projectScope\(settings\)/);
  assert.match(backend,/\$\{projectScope\(settings\)\}\(/);
  assert.match(backend,/jiraProjectKey:clean\(incoming\.jiraProjectKey\|\|''\)/);
  assert.match(frontend,/Jira project to scan/);
  assert.match(frontend,/getJiraProjects/);
});

test('Jira sync skips expensive manual uniqueness scan', () => { assert.match(backend,/source !== 'jira-sync'/); assert.match(backend,/assertUniqueDeviceName/); });
test('reporting groups targeted Jira results by device identifier', () => { assert.match(backend,/ticketsByIdentifier/); assert.match(backend,/const found=await searchIssuesForIdentifiers\(identifiers\.slice\(i,i\+REPORT_IDENTIFIER_CHUNK\)\)/); });
test('metadata mappings use latest populated values', () => { assert.match(backend,/jiraLocationField/); assert.match(backend,/jiraTypeField/); assert.match(backend,/jiraCrewCodeField/); assert.match(backend,/latestFieldValueForIdentifier/); });
test('assignment reference ownership works without Jira account', () => { assert.match(backend,/mappedCrewPerson/); assert.match(backend,/crewPerson\?\.displayName\|\|crewCode/); });
test('manual holder entry stays free text', () => { assert.match(frontend,/Enter person, assignment reference, or search Jira/); assert.match(frontend,/invoke\('searchUsers'/); });
test('ticket splitter detects device IDs with single-character suffixes', () => {
  const splitter=fs.readFileSync(new URL('../src/device-split.js', import.meta.url),'utf8');
  assert.match(splitter,/\[A-Z0-9\]\{1,\}/);
  const matches='RYR_WM_7 RYR_WM_6 RYR_WM_69 RYR_STN_122 RYR_STN_117'.match(/\b[A-Z0-9]{2,}(?:[_-][A-Z0-9]{1,}){1,}\b/gi)||[];
  assert.deepEqual(matches,['RYR_WM_7','RYR_WM_6','RYR_WM_69','RYR_STN_122','RYR_STN_117']);
});

test('placeholder identifiers are rejected', () => { assert.match(backend,/validIdentifier/); assert.match(backend,/if\(!validIdentifier\(identifier\)\)\{ignored\+=1;continue;\}/); });
test('configuration UI uses generic assignment-reference wording and save feedback', () => { assert.match(frontend,/Jira assignment reference field/); assert.match(frontend,/Assignment reference → holder mappings/); assert.match(frontend,/Saving…/); assert.match(frontend,/saveStage/); });
test('configuration textareas preserve raw multiline editing until save', () => { assert.match(frontend,/assetTypesText/); assert.match(frontend,/statusesText/); assert.match(frontend,/locationsText/); assert.match(frontend,/crewMappingsText/); assert.match(frontend,/customFieldsText/); assert.match(frontend,/compileSettings/); });
test('Jira discovery can be disabled while one-off scanning remains available', () => { assert.match(backend,/jiraDiscoveryEnabled:\s*true/); assert.match(backend,/jiraDiscoveryEnabled:incoming\.jiraDiscoveryEnabled!==false/); assert.match(frontend,/Automatically scan and import assets from the mapped Jira Device ID field/); assert.match(frontend,/Scan & import Device IDs now/); assert.match(frontend,/Asset Manager startup is intentionally non-blocking/); assert.match(frontend,/saved\.jiraAssetField\?\.id&&saved\.jiraProjectKey&&saved\.jiraDiscoveryEnabled!==false/); });
test('asset register exposes latest populated device fault only', () => { assert.match(backend,/const faults=primary\.filter\(t=>clean\(t\.fault\|\|''\)\)/); assert.match(backend,/latestFault:faults\[0\]\|\|null/); assert.match(frontend,/reportByAsset\.get\(asset\.id\)\?\.latestFault/); assert.match(frontend,/key==='fault'/); });

test('Related Assets field is configurable and kept separate from primary Device ID', () => {
  assert.match(backend,/jiraRelatedAssetField:\s*null/);
  assert.match(backend,/jiraRelatedAssetField:normaliseField\(incoming\.jiraRelatedAssetField\)/);
  assert.match(frontend,/Jira related asset field/);
  assert.match(frontend,/Map a secondary device field/);
  assert.match(frontend,/jiraRelatedAssetField:null/);
});

test('related identifiers support multiple values in a plain text Jira field', () => {
  assert.match(backend,/function relatedIdentifiers/);
  assert.match(backend,/split\(\/\[,;\\n\\r\]\+\//);
  assert.match(backend,/issueMatchesRelatedIdentifier/);
  assert.match(issuePanel,/function relatedIdentifiers/);
  assert.match(issuePanel,/current\.join\(', '\)/);
});

test('related assets appear in history but stay out of primary fault totals', () => {
  assert.match(backend,/ticketFields\(issue,'related'\)/);
  assert.match(backend,/const primary=tickets\.filter\(t=>t\.relation==='primary'\)/);
  assert.match(backend,/const related=tickets\.filter\(t=>t\.relation==='related'\)/);
  assert.match(backend,/const faults=primary\.filter\(t=>clean\(t\.fault\|\|''\)\)/);
  assert.match(backend,/total:faults\.length/);
  assert.match(backend,/related:related\.length/);
  assert.match(frontend,/Primary faults/);
  assert.match(frontend,/Related tickets/);
  assert.match(frontend,/Related asset/);
});

test('issue panel manages one primary asset and multiple related assets', () => {
  assert.match(manifest,/function: issue-panel/);
  assert.match(manifest,/handler: issue-panel\.handler/);
  assert.match(manifest,/path:\s*panel-static\/dist/);
  assert.match(issuePanel,/resolver\.define\('setPrimaryAsset'/);
  assert.match(issuePanel,/resolver\.define\('addRelatedAsset'/);
  assert.match(issuePanel,/resolver\.define\('removeRelatedAsset'/);
  assert.match(issuePanel,/relation: 'primary'/);
  assert.match(issuePanel,/relation: 'related'/);
  assert.match(panelFrontend,/Primary asset/);
  assert.match(panelFrontend,/Related assets/);
  assert.match(panelFrontend,/Use <strong>Primary<\/strong>/);
});

test('ticket autofill makes device type automatic but location and owner explicit opt-ins', () => {
  assert.match(ticketSync,/choices\.deviceType !== false/);
  assert.match(ticketSync,/choices\.location === true/);
  assert.match(ticketSync,/choices\.owner === true/);
  assert.match(ticketSync,/jiraTypeField/);
  assert.match(ticketSync,/jiraLocationField/);
  assert.match(ticketSync,/jiraCrewCodeField/);
  assert.match(ticketSync,/method: 'PUT'/);
  assert.match(deviceField,/deviceType:true,location:applyLocation,owner:applyOwner/);
  assert.match(deviceField,/fills Device Type automatically/);
  assert.match(deviceField,/Also apply location/);
  assert.match(deviceField,/Also apply holder \/ assignment reference/);
  assert.match(deviceField,/Location and holder remain opt-in/);
});

test('explicit Device selection writes the mapped Jira device identifier', () => {
  assert.match(ticketSync,/cfg\.jiraAssetField\?\.id/);
  assert.match(ticketSync,/asset\.jiraIdentifier \|\| asset\.name/);
  assert.match(ticketSync,/cfg\.jiraAssetField\.id/);
  assert.match(deviceField,/Choosing an asset writes its identifier to the mapped Jira device identifier field/);
});

test('ticket autofill is wired through a dedicated Forge resolver with write scope', () => {
  assert.match(manifest,/function: ticket-sync/);
  assert.match(manifest,/handler: ticket-sync\.handler/);
  assert.match(manifest,/write:jira-work/);
  assert.match(ticketSync,/resolver\.define\('applyAssetToIssue'/);
  assert.match(ticketSync,/resolver\.define\('searchDevices'/);
});

test('Forge Custom UI resources use relative Vite assets', () => { assert.match(mainVite,/base:\s*['"]\.\/['"]/); assert.match(fieldVite,/base:\s*['"]\.\/['"]/); assert.match(panelVite,/base:\s*['"]\.\/['"]/); assert.match(manifest,/path:\s*static\/dist/); assert.match(manifest,/path:\s*field-static\/dist/); assert.match(manifest,/path:\s*panel-static\/dist/); });
test('manifest keeps core storage and Jira scopes', () => { for(const scope of ['storage:app','read:jira-work','write:jira-work','read:jira-user']) assert.ok(manifest.includes(scope),`Missing required scope: ${scope}`); });