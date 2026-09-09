import sql from '@forge/sql';
import { createHash } from 'node:crypto';

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const isoToSql = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 23).replace('T', ' ');
  return date.toISOString().slice(0, 23).replace('T', ' ');
};

export const assetSourceHash = (asset = {}) => createHash('sha256').update(JSON.stringify({
  name: clean(asset.name || ''),
  jiraIdentifier: clean(asset.jiraIdentifier || ''),
  jiraIdentifierFieldId: clean(asset.jiraIdentifierFieldId || ''),
  jiraIdentifierFieldName: clean(asset.jiraIdentifierFieldName || ''),
  crewCode: clean(asset.crewCode || ''),
  assigneeAccountId: clean(asset.assigneeAccountId || ''),
  assigneeName: clean(asset.assigneeName || ''),
  type: clean(asset.type || ''),
  manufacturer: clean(asset.manufacturer || ''),
  model: clean(asset.model || ''),
  serialNumber: clean(asset.serialNumber || ''),
  status: clean(asset.status || ''),
  location: clean(asset.location || ''),
  purchaseDate: clean(asset.purchaseDate || ''),
  warrantyExpiry: clean(asset.warrantyExpiry || ''),
  notes: clean(asset.notes || ''),
  customFields: asset.customFields || {}
})).digest('hex');

export async function getSqlAssetById(id) {
  const result = await sql.prepare('SELECT * FROM Assets WHERE id = ? LIMIT 1').bindParams(id).execute();
  return result.rows?.[0] || null;
}

export async function getSqlAssetByIdentifier(identifier) {
  const key = normalise(identifier);
  if (!key) return null;
  const result = await sql.prepare('SELECT * FROM Assets WHERE normalized_identifier = ? OR normalized_name = ? ORDER BY updated_at DESC LIMIT 1').bindParams(key, key).execute();
  return result.rows?.[0] || null;
}

export async function upsertSqlAsset(asset = {}) {
  if (!asset.id || !clean(asset.name)) throw new Error('Asset id and name are required for SQL storage.');
  const hash = assetSourceHash(asset);
  const existing = await sql.prepare('SELECT source_hash FROM Assets WHERE id = ? LIMIT 1').bindParams(asset.id).execute();
  if (existing.rows?.[0]?.source_hash === hash) return { changed: false, hash };

  await sql.prepare(`INSERT INTO Assets (
    id, name, normalized_name, jira_identifier, normalized_identifier, jira_identifier_field_id, jira_identifier_field_name,
    assignment_reference, assignee_account_id, assignee_name, device_type, manufacturer, model, serial_number,
    status, location, purchase_date, warranty_expiry, notes, custom_fields, created_at, updated_at, source_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE
    name = VALUES(name), normalized_name = VALUES(normalized_name), jira_identifier = VALUES(jira_identifier),
    normalized_identifier = VALUES(normalized_identifier), jira_identifier_field_id = VALUES(jira_identifier_field_id),
    jira_identifier_field_name = VALUES(jira_identifier_field_name), assignment_reference = VALUES(assignment_reference),
    assignee_account_id = VALUES(assignee_account_id), assignee_name = VALUES(assignee_name), device_type = VALUES(device_type),
    manufacturer = VALUES(manufacturer), model = VALUES(model), serial_number = VALUES(serial_number), status = VALUES(status),
    location = VALUES(location), purchase_date = VALUES(purchase_date), warranty_expiry = VALUES(warranty_expiry),
    notes = VALUES(notes), custom_fields = VALUES(custom_fields), updated_at = VALUES(updated_at), source_hash = VALUES(source_hash)`)
    .bindParams(
      asset.id, clean(asset.name), normalise(asset.name), clean(asset.jiraIdentifier || ''), normalise(asset.jiraIdentifier || ''),
      clean(asset.jiraIdentifierFieldId || ''), clean(asset.jiraIdentifierFieldName || ''), clean(asset.crewCode || ''),
      clean(asset.assigneeAccountId || ''), clean(asset.assigneeName || ''), clean(asset.type || 'Other'),
      clean(asset.manufacturer || ''), clean(asset.model || ''), clean(asset.serialNumber || ''), clean(asset.status || 'Available'),
      clean(asset.location || ''), clean(asset.purchaseDate || ''), clean(asset.warrantyExpiry || ''), clean(asset.notes || ''),
      JSON.stringify(asset.customFields || {}), isoToSql(asset.createdAt), isoToSql(asset.updatedAt), hash
    ).execute();
  return { changed: true, hash };
}

export async function searchSqlAssets(queryValue = '', limit = 50, offset = 0) {
  const query = normalise(queryValue);
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 50)));
  const safeOffset = Math.max(0, Number(offset || 0));
  if (!query) {
    const result = await sql.prepare(`SELECT * FROM Assets ORDER BY name LIMIT ${safeLimit} OFFSET ${safeOffset}`).execute();
    return result.rows || [];
  }
  const prefix = `${query}%`;
  const contains = `%${query}%`;
  const result = await sql.prepare(`SELECT * FROM Assets
    WHERE normalized_name LIKE ? OR normalized_identifier LIKE ? OR serial_number LIKE ? OR device_type LIKE ? OR location LIKE ? OR assignment_reference LIKE ? OR assignee_name LIKE ?
    ORDER BY CASE WHEN normalized_name = ? OR normalized_identifier = ? THEN 0 WHEN normalized_name LIKE ? OR normalized_identifier LIKE ? THEN 1 ELSE 2 END, name
    LIMIT ${safeLimit} OFFSET ${safeOffset}`)
    .bindParams(prefix, prefix, contains, contains, contains, contains, contains, query, query, prefix, prefix)
    .execute();
  return result.rows || [];
}

export function sqlRowToAsset(row = {}) {
  let customFields = {};
  try { customFields = typeof row.custom_fields === 'string' ? JSON.parse(row.custom_fields) : (row.custom_fields || {}); } catch {}
  return {
    id: row.id,
    name: row.name,
    jiraIdentifier: row.jira_identifier || '',
    jiraIdentifierFieldId: row.jira_identifier_field_id || '',
    jiraIdentifierFieldName: row.jira_identifier_field_name || '',
    crewCode: row.assignment_reference || '',
    assigneeAccountId: row.assignee_account_id || '',
    assigneeName: row.assignee_name || '',
    type: row.device_type || 'Other',
    manufacturer: row.manufacturer || '',
    model: row.model || '',
    serialNumber: row.serial_number || '',
    status: row.status || 'Available',
    location: row.location || '',
    purchaseDate: row.purchase_date || '',
    warrantyExpiry: row.warranty_expiry || '',
    notes: row.notes || '',
    customFields,
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || ''
  };
}
