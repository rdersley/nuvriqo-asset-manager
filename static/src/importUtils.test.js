import test from 'node:test';
import assert from 'node:assert/strict';
import { readAssetImportFile, validateImportRows } from './importUtils.js';

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

test('rejects a new row whose Device Name already exists', () => {
  const [row] = validateImportRows(
    [{ name: 'DESKTOP-01' }],
    [{ id: 'AST-1', name: 'desktop-01' }]
  );
  assert.equal(row._error, 'Device Name already exists.');
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
