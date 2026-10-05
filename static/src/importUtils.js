import { readSheet } from 'read-excel-file/browser';

const FIELD_MAP = {
  assetid: 'id', id: 'id', assettag: 'id',
  name: 'name', devicename: 'name', device: 'name',
  deviceid: 'jiraIdentifier', jiraidentifier: 'jiraIdentifier', jiraid: 'jiraIdentifier',
  crewcode: 'crewCode', crew: 'crewCode', externalassignmentreference: 'crewCode', assignmentreference: 'crewCode', externalreference: 'crewCode', holderreference: 'crewCode',
  type: 'type', assettype: 'type', devicetype: 'type',
  manufacturer: 'manufacturer', make: 'manufacturer',
  model: 'model',
  serial: 'serialNumber', serialnumber: 'serialNumber',
  assignee: 'assigneeName', assignedto: 'assigneeName', assigneduser: 'assigneeName', assignedperson: 'assigneeName', assignedpersonholder: 'assigneeName', holder: 'assigneeName', deviceholder: 'assigneeName', user: 'assigneeName',
  assigneeaccountid: 'assigneeAccountId', jiraaccountid: 'assigneeAccountId', holderaccountid: 'assigneeAccountId',
  client: 'client', customer: 'client', airline: 'client',
  status: 'status', location: 'location', base: 'location',
  purchasedate: 'purchaseDate', purchase: 'purchaseDate',
  warrantyexpiry: 'warrantyExpiry', warranty: 'warrantyExpiry',
  notes: 'notes'
};

const normaliseHeader = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
const normaliseName = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

function cellValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (value == null) return '';
  // Undo the apostrophe CSV export adds in front of formula-like text.
  return String(value).replace(/^'(?=[=+\-@\t\r])/, '').trim();
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

// Fields a file column can be mapped to, in the order the mapping step lists them.
export const IMPORT_TARGETS = [
  { key: 'name', label: 'Device Name' },
  { key: 'jiraIdentifier', label: 'Device ID' },
  { key: 'id', label: 'Asset ID' },
  { key: 'serialNumber', label: 'Serial Number' },
  { key: 'type', label: 'Type' },
  { key: 'manufacturer', label: 'Manufacturer' },
  { key: 'model', label: 'Model' },
  { key: 'client', label: 'Client' },
  { key: 'status', label: 'Status' },
  { key: 'location', label: 'Location' },
  { key: 'crewCode', label: 'Assignment Reference' },
  { key: 'assigneeName', label: 'Assigned Person / Holder' },
  { key: 'assigneeAccountId', label: 'Holder Jira Account ID' },
  { key: 'purchaseDate', label: 'Purchase Date' },
  { key: 'warrantyExpiry', label: 'Warranty Expiry' },
  { key: 'notes', label: 'Notes' }
];

// Targets for this site: the core fields plus configured custom fields ("custom:<key>").
export function importTargets(customFields = []) {
  return [...IMPORT_TARGETS, ...customFields.filter((f) => f?.key).map((f) => ({ key: `custom:${f.key}`, label: f.label || f.key }))];
}

// One target per column ('' = ignore). A heading remembered from an earlier import wins
// over the built-in names; a target is never suggested for two columns.
export function suggestMapping(headers = [], customFields = [], remembered = {}) {
  const valid = new Set(importTargets(customFields).map((t) => t.key));
  const customMap = customFieldMap(customFields);
  const used = new Set();
  return headers.map((raw) => {
    const header = normaliseHeader(raw);
    if (!header) return '';
    const custom = customMap.get(header);
    const options = [remembered[header], FIELD_MAP[header], custom ? `custom:${custom}` : ''];
    const target = options.find((t) => t !== undefined && (t === '' || valid.has(t)));
    if (!target || used.has(target)) return '';
    used.add(target);
    return target;
  });
}

// Headings whose mapping differs from the built-in guess, to remember for next time.
export function mappingToRemember(headers = [], mapping = [], customFields = []) {
  const defaults = suggestMapping(headers, customFields);
  const out = {};
  headers.forEach((raw, i) => { const h = normaliseHeader(raw); if (h && (mapping[i] || '') !== defaults[i]) out[h] = mapping[i] || ''; });
  return out;
}

export function duplicateTargets(mapping = []) {
  const seen = new Set(); const dup = new Set();
  for (const t of mapping) { if (!t) continue; if (seen.has(t)) dup.add(t); seen.add(t); }
  return [...dup];
}

// Raw file contents: the heading row and the non-empty data rows.
export async function readImportTable(file) {
  const lower = file.name.toLowerCase();
  let rows;
  if (lower.endsWith('.csv')) rows = parseCsvRows((await file.text()).replace(/^﻿/, ''));
  else if (lower.endsWith('.xlsx')) rows = await readSheet(file);
  else throw new Error('Please choose a CSV or Excel .xlsx file.');
  if (!Array.isArray(rows) || !rows.length) return { headers: [], rows: [] };
  return {
    headers: rows[0].map((h) => String(h ?? '').trim()),
    rows: rows.slice(1).filter((row) => Array.isArray(row) && row.some((value) => cellValue(value)))
  };
}

export function mapImportRows(table, mapping) {
  return table.rows.map((row) => {
    const asset = { customFields: {} };
    mapping.forEach((target, index) => {
      if (!target) return;
      const value = cellValue(row[index]);
      if (target.startsWith('custom:')) asset.customFields[target.slice(7)] = value;
      else asset[target] = value;
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

export async function readAssetImportFile(file, customFields = [], remembered = {}) {
  const table = await readImportTable(file);
  return mapImportRows(table, suggestMapping(table.headers, customFields, remembered));
}

// Excel shows long numbers such as IMEIs as 3.51633E+14 and saves them that way in a CSV,
// losing the last digits. Such a value would be wrong on the device and could match other devices.
const SHORTENED = /^\d(?:\.\d+)?E\+?\d+$/i;
const CHECKED_FIELDS = [['serialNumber', 'Serial Number'], ['jiraIdentifier', 'Device ID'], ['name', 'Device Name'], ['crewCode', 'Assignment Reference']];
function excelShortened(asset) {
  const hit = CHECKED_FIELDS.find(([key]) => SHORTENED.test(String(asset[key] ?? '').trim()));
  return hit ? `${hit[1]} ${String(asset[hit[0]]).trim()} was shortened by Excel. Format the column as Text in Excel (or export it again from the source) and import the file again.` : '';
}

// A row whose Device Name is already in the register updates that device (empty cells leave its
// values alone); the import works out the match.
export function validateImportRows(rows) {
  const seen = new Set();
  return rows.map((asset, index) => {
    const name = String(asset.name || '').trim();
    const key = normaliseName(name);
    let error = '';
    if (!name) error = 'Device Name is required.';
    else if (seen.has(key)) error = 'Duplicate Device Name in this file.';
    else error = excelShortened(asset);
    seen.add(key);
    return { ...asset, _row: index + 2, _error: error };
  });
}
