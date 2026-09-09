import sql from '@forge/sql';
import { createHash } from 'node:crypto';

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const isoToSql = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 23).replace('T', ' ');
  return date.toISOString().slice(0, 23).replace('T', ' ');
};
const makeEventId = () => `CUST-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

export const assetSourceHash = (asset = {}) => createHash('sha256').update(JSON.stringify({
  name: clean(asset.name || ''), jiraIdentifier: clean(asset.jiraIdentifier || ''), crewCode: clean(asset.crewCode || ''),
  assigneeAccountId: clean(asset.assigneeAccountId || ''), assigneeName: clean(asset.assigneeName || ''),
  type: clean(asset.type || ''), manufacturer: clean(asset.manufacturer || ''), model: clean(asset.model || ''),
  serialNumber: clean(asset.serialNumber || ''), status: clean(asset.status || ''), location: clean(asset.location || ''),
  purchaseDate: clean(asset.purchaseDate || ''), warrantyExpiry: clean(asset.warrantyExpiry || ''), notes: clean(asset.notes || ''),
  customFields: asset.customFields || {}
})).digest('hex');

export async function getSqlAssetById(id) {
  const result = await sql.prepare('SELECT * FROM Assets WHERE id = ? LIMIT 1').bindParams(id).execute();
  return result.rows?.[0] || null;
}

export async function upsertSqlAsset(asset = {}) {
  if (!asset.id || !clean(asset.name)) throw new Error('Asset id and name are required for SQL storage.');
  const hash = assetSourceHash(asset);
  const existing = await sql.prepare('SELECT source_hash FROM Assets WHERE id = ? LIMIT 1').bindParams(asset.id).execute();
  if (existing.rows?.[0]?.source_hash === hash) return { changed: false, hash };
  await sql.prepare(`INSERT INTO Assets (
    id,name,normalized_name,jira_identifier,normalized_identifier,assignment_reference,assignee_account_id,assignee_name,
    device_type,manufacturer,model,serial_number,status,location,purchase_date,warranty_expiry,notes,custom_fields,created_at,updated_at,source_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON DUPLICATE KEY UPDATE name=VALUES(name),normalized_name=VALUES(normalized_name),jira_identifier=VALUES(jira_identifier),
    normalized_identifier=VALUES(normalized_identifier),assignment_reference=VALUES(assignment_reference),assignee_account_id=VALUES(assignee_account_id),
    assignee_name=VALUES(assignee_name),device_type=VALUES(device_type),manufacturer=VALUES(manufacturer),model=VALUES(model),serial_number=VALUES(serial_number),
    status=VALUES(status),location=VALUES(location),purchase_date=VALUES(purchase_date),warranty_expiry=VALUES(warranty_expiry),notes=VALUES(notes),
    custom_fields=VALUES(custom_fields),updated_at=VALUES(updated_at),source_hash=VALUES(source_hash)`)
    .bindParams(asset.id,clean(asset.name),normalise(asset.name),clean(asset.jiraIdentifier||''),normalise(asset.jiraIdentifier||''),clean(asset.crewCode||''),
      clean(asset.assigneeAccountId||''),clean(asset.assigneeName||''),clean(asset.type||'Other'),clean(asset.manufacturer||''),clean(asset.model||''),clean(asset.serialNumber||''),
      clean(asset.status||'Available'),clean(asset.location||''),clean(asset.purchaseDate||''),clean(asset.warrantyExpiry||''),clean(asset.notes||''),JSON.stringify(asset.customFields||{}),
      isoToSql(asset.createdAt),isoToSql(asset.updatedAt),hash).execute();
  return { changed: true, hash };
}

export async function searchSqlAssets(queryValue = '', limit = 50, offset = 0) {
  const query = normalise(queryValue), safeLimit = Math.min(100, Math.max(1, Number(limit || 50))), safeOffset = Math.max(0, Number(offset || 0));
  if (!query) return (await sql.prepare(`SELECT * FROM Assets ORDER BY name LIMIT ${safeLimit} OFFSET ${safeOffset}`).execute()).rows || [];
  const prefix = `${query}%`, contains = `%${query}%`;
  return (await sql.prepare(`SELECT * FROM Assets WHERE normalized_name LIKE ? OR normalized_identifier LIKE ? OR serial_number LIKE ? OR device_type LIKE ? OR location LIKE ? OR assignment_reference LIKE ? OR assignee_name LIKE ? ORDER BY name LIMIT ${safeLimit} OFFSET ${safeOffset}`)
    .bindParams(prefix,prefix,contains,contains,contains,contains,contains).execute()).rows || [];
}

export async function upsertCrewMember(crew = {}) {
  if (!clean(crew.crewCode)) throw new Error('Crew code is required.');
  await sql.prepare(`INSERT INTO CrewMembers (crew_code,name,location,email,easysim_username,ryrwin_username,role,status,contract_end_date,training_end_date,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),location=VALUES(location),email=VALUES(email),easysim_username=VALUES(easysim_username),ryrwin_username=VALUES(ryrwin_username),role=VALUES(role),status=VALUES(status),contract_end_date=VALUES(contract_end_date),training_end_date=VALUES(training_end_date),updated_at=VALUES(updated_at)`)
    .bindParams(clean(crew.crewCode),clean(crew.name||''),clean(crew.location||''),clean(crew.email||''),clean(crew.easysimUsername||''),clean(crew.ryrWinUsername||''),clean(crew.role||''),clean(crew.status||'Active'),clean(crew.contractEndDate||''),clean(crew.trainingEndDate||''),isoToSql()).execute();
}

export async function resolveSqlCrew(loginValue) {
  const login = normalise(loginValue); if (!login) return null;
  const result = await sql.prepare(`SELECT * FROM CrewMembers WHERE LOWER(crew_code)=? OR LOWER(easysim_username)=? OR LOWER(ryrwin_username)=? OR LOWER(SUBSTRING_INDEX(email,'@',1))=? LIMIT 1`).bindParams(login,login,login,login).execute();
  return result.rows?.[0] || null;
}

export async function recordCustodyEvent(event = {}) {
  const assetId = clean(event.assetId || '');
  const eventType = clean(event.eventType || '');
  const state = clean(event.state || '');
  if (!assetId || !eventType || !state) throw new Error('Asset, event type and custody state are required.');
  const eventId = clean(event.eventId || makeEventId());
  await sql.prepare(`INSERT INTO CustodyEvents (
    event_id,asset_id,crew_code,device_type,event_type,state,source,issue_key,previous_crew_code,related_asset_id,
    expected_return_at,actual_return_at,notes,occurred_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bindParams(
      eventId, assetId, clean(event.crewCode||''), clean(event.deviceType||'Other'), eventType, state,
      clean(event.source||'manual'), clean(event.issueKey||''), clean(event.previousCrewCode||''), clean(event.relatedAssetId||''),
      event.expectedReturnAt ? isoToSql(event.expectedReturnAt) : null,
      event.actualReturnAt ? isoToSql(event.actualReturnAt) : null,
      clean(event.notes||''), isoToSql(event.occurredAt), isoToSql(event.createdAt)
    ).execute();
  return { eventId };
}

export async function getOpenCustodyForCrew(crewCode) {
  const crew = clean(crewCode || '');
  if (!crew) return [];
  const result = await sql.prepare(`SELECT c.* FROM CustodyEvents c
    JOIN (
      SELECT asset_id, MAX(occurred_at) AS latest_at
      FROM CustodyEvents GROUP BY asset_id
    ) latest ON latest.asset_id = c.asset_id AND latest.latest_at = c.occurred_at
    WHERE LOWER(c.crew_code)=LOWER(?) AND c.state IN ('Issued','Return Expected','Return Overdue','Lost/Unaccounted for')
    ORDER BY c.device_type, c.occurred_at DESC`).bindParams(crew).execute();
  return result.rows || [];
}

export async function findCustodyExceptions() {
  const duplicateByCrew = await sql.prepare(`SELECT crew_code, device_type, COUNT(*) AS open_count
    FROM (
      SELECT c.* FROM CustodyEvents c
      JOIN (SELECT asset_id, MAX(occurred_at) latest_at FROM CustodyEvents GROUP BY asset_id) latest
        ON latest.asset_id=c.asset_id AND latest.latest_at=c.occurred_at
      WHERE c.state IN ('Issued','Return Expected','Return Overdue','Lost/Unaccounted for')
    ) open_events
    WHERE crew_code IS NOT NULL AND crew_code <> ''
    GROUP BY crew_code, device_type HAVING COUNT(*) > 1
    ORDER BY open_count DESC, crew_code`).execute();
  const duplicateByAsset = await sql.prepare(`SELECT asset_id, COUNT(DISTINCT crew_code) AS crew_count
    FROM (
      SELECT c.* FROM CustodyEvents c
      JOIN (SELECT asset_id, MAX(occurred_at) latest_at FROM CustodyEvents GROUP BY asset_id) latest
        ON latest.asset_id=c.asset_id AND latest.latest_at=c.occurred_at
      WHERE c.state IN ('Issued','Return Expected','Return Overdue','Lost/Unaccounted for')
    ) open_events
    WHERE crew_code IS NOT NULL AND crew_code <> ''
    GROUP BY asset_id HAVING COUNT(DISTINCT crew_code) > 1
    ORDER BY crew_count DESC, asset_id`).execute();
  return {
    duplicateDeviceTypes: duplicateByCrew.rows || [],
    multipleCrewAssignments: duplicateByAsset.rows || []
  };
}
