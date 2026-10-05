import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateTargets, mapImportRows, mappingToRemember, readAssetImportFile, readImportTable, suggestMapping, validateImportRows } from './importUtils.js';

test('requires a Device Name', () => {
  const [row] = validateImportRows([{ name: '' }], []);
  assert.equal(row._row, 2);
  assert.equal(row._error, 'Device Name is required.');
});

test('rejects duplicate Device Names in the same file ignoring case and spacing', () => {
  const rows = validateImportRows([
    { name: 'Laptop 001' },
    { name: '  laptop   001 ' }
  ], []);
  assert.equal(rows[0]._error, '');
  assert.equal(rows[1]._error, 'Duplicate Device Name in this file.');
});

test('a row whose Device Name already exists is kept, to update that device', () => {
  const [row] = validateImportRows(
    [{ name: 'DESKTOP-01' }],
    [{ id: 'AST-1', name: 'desktop-01' }]
  );
  assert.equal(row._error, '');
});

test('allows an import row with an asset id to be treated as an update candidate', () => {
  const [row] = validateImportRows(
    [{ id: 'AST-1', name: 'DESKTOP-01' }],
    [{ id: 'AST-1', name: 'desktop-01' }]
  );
  assert.equal(row._error, '');
});

test('maps configured custom field labels back into customFields during CSV import', async () => {
  const file = {
    name: 'assets.csv',
    text: async () => 'Device Name,Replacement Date,Asset Owner\nLaptop 001,2027-01-15,IT Team\n'
  };
  const rows = await readAssetImportFile(file, [
    { key: 'replacementDate', label: 'Replacement Date', type: 'date' },
    { key: 'assetOwner', label: 'Asset Owner', type: 'text' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Laptop 001');
  assert.equal(rows[0].customFields.replacementDate, '2027-01-15');
  assert.equal(rows[0].customFields.assetOwner, 'IT Team');
});

test('round-trips exported Device ID, Crew Code and holder headers', async () => {
  const file = {
    name: 'assets.csv',
    text: async () => 'Device Name,Device ID,Crew Code,Assigned Person / Holder,Location\nFriendly Tablet,RYR123,ABC456,Jane Smith,DUB\n'
  };
  const [row] = await readAssetImportFile(file);
  assert.equal(row.name, 'Friendly Tablet');
  assert.equal(row.jiraIdentifier, 'RYR123');
  assert.equal(row.crewCode, 'ABC456');
  assert.equal(row.assigneeName, 'Jane Smith');
  assert.equal(row.location, 'DUB');
});

test('supports legacy holder aliases and Base imports', async () => {
  const file = {
    name: 'legacy.csv',
    text: async () => 'Device Name,Assigned User,Base,Crew Code\nTablet 9,External Person,SNN,CREW9\n'
  };
  const [row] = await readAssetImportFile(file);
  assert.equal(row.assigneeName, 'External Person');
  assert.equal(row.location, 'SNN');
  assert.equal(row.crewCode, 'CREW9');
  assert.equal(row.assigneeAccountId, undefined);
});

test('keeps Jira account identity optional when explicitly supplied', async () => {
  const file = {
    name: 'identity.csv',
    text: async () => 'Device Name,Holder,Jira Account ID\nTablet 10,Portal Customer,712020:abcd\n'
  };
  const [row] = await readAssetImportFile(file);
  assert.equal(row.assigneeName, 'Portal Customer');
  assert.equal(row.assigneeAccountId, '712020:abcd');
});

const csv = (text) => ({ name: 'devices.csv', text: async () => text });

test('unrecognised headings are left unmapped and listed with their columns', async () => {
  const table = await readImportTable(csv('Hostname,Kit Type,Serial No.,Something Else\nTAB-1,Tablet,SN1,x\n'));
  assert.deepEqual(table.headers, ['Hostname', 'Kit Type', 'Serial No.', 'Something Else']);
  assert.deepEqual(suggestMapping(table.headers), ['', '', '', '']);
});

test('a chosen mapping imports columns whose headings do not match', async () => {
  const table = await readImportTable(csv('Hostname,Kit Type,Serial No.,Owner Team\nTAB-1,Tablet,SN1,IT\n'));
  const [row] = mapImportRows(table, ['name', 'type', 'serialNumber', 'custom:ownerTeam']);
  assert.deepEqual(row, { name: 'TAB-1', type: 'Tablet', serialNumber: 'SN1', customFields: { ownerTeam: 'IT' } });
});

test('remembered headings win over built-in names, including "don\'t import"', () => {
  const remembered = { hostname: 'name', location: '' };
  assert.deepEqual(suggestMapping(['Hostname', 'Location', 'Base'], [], remembered), ['name', '', 'location']);
});

test('only changes from the built-in guess are remembered', () => {
  const headers = ['Device Name', 'Hostname', 'Notes'];
  assert.deepEqual(mappingToRemember(headers, ['name', 'jiraIdentifier', ''], []), { hostname: 'jiraIdentifier', notes: '' });
});

test('a field is never suggested for two columns, and duplicates are reported', () => {
  assert.deepEqual(suggestMapping(['Device', 'Device Name']), ['name', '']);
  assert.deepEqual(duplicateTargets(['name', 'type', 'name', '']), ['name']);
});

test('remembered mappings to fields that no longer exist are ignored', () => {
  assert.deepEqual(suggestMapping(['Owner'], [], { owner: 'custom:gone' }), ['']);
});

test('Client and Customer columns import into the device client', async () => {
  const [a] = await readAssetImportFile(csv('Device Name,Client\nTAB-1,RYR\n'));
  const [b] = await readAssetImportFile(csv('Device Name,Customer\nTAB-2,EZY\n'));
  assert.equal(a.client, 'RYR');
  assert.equal(b.client, 'EZY');
});

test('numbers Excel shortened to scientific notation are not imported', () => {
  const rows = validateImportRows([{ name: 'GALAXY-1', serialNumber: '3.51633E+14' }, { name: 'GALAXY-2', serialNumber: '351633123456789' }, { name: '1.2E+10' }], []);
  assert.match(rows[0]._error, /Serial Number 3\.51633E\+14 was shortened by Excel/);
  assert.equal(rows[1]._error, '');
  assert.match(rows[2]._error, /Device Name 1\.2E\+10/);
});
