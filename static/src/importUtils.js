import { readSheet } from 'read-excel-file/browser';

const FIELD_MAP = {
  assetid: 'id', id: 'id', assettag: 'id',
  name: 'name', devicename: 'name', device: 'name',
  type: 'type', assettype: 'type', devicetype: 'type',
  manufacturer: 'manufacturer', make: 'manufacturer',
  model: 'model',
  serial: 'serialNumber', serialnumber: 'serialNumber',
  assignee: 'assigneeName', assignedto: 'assigneeName', user: 'assigneeName',
  status: 'status', location: 'location',
  purchasedate: 'purchaseDate', purchase: 'purchaseDate',
  warrantyexpiry: 'warrantyExpiry', warranty: 'warrantyExpiry',
  notes: 'notes'
};

const normaliseHeader = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
const normaliseName = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function cellValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return value == null ? '' : String(value).trim();
}

function customFieldMap(customFields = []) {
  const map = new Map();
  for (const field of customFields) {
    if (!field?.key) continue;
    map.set(normaliseHeader(field.key), field.key);
    if (field.label) map.set(normaliseHeader(field.label), field.key);
  }
  return map;
}

function rowsToAssets(rows, customFields = []) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const headers = rows[0].map(normaliseHeader);
  const customMap = customFieldMap(customFields);

  return rows.slice(1)
    .filter((row) => Array.isArray(row) && row.some((value) => cellValue(value)))
    .map((row) => {
      const asset = { customFields: {} };
      headers.forEach((header, index) => {
        if (!header) return;
        const value = cellValue(row[index]);
        const coreField = FIELD_MAP[header];
        const customKey = customMap.get(header);
        if (coreField) asset[coreField] = value;
        else if (customKey) asset.customFields[customKey] = value;
      });
      if (!Object.keys(asset.customFields).length) delete asset.customFields;
      return asset;
    });
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = ''; continue;
    }
    cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

export async function readAssetImportFile(file, customFields = []) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return rowsToAssets(parseCsvRows(await file.text()), customFields);
  if (lower.endsWith('.xlsx')) return rowsToAssets(await readSheet(file), customFields);
  throw new Error('Please choose a CSV or Excel .xlsx file.');
}

export function validateImportRows(rows, existingAssets = []) {
  const existing = new Set(existingAssets.map((asset) => normaliseName(asset.name)));
  const seen = new Set();
  return rows.map((asset, index) => {
    const name = String(asset.name || '').trim();
    const key = normaliseName(name);
    let error = '';
    if (!name) error = 'Device Name is required.';
    else if (seen.has(key)) error = 'Duplicate Device Name in this file.';
    else if (existing.has(key) && !asset.id) error = 'Device Name already exists.';
    seen.add(key);
    return { ...asset, _row: index + 2, _error: error };
  });
}
