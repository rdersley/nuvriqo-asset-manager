import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { guardResolver } from './auth.js';
import { defineBackupResolvers, BACKUP_RESOLVERS } from './backup.js';
import { normaliseReplacementSettings, normaliseStatusRules, STATUS_AUTOMATION_LOG_KEY } from './status-automation.js';
import { licensedResolver } from './licence.js';
import { trackActor, actorFields } from './actor.js';
import { checkDeviceId, compileDeviceIdPatterns } from './device-id-rule.js';
import { DEVICE_ID_REVIEW_PREFIX, deviceIdReviewKey } from './device-id-review.js';
import { buildDeviceTimeline, bulkCandidate, dateOnly } from './device-timeline.js';

// Actions that change configuration, run Jira discovery or write many assets
// at once. Everyday create/edit and guarded single delete stay open to users.
const ADMIN_RESOLVERS = new Set([...BACKUP_RESOLVERS, 'saveSettings', 'syncAssetsFromJira', 'bulkImportAssets', 'previewAssetImportReconciliation', 'reconcileAssetImport', 'bulkRemoveAssets', 'getStatusAutomationLog', 'getDataConflicts', 'resolveDataConflict', 'tidyAssetTypes', 'previewJiraScan', 'getDeviceIdReview', 'resolveDeviceIdValue', 'bulkHolderConflicts']);
const resolver = trackActor(guardResolver(licensedResolver(new Resolver()), ADMIN_RESOLVERS));
defineBackupResolvers(resolver);
const BULK_REMOVE_BATCH = 25;
const JIRA_DISCOVERED_NOTE = 'Discovered automatically from Jira field';
// Jira-discovered and never confirmed by a person (edit, import or CSV merge).
const isUncuratedJiraDiscovery = (asset) => String(asset?.notes || '').startsWith(JIRA_DISCOVERED_NOTE) && !asset?.curatedAt;
const HUMAN_HISTORY_SOURCES = new Set(['manual', 'import', 'bulk-import', 'import-reconcile']);
// Backfill for assets confirmed before curatedAt existed: if history shows a
// person edited, imported or merged the asset, record curatedAt and keep it.
async function markCuratedFromHistory(asset) {
  const page = await kvs.query().where('key', WhereConditions.beginsWith(`${HISTORY_PREFIX}${asset.id}:`)).limit(100).getMany();
  const event = page.results.map((e) => e.value).find((e) => HUMAN_HISTORY_SOURCES.has(e?.source));
  if (!event) return false;
  await kvs.set(`${ASSET_PREFIX}${asset.id}`, { ...asset, curatedAt: event.timestamp || now() });
  return true;
}
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const CLIENT_INDEX_PREFIX = 'asset-client:';
const LINK_PREFIX = 'issue-link:';
const ASSET_TICKET_PREFIX = 'asset-ticket:';
const HISTORY_PREFIX = 'asset-history:';
const FAULT_HISTORY_PREFIX = 'fault-history:';
// One record per device whose Jira tickets name a different holder than Asset Manager.
const HOLDER_CONFLICT_PREFIX = 'holder-conflict:';
const SETTINGS_KEY = 'settings:asset-manager';
const SYNC_KEY = 'sync:asset-manager:jira-field';
// Raised when the saved fault figures gain a field (2: repeat faults), so Reports asks for a new scan.
const FAULT_SUMMARY_VERSION = 2;
const SYNC_PROGRESS_KEY = 'sync-progress:asset-manager:jira-field';
const SYNC_JIRA_PAGE_SIZE = 25;

const DEFAULT_SETTINGS = {
  assetTypes: ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Printer', 'Accessory', 'Other'],
  statuses: ['Ordered', 'Available', 'In Use', 'Repair', 'Lost', 'Retired'],
  locations: [], customFields: [], jiraAssetField: null,
  jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null, jiraClientField: null, jiraProjectKey: '',
  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true,
  statusAutomationEnabled: false, statusRules: [],
  replacement: { enabled: false, projects: [], ticketStatus: '', deviceStatus: '', pairs: [] }
};
const now = () => new Date().toISOString();
const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const safeArray = (value) => Array.isArray(value) ? value : [];
const normaliseName = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const nameIndexKey = (name) => `${ASSET_NAME_PREFIX}${Buffer.from(normaliseName(name), 'utf8').toString('base64url')}`;
const validIdentifier = (value) => {
  const raw = String(clean(value) || '').trim();
  const v = normaliseName(raw);
  if (!v || ['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v)) return false;
  if (raw.length < 4 || raw.length > 100) return false;
  if (/^[?._\-\s]+$/.test(raw)) return false;
  if (/^0+$/.test(raw)) return false;
  if (/^\d+$/.test(raw)) return false;
  if (!/[a-z]/i.test(raw)) return false;
  return true;
};
function makeAssetId() { return `AST-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`; }
function makeJiraAssetId(fieldId, identifier) { return `AST-JIRA-${createHash('sha256').update(`${fieldId}:${normaliseName(identifier)}`).digest('hex').slice(0, 24).toUpperCase()}`; }
function normaliseAsset(input = {}, existing = {}) {
  return { ...existing, id: clean(input.id || existing.id || makeAssetId()), name: clean(input.name ?? existing.name ?? ''), jiraIdentifier: clean(input.jiraIdentifier ?? existing.jiraIdentifier ?? ''), jiraIdentifierFieldId: clean(input.jiraIdentifierFieldId ?? existing.jiraIdentifierFieldId ?? ''), jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), jiraSyncRunId: clean(input.jiraSyncRunId ?? existing.jiraSyncRunId ?? ''), client: clean(input.client ?? existing.client ?? ''), jiraClientSyncRunId: clean(input.jiraClientSyncRunId ?? existing.jiraClientSyncRunId ?? ''), crewCode: clean(input.crewCode ?? existing.crewCode ?? ''), type: clean(input.type ?? existing.type ?? 'Other'), manufacturer: clean(input.manufacturer ?? existing.manufacturer ?? ''), model: clean(input.model ?? existing.model ?? ''), serialNumber: clean(input.serialNumber ?? existing.serialNumber ?? ''), assigneeAccountId: clean(input.assigneeAccountId ?? existing.assigneeAccountId ?? ''), assigneeName: clean(input.assigneeName ?? existing.assigneeName ?? ''), assignedAt: clean(input.assignedAt ?? existing.assignedAt ?? ''), status: clean(input.status ?? existing.status ?? 'Available'), location: clean(input.location ?? existing.location ?? ''), purchaseDate: clean(input.purchaseDate ?? existing.purchaseDate ?? ''), warrantyExpiry: clean(input.warrantyExpiry ?? existing.warrantyExpiry ?? ''), notes: clean(input.notes ?? existing.notes ?? ''), customFields: typeof input.customFields === 'object' && input.customFields !== null ? input.customFields : (existing.customFields || {}), createdAt: existing.createdAt || now(), updatedAt: now() };
}
async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...actorFields(), ...event }); }
function faultHistoryKey(assetId,ticket){const label=clean(ticket?.fault||'');if(!label)return'';const fingerprint=createHash('sha256').update(`${ticket?.key||''}:${normaliseName(label)}`).digest('hex').slice(0,16);return `${FAULT_HISTORY_PREFIX}${assetId}:${ticket?.key||'unknown'}:${fingerprint}`;}
// A device's fault figures for Reports, from its tickets: the same counting as getAssetReport
// (faults are primary tickets with the Device Fault field filled in). Stored on the device as
// faultSummary by the Jira scan and the device page, so Reports reads them instead of searching Jira.
function faultSummaryFrom(tickets){
  const byKey=new Map();for(const t of safeArray(tickets)){if(!t?.key)continue;const current=byKey.get(t.key);if(!current||t.relation==='primary')byKey.set(t.key,t);}
  const all=[...byKey.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));
  const primary=all.filter(t=>t.relation==='primary');const faults=primary.filter(t=>clean(t.fault||''));const isOpen=(t)=>!t.resolved&&t.statusCategory!=='done';const open=faults.filter(isOpen).length;const latest=faults[0]||null;
  // The same fault (ignoring case and spacing) on two or more tickets: for the Repeat faults report.
  const groups=new Map();for(const t of faults){const k=normaliseName(t.fault);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(t);}
  const repeats=[...groups.values()].filter(g=>g.length>1).map(g=>({fault:clean(g[0].fault),count:g.length,open:g.filter(isOpen).length,first:g.at(-1).created||'',last:g[0].created||'',keys:g.slice(0,5).map(t=>t.key)})).sort((a,b)=>b.count-a.count||String(b.last).localeCompare(String(a.last)));
  return{total:faults.length,open,resolved:faults.length-open,related:all.filter(t=>t.relation==='related').length,involved:all.length,lastFault:latest?.created||'',latestFaultKey:latest?.key||'',latestFault:latest?clean(latest.fault):'',repeats,updatedAt:now()};
}
const sameFaultSummary=(a,b)=>Boolean(a&&b)&&['total','open','resolved','related','involved','lastFault','latestFaultKey','latestFault'].every(k=>(a[k]??'')===(b[k]??''))&&JSON.stringify(a.repeats)===JSON.stringify(b.repeats);
async function storeFaultSummary(asset,tickets){if(!asset?.id)return;const summary=faultSummaryFrom(tickets);if(sameFaultSummary(asset.faultSummary,summary))return;const current=await kvs.get(`${ASSET_PREFIX}${asset.id}`);if(current)await kvs.set(`${ASSET_PREFIX}${asset.id}`,{...current,faultSummary:summary});}
// Adds the faults of these tickets that the ledger doesn't have yet; entries already there are
// left as first recorded.
async function recordMissingFaultHistory(asset,tickets){for(const ticket of safeArray(tickets)){const key=ticket?.relation==='primary'?faultHistoryKey(asset?.id,ticket):'';if(key&&!(await kvs.get(key)))await recordFaultHistory(asset,ticket,null);}}
async function recordFaultHistory(asset,ticket,knownKeys){const fault=clean(ticket?.fault||'');if(!asset?.id||!ticket?.key||ticket.relation!=='primary'||!fault)return null;const key=faultHistoryKey(asset.id,ticket);if(!key||knownKeys?.has(key))return null;const value={historyKey:key,assetId:asset.id,deviceName:asset.name||'',issueKey:ticket.key,fault,summary:ticket.summary||'',issueCreated:ticket.created||'',firstSeen:now(),statusAtFirstSeen:ticket.status||'',resolvedAtFirstSeen:Boolean(ticket.resolved)||ticket.statusCategory==='done'};await kvs.set(key,value);knownKeys?.add(key);return value;}
async function queryAllByPrefix(prefix,limit=500) { const values = []; let cursor; const cap=Math.max(1,Math.min(Number(limit)||500,1000)); do { let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100,cap-values.length)); if (cursor) query = query.cursor(cursor); const page = await query.getMany(); values.push(...page.results.map((e) => e.value)); cursor = page.nextCursor; } while (cursor&&values.length<cap); return values.slice(0,cap); }
// Device names are unique, checked through the name index that every create and rename keeps up to
// date (one read, however large the register). An index entry whose device was deleted or renamed
// is stale and does not block the name.
async function assertUniqueDeviceName(name, assetId) {
  const normalized = normaliseName(name); if (!normalized) throw new Error('Device name is required.');
  const indexed = await kvs.get(nameIndexKey(name));
  if (!indexed?.assetId || indexed.assetId === assetId) return;
  const holder = await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);
  if (holder && normaliseName(holder.name) === normalized) throw new Error(`Device name “${clean(name)}” already exists. Device names must be unique.`);
}
// options.existing: the stored record when the caller has just read it (saves a read).
// options.extra: fields normaliseAsset does not carry (e.g. jiraAliases), written in the same set.
async function saveOneAsset(supplied, source = 'manual', options = {}) {
  if (!clean(supplied?.name)) throw new Error('Device name is required.');
  const existing = options.existing !== undefined ? options.existing : supplied.id ? await kvs.get(`${ASSET_PREFIX}${supplied.id}`) : null;
  const asset = { ...normaliseAsset(supplied, existing || {}), ...(options.extra || {}) };
  // Assigned since: when the holder changes, the date it changed, unless the caller gave one
  // (options.assignedAt: the ticket's date) or the user typed a different date with the change.
  const text = (v) => String(clean(v) || '');
  const holderKey = (a) => `${text(a?.crewCode)}|${text(a?.assigneeAccountId) || text(a?.assigneeName)}`.toLowerCase();
  const person = (a) => (text(a?.assigneeAccountId) || text(a?.assigneeName)).toLowerCase();
  // Adding the crew code to the same person is not a new assignment.
  const codeAddedOnly = existing && !text(existing.crewCode) && person(existing) && person(existing) === person(asset);
  if (existing && holderKey(existing) !== holderKey(asset) && !(codeAddedOnly && existing.assignedAt)) {
    const typed = text(supplied?.assignedAt) && text(supplied.assignedAt) !== text(existing.assignedAt);
    asset.assignedAt = !holderOf(asset) ? '' : typed ? text(supplied.assignedAt) : (options.assignedAt || now().slice(0, 10));
  } else if (!existing && holderOf(asset) && !asset.assignedAt && options.assignedAt) asset.assignedAt = options.assignedAt;
  if (source !== 'jira-sync' && !asset.curatedAt) asset.curatedAt = asset.updatedAt || now();
  if (source !== 'jira-sync') {
    await assertUniqueDeviceName(asset.name, asset.id);
  }
  const oldNameKey = existing?.name ? nameIndexKey(existing.name) : null;
  const newNameKey = nameIndexKey(asset.name);
  // Independent writes go together rather than one after another.
  await Promise.all([
    kvs.set(`${ASSET_PREFIX}${asset.id}`, asset),
    clean(asset.client) ? kvs.set(`${CLIENT_INDEX_PREFIX}${Buffer.from(normaliseName(asset.client), 'utf8').toString('base64url')}`, { client: clean(asset.client) }) : null,
    kvs.set(newNameKey, { assetId: asset.id, name: asset.name, updatedAt: asset.updatedAt }),
    oldNameKey && oldNameKey !== newNameKey ? kvs.delete(oldNameKey) : null
  ]);
  if (!existing) await addHistory(asset.id, { type: 'created', source, message: source === 'jira-sync' ? 'Asset discovered from Jira' : 'Asset created' });
  else {
    const changes=[];
    if(existing.name!==asset.name)changes.push({field:'device name',from:existing.name||'',to:asset.name||''});
    if(existing.jiraIdentifier!==asset.jiraIdentifier)changes.push({field:asset.jiraIdentifierFieldName||'Jira device identifier',from:existing.jiraIdentifier||'',to:asset.jiraIdentifier||''});
    if(existing.crewCode!==asset.crewCode)changes.push({field:'assignment reference',from:existing.crewCode||'',to:asset.crewCode||''});
    if((existing.assigneeAccountId||existing.assigneeName)!==(asset.assigneeAccountId||asset.assigneeName))changes.push({field:'assigned person',from:existing.assigneeName||existing.crewCode||'Unassigned',to:asset.assigneeName||asset.crewCode||'Unassigned'});
    if((existing.assignedAt||'')!==(asset.assignedAt||''))changes.push({field:'assigned since',from:existing.assignedAt||'',to:asset.assignedAt||''});
    if(existing.type!==asset.type)changes.push({field:'device type',from:existing.type||'',to:asset.type||''});
    if(existing.status!==asset.status)changes.push({field:'status',from:existing.status||'',to:asset.status||''});
    if(existing.location!==asset.location)changes.push({field:'location',from:existing.location||'',to:asset.location||''});
    if(existing.client!==asset.client)changes.push({field:'client',from:existing.client||'',to:asset.client||''});
    if(changes.length)await addHistory(asset.id,{type:'updated',source,message:'Asset updated',changes});
  }
  return asset;
}
function ticketFields(issue, relation='primary', faultFieldId=null, crewFieldId=null, baseFieldId=null) { return { key:issue.key, relation, summary:issue.fields?.summary||'', crewCode:crewFieldId?(fieldValues(issue.fields?.[crewFieldId])[0]||''):'', base:baseFieldId?(fieldValues(issue.fields?.[baseFieldId])[0]||''):'', fault:faultFieldId?fieldValues(issue.fields?.[faultFieldId]).join(', '):'', status:issue.fields?.status?.name||'', statusCategory:issue.fields?.status?.statusCategory?.key||'', issueType:issue.fields?.issuetype?.name||'', priority:issue.fields?.priority?.name||'', assignee:issue.fields?.assignee?.displayName||'', created:issue.fields?.created||'', resolved:issue.fields?.resolutiondate||'', resolution:issue.fields?.resolution?.name||'' }; }
function relatedTicketFields(issue,faultFieldId=null,crewFieldId=null,baseFieldId=null){return faultFieldId||crewFieldId||baseFieldId?ticketFields(issue,'related',faultFieldId,crewFieldId,baseFieldId):ticketFields(issue,'related');}
function fieldValues(value) { if(value==null)return[]; if(Array.isArray(value))return value.flatMap(fieldValues); if(typeof value==='string'||typeof value==='number')return[String(value).trim()].filter(Boolean); if(typeof value==='object'){const candidate=value.value??value.name??value.label??value.displayName??value.objectKey??value.key; return candidate?[String(candidate).trim()]:[];} return[]; }
function relatedIdentifiers(value) {
  if(value==null)return[];
  if(Array.isArray(value))return value.flatMap(relatedIdentifiers);
  if(typeof value==='object')return fieldValues(value).flatMap(relatedIdentifiers);
  return String(value).split(/[,;\n\r]+/).map(v=>v.trim()).filter(validIdentifier);
}
function ticketMatchesConfiguredProject(ticket,settings){const projectKey=clean(settings?.jiraProjectKey||'').toUpperCase();if(!projectKey)return true;const key=clean(ticket?.key||ticket?.issueKey||'').toUpperCase();return key.startsWith(projectKey+'-');}
async function getSettingsValue(){return{...DEFAULT_SETTINGS,...((await kvs.get(SETTINGS_KEY))||{})};}
// Device types match the configured Asset types list ignoring case and spacing, so "tablet" and
// "Tablet" are one type. A type not on the list keeps its first spelling and is added to the list.
function typeCatalog(settings){return{known:new Map(safeArray(settings?.assetTypes).map(t=>[normaliseName(t),clean(t)]).filter(([k])=>k)),added:new Map()};}
function canonicalType(catalog,type){const raw=clean(type||'');const key=normaliseName(raw);if(!key)return raw;const match=catalog.known.get(key)||catalog.added.get(key);if(match)return match;catalog.added.set(key,raw);return raw;}
async function addNewAssetTypes(catalog){
  const types=[...catalog.added.values()];if(!types.length)return[];
  const latest=await getSettingsValue();const merged=[...safeArray(latest.assetTypes)];const keys=new Set(merged.map(normaliseName));const added=[];
  for(const type of types){const key=normaliseName(type);if(key&&!keys.has(key)){merged.push(type);keys.add(key);added.push(type);}}
  if(added.length)await kvs.set(SETTINGS_KEY,{...latest,assetTypes:merged});
  for(const [key,type] of catalog.added)catalog.known.set(key,type);catalog.added.clear();
  return added;
}
async function getJiraCustomFields(){const response=await api.asUser().requestJira(route`/rest/api/3/field`,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`Could not load Jira fields (${response.status}).`);const fields=await response.json();return safeArray(fields).filter(f=>String(f.id||'').startsWith('customfield_')).map(f=>({id:f.id,name:f.name||f.id,schemaType:f.schema?.type||'',customType:f.schema?.custom||''})).sort((a,b)=>a.name.localeCompare(b.name,undefined,{sensitivity:'base'}));}
async function getJiraProjects(){const response=await api.asUser().requestJira(route`/rest/api/3/project/search?maxResults=100&orderBy=name`,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(`Could not load Jira projects (${response.status}).`);const data=await response.json();return safeArray(data.values).map(p=>({id:p.id,key:p.key,name:p.name})).filter(p=>p.key).sort((a,b)=>String(a.name||a.key).localeCompare(String(b.name||b.key),undefined,{sensitivity:'base'}));}
async function resolveJiraAssetField(knownFields){const settings=await getSettingsValue();const fields=knownFields||await getJiraCustomFields();if(settings.jiraAssetField?.id){const selected=fields.find(f=>f.id===settings.jiraAssetField.id);if(selected)return selected;}const preferredNames=['device id','asset id','asset name','device name','asset','device'];return fields.find(f=>preferredNames.includes(normaliseName(f.name)))||null;}
// Settings a Jira scan depends on. Changing any of them invalidates a paused scan;
// editing local lists (types, statuses, locations, custom fields) does not.
const SCAN_SETTING_KEYS=['jiraProjectKey','jiraAssetField','jiraRelatedAssetField','jiraClientField','jiraLocationField','jiraTypeField','jiraCrewCodeField','jiraFaultField','crewMappings'];
function scanSignature(settings){return JSON.stringify(SCAN_SETTING_KEYS.map(key=>{const value=settings?.[key];return value&&typeof value==='object'&&!Array.isArray(value)?value.id||'':value??'';}));}
function projectScope(settings){const projectKey=clean(settings.jiraProjectKey||'').replace(/[^A-Za-z0-9_-]/g,'');return projectKey?`project = \"${projectKey}\" AND `:'';}
function jiraAssetSearchShape(field,settings){const numericId=String(field.id).replace('customfield_','');const scope=projectScope(settings);return{jql:`${scope}cf[${numericId}] is not EMPTY ORDER BY created DESC`,fields:[field.id,settings.jiraRelatedAssetField?.id,settings.jiraClientField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,settings.jiraFaultField?.id,'summary','status','issuetype','priority','assignee','created','resolutiondate','resolution'].filter(Boolean)};}
async function searchIssuePageWithConfiguredAssetField({nextPageToken=null}={}){const settings=await getSettingsValue();const field=await resolveJiraAssetField();if(!field)return{field:null,issues:[],settings,nextPageToken:null};const{jql,fields}=jiraAssetSearchShape(field,settings);const body={jql,fields,maxResults:SYNC_JIRA_PAGE_SIZE};if(nextPageToken)body.nextPageToken=nextPageToken;const response=await api.asUser().requestJira(route`/rest/api/3/search/jql`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Jira asset-field lookup failed with status ${response.status}.`);const data=await response.json();return{field,issues:safeArray(data.issues),settings,nextPageToken:data.nextPageToken||null};}
async function searchIssuesWithConfiguredAssetField(){let page=await searchIssuePageWithConfiguredAssetField();if(!page.field)return{field:null,issues:[],settings:page.settings};const issues=[...page.issues];let nextPageToken=page.nextPageToken,guard=0;while(nextPageToken&&guard<5){page=await searchIssuePageWithConfiguredAssetField({nextPageToken});issues.push(...page.issues);nextPageToken=page.nextPageToken;guard+=1;}return{field:page.field,issues,settings:page.settings,truncated:Boolean(nextPageToken)};}
const TICKET_SEARCH_PAGE_SIZE=100,TICKET_SEARCH_MAX_PAGES=20;
const ISSUE_KEY_PATTERN=/^[A-Z][A-Z0-9_]+-\d+$/;
const jqlString=(value)=>`"${String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')}"`;
// JQL matching only issues that carry one of these identifiers in the field. Text
// fields use a phrase search (a superset, filtered exactly by the caller); option
// fields match exactly. Returns null for field types that cannot be targeted.
function identifierClause(field,values){
  if(!field?.id||!values.length)return null;
  const cf=`cf[${String(field.id).replace('customfield_','')}]`;const custom=String(field.customType||'');
  if(field.schemaType==='string'||/:(textfield|textarea)$/.test(custom))return values.map(v=>`${cf} ~ ${jqlString(`"${v}"`)}`).join(' OR ');
  if(field.schemaType==='option'||/:(select|radiobuttons|multiselect|multicheckboxes)$/.test(custom))return `${cf} in (${values.map(jqlString).join(',')})`;
  return null;
}
// Every configured-project issue that mentions these identifiers in the device or
// related-device field. Falls back to the broad (possibly truncated) scan when a
// field type cannot be targeted; callers must honour `truncated`.
async function searchIssuesForIdentifiers(identifiers,known={}){
  const settings=known.settings||await getSettingsValue();const fields=known.fields||await getJiraCustomFields();const field=await resolveJiraAssetField(fields);
  if(!field)return{field:null,issues:[],settings,truncated:false};
  const values=[...new Set(identifiers.map(clean).filter(validIdentifier))];
  if(!values.length)return{field,issues:[],settings,truncated:false};
  const related=settings.jiraRelatedAssetField?.id?fields.find(f=>f.id===settings.jiraRelatedAssetField.id):null;
  const primaryClause=identifierClause(field,values),relatedClause=related?identifierClause(related,values):null;
  if(!primaryClause||(related&&!relatedClause))return searchIssuesWithConfiguredAssetField();
  const jql=`${projectScope(settings)}(${[primaryClause,relatedClause].filter(Boolean).join(' OR ')}) ORDER BY created DESC`;
  const{fields:wanted}=jiraAssetSearchShape(field,settings);const issues=[];let nextPageToken=null,pages=0;
  do{const body={jql,fields:wanted,maxResults:TICKET_SEARCH_PAGE_SIZE};if(nextPageToken)body.nextPageToken=nextPageToken;const response=await api.asUser().requestJira(route`/rest/api/3/search/jql`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error(`Jira device ticket search failed with status ${response.status}.`);const data=await response.json();issues.push(...safeArray(data.issues));nextPageToken=data.nextPageToken||null;pages+=1;}while(nextPageToken&&pages<TICKET_SEARCH_MAX_PAGES);
  return{field,issues,settings,truncated:Boolean(nextPageToken)};
}
function issueMatchesIdentifier(issue, fieldId, identifier){const target=normaliseName(identifier);return validIdentifier(identifier)&&fieldValues(issue.fields?.[fieldId]).some(v=>normaliseName(v)===target);}
function issueMatchesRelatedIdentifier(issue, fieldId, identifier){if(!fieldId||!validIdentifier(identifier))return false;const target=normaliseName(identifier);return relatedIdentifiers(issue.fields?.[fieldId]).some(v=>normaliseName(v)===target);}
function latestIssueValueForIdentifier(issues,identifierFieldId,identifier,valueFieldId){if(!valueFieldId||!validIdentifier(identifier))return{value:'',issue:null};for(const issue of issues){if(!issueMatchesIdentifier(issue,identifierFieldId,identifier))continue;const value=fieldValues(issue.fields?.[valueFieldId])[0]||'';if(value)return{value,issue};}return{value:'',issue:null};}
function latestFieldValueForIdentifier(issues, identifierFieldId, identifier, valueFieldId){if(!valueFieldId||!validIdentifier(identifier))return'';for(const issue of issues){if(!issueMatchesIdentifier(issue,identifierFieldId,identifier))continue;const value=fieldValues(issue.fields?.[valueFieldId])[0]||'';if(value)return value;}return'';}
function mappedCrewPerson(settings,crewCode){const target=normaliseName(crewCode);return safeArray(settings.crewMappings).find(m=>normaliseName(m.crewCode)===target)||null;}
// Values in the Device ID field: real Device IDs (by the basic checks and the configured format)
// become devices; the rest are returned as `rejected`, with their tickets, for the clean-up report.
// typeOf maps a real Device ID to the device type whose format it matched (for new devices).
function discoveredIdentifiersFromIssues(issues,fieldId,settings={}){
  const compiled=compileDeviceIdPatterns(settings.deviceIdPatterns,settings.assetTypes);const discovered=new Map(),rejected=new Map(),typeOf=new Map();let ignored=0;
  for(const issue of issues)for(const identifier of fieldValues(issue.fields?.[fieldId])){
    const ticketType=settings.jiraTypeField?.id?fieldValues(issue.fields?.[settings.jiraTypeField.id])[0]||'':'';
    const check=checkDeviceId(identifier,compiled,ticketType);if(!check)continue;
    const normalized=normaliseName(identifier);
    if(!check.ok){ignored+=1;const entry=rejected.get(normalized)||{value:clean(identifier),reason:check.reason,issueKeys:new Set()};if(issue.key)entry.issueKeys.add(issue.key);rejected.set(normalized,entry);continue;}
    if(!discovered.has(normalized))discovered.set(normalized,identifier);
    if(check.type&&!typeOf.has(normalized))typeOf.set(normalized,check.type);
  }
  return{identifiers:[...discovered.values()],ignored,rejected,typeOf};
}
// Adds one page's rejected values to their review records. Counts restart with each scan run, so a
// record shows how many tickets carry the value now. Ignored values stay ignored; a value that was
// fixed but turns up again is reopened.
async function recordRejectedDeviceIds(rejected,runId){
  await Promise.all([...rejected.values()].map(async(entry)=>{
    const key=deviceIdReviewKey(entry.value);const existing=await kvs.get(key);const sameRun=existing?.runId===runId;
    const sample=[...new Set([...(sameRun?safeArray(existing.issueKeys):[]),...entry.issueKeys])].slice(0,10);
    const status=existing?.status==='ignored'?'ignored':'open';
    await kvs.set(key,{...(existing||{}),value:existing?.value||entry.value,reason:entry.reason,runId,ticketCount:(sameRun?Number(existing.ticketCount||0):0)+entry.issueKeys.size,issueKeys:sample,status,firstSeen:existing?.firstSeen||now(),lastSeen:now()});
  }));
}
async function findAssetForJiraIdentifier(fieldId,identifier){const deterministicId=makeJiraAssetId(fieldId,identifier);let asset=await kvs.get(`${ASSET_PREFIX}${deterministicId}`);if(asset)return asset;const indexed=await kvs.get(nameIndexKey(identifier));if(indexed?.assetId)asset=await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);return asset||null;}
async function recordScannedTicketsForAsset(asset,issues,field,settings,runId){if(!asset?.id||!field?.id)return;const identifier=asset.jiraIdentifier||asset.name||'';if(!validIdentifier(identifier))return;const client=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraClientField?.id);if(client&&asset.jiraClientSyncRunId!==runId)asset=await saveOneAsset({...asset,client,jiraClientSyncRunId:runId},'jira-sync');for(const issue of issues){let relation='';if(issueMatchesIdentifier(issue,field.id,identifier))relation='primary';else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,identifier))relation='related';if(!relation)continue;const ticket=ticketFields(issue,relation,settings.jiraFaultField?.id,settings.jiraCrewCodeField?.id,settings.jiraLocationField?.id);await kvs.set(`${ASSET_TICKET_PREFIX}${asset.id}:${issue.key}:${relation}`,{assetId:asset.id,...ticket,recordedAt:now()});if(relation==='primary'&&ticket.fault)await recordMissingFaultHistory(asset,[ticket]);}const recorded=(await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${asset.id}:`,1000)).filter(t=>ticketMatchesConfiguredProject(t,settings));await storeFaultSummary(asset,recorded);}
async function syncAssetsFromJira({restart=false}={}){
  const previous=await kvs.get(SYNC_KEY);
  let progress=await kvs.get(SYNC_PROGRESS_KEY);
  if(!restart&&!progress&&previous?.complete)return previous;
  if(restart){progress=null;await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);}
  // A saved page token only belongs to the query it came from; discard it if the
  // mapped field or scanned project changed since the scan was paused.
  if(progress){const[currentField,currentSettings]=await Promise.all([resolveJiraAssetField(),getSettingsValue()]);if(progress.fieldId!==currentField?.id||(progress.projectKey!==undefined&&progress.projectKey!==(currentSettings.jiraProjectKey||''))){progress=null;await kvs.delete(SYNC_PROGRESS_KEY);}}
  let page=await searchIssuePageWithConfiguredAssetField({nextPageToken:progress?.nextPageToken||null});
  const{field,issues,settings}=page;
  if(!field){const result={timestamp:now(),field:null,issuesScanned:0,discovered:0,processed:0,created:0,matched:0,ignored:0,reconciled:0,complete:true};await kvs.set(SYNC_KEY,result);await kvs.delete(SYNC_PROGRESS_KEY);return result;}
  if(!progress||progress.fieldId!==field.id){progress={fieldId:field.id,projectKey:settings.jiraProjectKey||'',runId:`${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,nextPageToken:null,issuesScanned:0,discovered:0,created:0,matched:0,ignored:0,reconciled:0,startedAt:now()};if(page.nextPageToken===null&&issues.length===0){const result={timestamp:now(),field,issuesScanned:0,discovered:0,processed:0,created:0,matched:0,ignored:0,reconciled:0,complete:true};await kvs.set(SYNC_KEY,result);return result;}}
  const{identifiers,ignored,rejected,typeOf}=discoveredIdentifiersFromIssues(issues,field.id,settings);await recordRejectedDeviceIds(rejected,progress.runId);const types=typeCatalog(settings);
  let batchCreated=0,batchMatched=0,batchDiscovered=0,batchConflicts=0;
  for(const identifier of identifiers){
    let asset=await findAssetForJiraIdentifier(field.id,identifier);
    const alreadyProcessed=asset?.jiraSyncRunId===progress.runId;
    if(!alreadyProcessed)batchDiscovered+=1;
    const location=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraLocationField?.id);const type=canonicalType(types,latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraTypeField?.id));const{value:crewCode,issue:crewIssue}=latestIssueValueForIdentifier(issues,field.id,identifier,settings.jiraCrewCodeField?.id);const crewPerson=crewCode?mappedCrewPerson(settings,crewCode):null;const holderName=crewCode?(crewPerson?.displayName||crewCode):'';const holderAccountId=crewPerson?.accountId||'';const base={jiraIdentifier:identifier,jiraIdentifierFieldId:field.id,jiraIdentifierFieldName:field.name,jiraSyncRunId:progress.runId};
    if(asset){const locationUpdate=Boolean(location&&(!alreadyProcessed||!clean(asset.location)));const typeUpdate=Boolean(type&&(!alreadyProcessed||!clean(asset.type)||asset.type==='Other'));// A ticket only fills in a missing holder. When the device already has a different holder the
    // ticket may be a handover, someone reporting for a colleague, or a mistyped Device ID, so it is
    // recorded as a conflict for review instead of reassigning the device.
    const holder=crewCode?compareHolder(asset,crewCode,holderName,holderAccountId):null;const crewUpdate=Boolean(holder&&(!holder.hasHolder||(holder.same&&!clean(asset.crewCode))));
    if(holder?.hasHolder&&!alreadyProcessed){if(holder.same)await kvs.delete(HOLDER_CONFLICT_PREFIX+asset.id);else if(await recordHolderConflict(asset,crewIssue,{crewCode,holderName,holderAccountId}))batchConflicts+=1;}if(!alreadyProcessed||locationUpdate||typeUpdate||crewUpdate){asset=await saveOneAsset({...asset,...base,...(locationUpdate?{location}:{}),...(typeUpdate?{type}:{}),...(crewUpdate?{crewCode,assigneeName:holderName,assigneeAccountId:holderAccountId}:{})},'jira-sync',crewUpdate?{assignedAt:dateOnly(crewIssue?.fields?.created)}:{});}if(!alreadyProcessed)batchMatched+=1;}else{asset=await saveOneAsset({id:makeJiraAssetId(field.id,identifier),name:identifier,...base,type:type||typeOf.get(normaliseName(identifier))||'Other',status:'In Use',location:location||'',crewCode:crewCode||'',assigneeAccountId:holderAccountId,assigneeName:holderName,notes:`Discovered automatically from Jira field “${field.name}”.`},'jira-sync',{assignedAt:crewCode?dateOnly(crewIssue?.fields?.created):''});batchCreated+=1;}
    await recordScannedTicketsForAsset(asset,issues,field,settings,progress.runId);
  }
  await addNewAssetTypes(types);
  progress={...progress,nextPageToken:page.nextPageToken,issuesScanned:progress.issuesScanned+issues.length,discovered:progress.discovered+batchDiscovered,created:progress.created+batchCreated,matched:progress.matched+batchMatched,ignored:progress.ignored+ignored,conflicts:(progress.conflicts||0)+batchConflicts};
  const complete=!page.nextPageToken;const processed=progress.created+progress.matched;const result={timestamp:now(),...(complete?{faultSummaryVersion:FAULT_SUMMARY_VERSION}:{}),field,issuesScanned:progress.issuesScanned,discovered:progress.discovered,processed,created:progress.created,matched:progress.matched,ignored:progress.ignored,reconciled:progress.reconciled,conflicts:progress.conflicts||0,complete};if(complete){await kvs.set(SYNC_KEY,result);await kvs.delete(SYNC_PROGRESS_KEY);}else await kvs.set(SYNC_PROGRESS_KEY,progress);return result;
}
// Tickets for one device, including identifiers it had before a CSV merge
// (jiraAliases). `truncated` means the result may be incomplete.
async function searchAssetTicketsDetailed(assetId,legacyKeys=[]){
  const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);const matched=new Map();let truncated=false;
  const identifiers=[asset?.jiraIdentifier||asset?.name||'',...safeArray(asset?.jiraAliases)].filter(validIdentifier);
  if(identifiers.length){
    const found=await searchIssuesForIdentifiers(identifiers);const{field,issues,settings}=found;truncated=Boolean(found.truncated);
    if(field){for(const issue of issues){if(identifiers.some(id=>issueMatchesIdentifier(issue,field.id,id)))matched.set(issue.key,ticketFields(issue,'primary',settings.jiraFaultField?.id,settings.jiraCrewCodeField?.id,settings.jiraLocationField?.id));else if(identifiers.some(id=>issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,id)))matched.set(issue.key,relatedTicketFields(issue,settings.jiraFaultField?.id,settings.jiraCrewCodeField?.id,settings.jiraLocationField?.id));}}
  }
  const missingKeys=legacyKeys.filter(k=>ISSUE_KEY_PATTERN.test(k)&&!matched.has(k));
  if(missingKeys.length>100)truncated=true;
  if(missingKeys.length){const response=await api.asUser().requestJira(route`/rest/api/3/search/jql`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({jql:`key in (${missingKeys.slice(0,100).join(',')}) ORDER BY created DESC`,fields:['summary','status','issuetype','priority','assignee','created','resolutiondate','resolution'],maxResults:100})});if(response.ok){const data=await response.json();for(const issue of safeArray(data.issues))matched.set(issue.key,ticketFields(issue,'linked'));}}
  return{tickets:[...matched.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||''))),truncated};
}
async function searchAssetTickets(assetId,legacyKeys=[]){return(await searchAssetTicketsDetailed(assetId,legacyKeys)).tickets;}
resolver.define('listAssetsPage',async({payload})=>{
  const query=String(payload?.query||'').trim().toLowerCase(),status=clean(payload?.status||''),type=clean(payload?.type||''),location=clean(payload?.location||''),client=clean(payload?.client||'');
  const limit=Math.min(500,Math.max(1,Number(payload?.limit||100)));
  const maxScanPages=Math.min(10,Math.max(1,Number(payload?.maxScanPages||1)));
  let cursor=payload?.cursor||null,items=[],scanned=0,pages=0;
  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();scanned+=page.results.length;pages+=1;cursor=page.nextCursor||null;for(const entry of page.results){const a=entry.value;const matchesQuery=!query||[a.id,a.name,a.jiraIdentifier,a.crewCode,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location,a.client].some(v=>String(v||'').toLowerCase().includes(query));if(!matchesQuery)continue;if(status&&a.status!==status)continue;if(type&&a.type!==type)continue;if(location&&a.location!==location)continue;if(client&&String(a.client||'')!==String(client))continue;items.push(a);if(items.length>=limit)break;}if(items.length>=limit)break;}while(cursor&&pages<maxScanPages);
  return{items:items.slice(0,limit),nextCursor:cursor,scanned,pages,complete:!cursor};
});
resolver.define('countAssetsPage',async({payload})=>{
  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));
  const maxPages=Math.min(10,Math.max(1,Number(payload?.pages||1)));
  const items=[];let cursor=payload?.cursor||null,pages=0;
  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(limit);if(cursor)q=q.cursor(cursor);const result=await q.getMany();items.push(...result.results.map(e=>e.value));cursor=result.nextCursor||null;pages+=1;}while(cursor&&pages<maxPages);
  const page={nextCursor:cursor};
  const byType={};
  for(const a of items){const key=clean(a?.type||'Other')||'Other';byType[key]=(byType[key]||0)+1;}
  return{count:items.length,nextCursor:page.nextCursor||null,inUse:items.filter(a=>['In Use','Assigned','Active'].includes(a?.status)).length,available:items.filter(a=>a?.status==='Available').length,repair:items.filter(a=>['Repair','In Repair'].includes(a?.status)).length,byType};
});
// One page of a read-only Jira scan: which Device IDs are already devices, which a real scan would
// add, and which values it would reject. Devices are not touched; rejected values are recorded for
// the clean-up report. The UI passes runId and nextPageToken back until nextPageToken is empty.
resolver.define('previewJiraScan',async({payload})=>{
  const page=await searchIssuePageWithConfiguredAssetField({nextPageToken:clean(payload?.nextPageToken||'')||null});
  if(!page.field)throw new Error('Map the Jira Device ID field in Configuration before previewing a scan.');
  const runId=clean(payload?.runId||'')||`preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const{identifiers,rejected,typeOf}=discoveredIdentifiersFromIssues(page.issues,page.field.id,page.settings);
  await recordRejectedDeviceIds(rejected,runId);
  const registered=await Promise.all(identifiers.map(id=>findAssetForJiraIdentifier(page.field.id,id)));
  return{runId,issuesScanned:page.issues.length,nextPageToken:page.nextPageToken,
    found:identifiers.map((identifier,i)=>({identifier,registered:Boolean(registered[i]),type:typeOf.get(normaliseName(identifier))||''})),
    rejected:[...rejected.values()].map(e=>({value:e.value,reason:e.reason,tickets:e.issueKeys.size}))};
});
resolver.define('syncAssetsFromJira',async({payload})=>syncAssetsFromJira({restart:Boolean(payload?.restart)}));
resolver.define('getStatusAutomationLog',async()=>(await kvs.get(STATUS_AUTOMATION_LOG_KEY))||[]);
resolver.define('getSyncStatus',async()=>await kvs.get(SYNC_PROGRESS_KEY)||await kvs.get(SYNC_KEY)||null);
resolver.define('getJiraCustomFields',async()=>getJiraCustomFields());
resolver.define('getJiraProjects',async()=>getJiraProjects());
resolver.define('getJiraClientOptions',async()=>{const values=new Set((await queryAllByPrefix(CLIENT_INDEX_PREFIX,1000)).map(e=>clean(e?.client||'')).filter(Boolean));let cursor=null,guard=0;do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();for(const entry of safeArray(page?.results)){const value=clean(entry?.value?.client||'');if(value)values.add(value);}cursor=page?.nextCursor||null;guard+=1;}while(cursor&&guard<10);return [...values].sort((a,b)=>String(a).localeCompare(String(b),undefined,{sensitivity:'base'}));});
resolver.define('getAsset',async({payload})=>payload?.id?kvs.get(`${ASSET_PREFIX}${payload.id}`):null);resolver.define('saveAsset',async({payload})=>saveOneAsset(payload?.asset||{},'manual'));
resolver.define('bulkImportAssets',async({payload})=>{
  const rows=safeArray(payload?.assets);
  if(!rows.length)return{imported:0,failed:[],deviceTypesAdded:[]};
  const initialSettings=await getSettingsValue();
  const knownTypes=new Map(safeArray(initialSettings.assetTypes).map(type=>[normaliseName(type),clean(type)]).filter(([key])=>key));
  const discoveredTypes=new Map();
  const failed=[];let imported=0;
  for(let i=0;i<rows.length;i+=1){
    const rawType=clean(rows[i]?.type||'');
    const typeKey=normaliseName(rawType);
    const canonicalType=typeKey?(knownTypes.get(typeKey)||discoveredTypes.get(typeKey)||rawType):rows[i]?.type;
    try{
      await saveOneAsset({...rows[i],...(typeKey?{type:canonicalType}:{})},'bulk-import');
      imported+=1;
      if(typeKey&&!knownTypes.has(typeKey)&&!discoveredTypes.has(typeKey))discoveredTypes.set(typeKey,rawType);
    }catch(error){failed.push({row:i+2,deviceName:clean(rows[i]?.name||''),message:error?.message||'Import failed'});}
  }
  const deviceTypesAdded=[...discoveredTypes.values()];
  if(deviceTypesAdded.length){
    const latestSettings=await getSettingsValue();
    const mergedTypes=[...safeArray(latestSettings.assetTypes)];
    const mergedKeys=new Set(mergedTypes.map(normaliseName));
    for(const type of deviceTypesAdded){const key=normaliseName(type);if(key&&!mergedKeys.has(key)){mergedTypes.push(type);mergedKeys.add(key);}}
    await kvs.set(SETTINGS_KEY,{...latestSettings,assetTypes:mergedTypes});
  }
  return{imported,failed,deviceTypesAdded};
});
resolver.define('deleteAsset',async({payload})=>{if(!payload?.id)throw new Error('Asset id is required.');const asset=await kvs.get(`${ASSET_PREFIX}${payload.id}`);if(!asset)return{ok:true};const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===payload.id).map(l=>l.issueKey).filter(Boolean);let search;try{search=await searchAssetTicketsDetailed(payload.id,legacyKeys);}catch{throw new Error('Could not verify whether this device is linked to Jira tickets. Please try again before deleting it.');}const linkedTickets=search.tickets;if(linkedTickets.length)throw new Error(`This device is linked to ${linkedTickets.length} Jira ticket${linkedTickets.length===1?'':'s'}. Clear the configured Jira asset field or unlink those tickets before deleting the device.`);if(search.truncated)throw new Error('Could not check every Jira ticket for this device (the mapped Jira field type cannot be searched directly, or the device has more than 2,000 tickets), so it has not been deleted.');await kvs.delete(`${ASSET_PREFIX}${payload.id}`);if(asset.name){const indexed=await kvs.get(nameIndexKey(asset.name));if(indexed?.assetId===payload.id)await kvs.delete(nameIndexKey(asset.name));}await addHistory(payload.id,{type:'deleted',source:'manual',message:'Asset deleted',deviceName:asset.name});return{ok:true};});
resolver.define('bulkRemoveAssets',async({payload})=>{
  const ids=[...new Set(safeArray(payload?.ids).map(clean).filter(Boolean))];
  const discoveredOnly=payload?.discoveredOnly===true;
  const removeAllDiscovered=payload?.removeAllDiscovered===true;
  const cursor=clean(payload?.cursor||'')||null;
  let targets=[];let nextCursor=null;let scanned=0;let kept=0;const skipped=[];
  if(removeAllDiscovered){
    // Cleanup of junk discovery: every target has Jira tickets by definition, so the
    // linked-ticket guard does not apply. Assets a person has confirmed are kept.
    let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);
    if(cursor)q=q.cursor(cursor);
    const page=await q.getMany();scanned=page.results.length;nextCursor=page.nextCursor||null;
    const candidates=page.results.map(e=>e.value).filter(isUncuratedJiraDiscovery);
    const confirmed=await Promise.all(candidates.map(markCuratedFromHistory));
    targets=candidates.filter((_,i)=>!confirmed[i]);kept=confirmed.filter(Boolean).length;
  }else{
    // Selected assets get the same protection as single delete: anything with
    // linked or recorded Jira tickets is skipped and reported back.
    if(ids.length>BULK_REMOVE_BATCH)throw new Error(`Remove at most ${BULK_REMOVE_BATCH} assets per request.`);
    const assets=(await Promise.all(ids.map(id=>kvs.get(`${ASSET_PREFIX}${id}`)))).filter(Boolean);
    const linkedIds=new Set((await queryAllByPrefix(LINK_PREFIX)).map(l=>l?.assetId).filter(Boolean));
    const recorded=await Promise.all(assets.map(a=>kvs.query().where('key',WhereConditions.beginsWith(`${ASSET_TICKET_PREFIX}${a.id}:`)).limit(1).getMany()));
    assets.forEach((asset,i)=>{if(linkedIds.has(asset.id)||recorded[i].results.length)skipped.push({id:asset.id,name:asset.name||'',reason:'Linked to Jira tickets'});else targets.push(asset);});
  }
  if(discoveredOnly)targets=targets.filter(isUncuratedJiraDiscovery);
  const source=removeAllDiscovered?'jira-cleanup':'bulk-remove';
  await Promise.all(targets.map(async(asset)=>{
    await kvs.delete(`${ASSET_PREFIX}${asset.id}`);
    if(asset.name){const indexed=await kvs.get(nameIndexKey(asset.name));if(indexed?.assetId===asset.id)await kvs.delete(nameIndexKey(asset.name));}
    await addHistory(asset.id,{type:'deleted',source,message:'Asset deleted',deviceName:asset.name||''});
  }));
  const removed=targets.length;
  if(removeAllDiscovered){const cfg=await getSettingsValue();if(cfg.jiraDiscoveryEnabled!==false)await kvs.set(SETTINGS_KEY,{...cfg,jiraDiscoveryEnabled:false});}
  await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);
  return{ok:true,removed,kept,skipped,scanned,nextCursor,complete:!nextCursor,jiraDiscoveryPaused:removeAllDiscovered};
});

function reconciliationValue(value){
  const raw=String(clean(value)||'').trim();
  const normal=normaliseName(raw);
  if(!normal||['.','-','n/a','na','none','null','unknown'].includes(normal))return'';
  if(/^[?._\-\s]+$/.test(raw)||/^0+$/.test(raw))return'';
  return raw;
}
function isJiraDiscoveredAsset(asset){return String(asset?.notes||'').startsWith('Discovered automatically from Jira field');}
async function reconciliationCandidateByName(name){
  const value=reconciliationValue(name);if(!value)return null;
  const indexed=await kvs.get(nameIndexKey(value));
  return indexed?.assetId?await kvs.get(ASSET_PREFIX+indexed.assetId):null;
}
async function reconciliationCandidateByIdentifier(fieldId,value){
  const match=reconciliationValue(value);if(!fieldId||!match)return null;
  return await findAssetForJiraIdentifier(fieldId,match);
}
async function classifyImportRow(row,settings){
  const fieldId=settings.jiraAssetField?.id||'';
  // The three lookups are independent.
  const [byName,byDevice,bySerial]=await Promise.all([reconciliationCandidateByName(row?.name),reconciliationCandidateByIdentifier(fieldId,row?.jiraIdentifier),reconciliationCandidateByIdentifier(fieldId,row?.serialNumber)]);
  const candidates=[byDevice,bySerial,byName].filter(Boolean);
  const unique=[...new Map(candidates.map(asset=>[asset.id,asset])).values()];
  if(unique.length>1){return{action:'review',message:'Multiple existing assets match this row. Review before importing.',candidateIds:unique.map(a=>a.id),existing:unique.map(a=>({id:a.id,name:a.name,jiraIdentifier:a.jiraIdentifier,serialNumber:a.serialNumber}))};}
  const existing=unique[0]||null;
  if(!existing)return{action:'create',message:'Create new asset.',existing:null};
  if(bySerial?.id===existing.id&&normaliseName(row?.serialNumber)!==normaliseName(row?.jiraIdentifier||''))return{action:'merge-serial',message:'Merge Jira-discovered record “'+existing.name+'” using matching serial number.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  if(byDevice?.id===existing.id)return{action:'update-device-id',message:'Update existing asset “'+existing.name+'” by Device ID.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  return{action:'update-name',message:'Update existing asset “'+existing.name+'” by device name.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
}
// The fields of an import row that have a value; custom fields likewise.
function filledImportFields(row){
  const filled=Object.fromEntries(Object.entries(row||{}).filter(([k,v])=>k!=='customFields'&&v!==null&&v!==undefined&&String(v).trim()!==''));
  const custom=Object.fromEntries(Object.entries(row?.customFields||{}).filter(([,v])=>v!==null&&v!==undefined&&String(v).trim()!==''));
  return Object.keys(custom).length?{...filled,customFields:custom}:filled;
}
function importRowUnchanged(row,existing){
  const same=(a,b)=>String(a??'').trim()===String(b??'').trim();
  return Object.entries(row).every(([k,v])=>k==='customFields'?Object.entries(v).every(([ck,cv])=>same(cv,existing.customFields?.[ck])):same(v,existing[k]));
}
// Import rows processed in parallel per call (each row is several storage calls).
const IMPORT_CONCURRENCY=8;
resolver.define('previewAssetImportReconciliation',async({payload})=>{
  const rows=safeArray(payload?.assets).slice(0,500);
  const settings=await getSettingsValue();
  // Read-only, so rows are classified in parallel; results keep the row order.
  const results=new Array(rows.length);let next=0;
  const worker=async()=>{while(next<rows.length){const i=next++;results[i]={index:i,...await classifyImportRow(rows[i],settings)};}};
  await Promise.all(Array.from({length:Math.min(IMPORT_CONCURRENCY,rows.length)},worker));
  return results;
});
resolver.define('reconcileAssetImport',async({payload})=>{
  const settings=await getSettingsValue();const types=typeCatalog(settings);
  const rows=safeArray(payload?.assets).slice(0,100).map(row=>row?.type?{...row,type:canonicalType(types,row.type)}:row);
  let created=0,updated=0,merged=0,unchanged=0;const failed=[];
  // Rows run IMPORT_CONCURRENCY at a time. Rows that resolve to the same existing device, or create the
  // same Device Name, share a lock so they are applied one after another.
  const locks=new Map();
  // fn receives true when an earlier row in this batch shares the key.
  const withLock=(key,fn)=>{const prev=locks.get(key);const go=()=>fn(Boolean(prev));const run=(prev||Promise.resolve()).then(go,go);locks.set(key,run.catch(()=>{}));return run;};
  const importRow=async(row)=>{
    if(!clean(row.name))throw new Error('Device Name is required.');
    const match=await classifyImportRow(row,settings);
    if(match.action==='review')throw new Error(match.message);
    const lockKey=match.existing?.id?`asset:${match.existing.id}`:`name:${normaliseName(row.name)}`;
    return withLock(lockKey,async(shared)=>{
      // A row that looked new may have been created by an earlier row in this batch; check again.
      if(shared&&!match.existing?.id){const again=await classifyImportRow(row,settings);if(again.action==='review')throw new Error(again.message);Object.assign(match,again);}
      const existing=match.existing?.id?await kvs.get(ASSET_PREFIX+match.existing.id):null;
      if(!existing){await saveOneAsset(row,'import',{existing:null});return 'created';}
      // Updating a device: empty cells leave its values alone, and a row that changes nothing
      // is not written (re-importing a whole register then costs reads only).
      row=filledImportFields(row);
      if(row.customFields)row={...row,customFields:{...(existing.customFields||{}),...row.customFields}};
      if(match.action!=='merge-serial'&&importRowUnchanged(row,existing))return 'unchanged';
      const oldName=existing.name||'';const oldIdentifier=existing.jiraIdentifier||existing.name||'';
      const aliases=[...new Set([...safeArray(existing.jiraAliases),oldIdentifier].map(reconciliationValue).filter(Boolean).filter(v=>normaliseName(v)!==normaliseName(row.jiraIdentifier||row.name||'')))];
      const saved=await saveOneAsset({...row,id:existing.id},'import-reconcile',{existing,extra:{jiraAliases:aliases,notes:clean(row.notes)||existing.notes||''}});
      if(match.action==='merge-serial'){
        await addHistory(saved.id,{type:'merged',source:'import-reconcile',message:'Merged Jira-discovered record '+(oldIdentifier||oldName)+' into '+saved.name+' during CSV reconciliation',fromDevice:oldName,fromIdentifier:oldIdentifier,matchedBy:'serial-number'});
        return 'merged';
      }
      await addHistory(saved.id,{type:'import-update',source:'import-reconcile',message:'Updated '+saved.name+' from CSV import',matchedBy:match.action==='update-device-id'?'device-id':'device-name'});
      return 'updated';
    });
  };
  let next=0;
  const worker=async()=>{while(next<rows.length){const i=next++;const row=rows[i]||{};try{const outcome=await importRow(row);if(outcome==='created')created+=1;else if(outcome==='merged')merged+=1;else if(outcome==='unchanged')unchanged+=1;else updated+=1;}catch(error){failed.push({index:i,name:row?.name||'',error:error?.message||'Import reconciliation failed.'});}}};
  await Promise.all(Array.from({length:Math.min(IMPORT_CONCURRENCY,rows.length)},worker));
  failed.sort((a,b)=>a.index-b.index);
  const deviceTypesAdded=await addNewAssetTypes(types);
  return{processed:rows.length,created,updated,merged,unchanged,failed,deviceTypesAdded};
});

function holderOf(asset){return clean(asset?.assigneeName)||clean(asset?.crewCode)||'';}
// hasHolder: the device already has someone recorded. same: the ticket names that same person.
function compareHolder(asset,crewCode,holderName,holderAccountId){
  const current=clean(asset?.crewCode);const hasHolder=Boolean(current||clean(asset?.assigneeName)||clean(asset?.assigneeAccountId));
  const same=current?normaliseName(current)===normaliseName(crewCode):Boolean((holderAccountId&&asset.assigneeAccountId===holderAccountId)||(clean(asset?.assigneeName)&&normaliseName(asset.assigneeName)===normaliseName(holderName)));
  return{hasHolder,same};
}
// Returns true when a new conflict was opened. A conflict someone chose to keep is not reopened by the
// same ticket naming the same person; a different ticket or person opens it again.
async function recordHolderConflict(asset,issue,ticket){
  const key=HOLDER_CONFLICT_PREFIX+asset.id;const existing=await kvs.get(key);
  const sameEvidence=existing&&existing.issueKey===(issue?.key||'')&&normaliseName(existing.ticketCrewCode)===normaliseName(ticket.crewCode);
  if(sameEvidence&&(existing.status==='kept'||existing.status==='open'))return false;
  await kvs.set(key,{assetId:asset.id,deviceName:asset.name||'',deviceId:asset.jiraIdentifier||asset.name||'',currentCrewCode:clean(asset.crewCode),currentHolder:holderOf(asset),ticketCrewCode:ticket.crewCode,ticketHolder:ticket.holderName||ticket.crewCode,ticketHolderAccountId:ticket.holderAccountId||'',issueKey:issue?.key||'',issueSummary:clean(issue?.fields?.summary||''),issueCreated:issue?.fields?.created||'',status:'open',detectedAt:now()});
  return true;
}
resolver.define('getDataConflicts',async()=>{
  const records=await queryAllByPrefix(HOLDER_CONFLICT_PREFIX,1000);const conflicts=[];let kept=0;
  for(let i=0;i<records.length;i+=25){
    const batch=records.slice(i,i+25);const assets=await Promise.all(batch.map(c=>kvs.get(ASSET_PREFIX+c.assetId)));
    await Promise.all(batch.map(async(c,j)=>{
      const asset=assets[j];
      // Drop conflicts that no longer apply: the device was deleted or now has the ticket's holder.
      if(!asset||compareHolder(asset,c.ticketCrewCode,c.ticketHolder,c.ticketHolderAccountId).same){await kvs.delete(HOLDER_CONFLICT_PREFIX+c.assetId);return;}
      if(c.status==='kept'){kept+=1;return;}
      conflicts.push({...c,deviceName:asset.name||c.deviceName,currentCrewCode:clean(asset.crewCode),currentHolder:holderOf(asset)});
    }));
  }
  conflicts.sort((a,b)=>String(b.detectedAt).localeCompare(String(a.detectedAt)));
  return{conflicts,kept,truncated:records.length>=1000};
});
resolver.define('resolveDataConflict',async({payload,context})=>{
  const assetId=clean(payload?.assetId||'');const action=payload?.action;
  if(!assetId||!['accept','keep'].includes(action))throw new Error('Choose a device and whether to use the ticket holder or keep the current one.');
  const conflict=await kvs.get(HOLDER_CONFLICT_PREFIX+assetId);if(!conflict||conflict.status!=='open')throw new Error('This conflict has already been resolved. Refresh the list.');
  const asset=await kvs.get(ASSET_PREFIX+assetId);if(!asset){await kvs.delete(HOLDER_CONFLICT_PREFIX+assetId);throw new Error('This device no longer exists.');}
  const by=clean(context?.accountId||'');const ticket=conflict.issueKey||'a Jira ticket';
  if(action==='accept'){
    const saved=await saveOneAsset({...asset,crewCode:conflict.ticketCrewCode,assigneeName:conflict.ticketHolder,assigneeAccountId:conflict.ticketHolderAccountId||''},'conflict-review',{existing:asset,assignedAt:dateOnly(conflict.issueCreated)});
    await addHistory(assetId,{type:'holder-conflict-accepted',source:'conflict-review',issueKey:conflict.issueKey,resolvedBy:by,message:`Holder changed from ${holderOf(asset)||'unassigned'} to ${conflict.ticketHolder} after reviewing ${ticket}`});
    await kvs.delete(HOLDER_CONFLICT_PREFIX+assetId);
    return{ok:true,asset:saved};
  }
  await kvs.set(HOLDER_CONFLICT_PREFIX+assetId,{...conflict,status:'kept',resolvedAt:now(),resolvedBy:by});
  await addHistory(assetId,{type:'holder-conflict-kept',source:'conflict-review',issueKey:conflict.issueKey,resolvedBy:by,message:`Kept holder ${holderOf(asset)||'unassigned'}; ${ticket} named ${conflict.ticketHolder}`});
  return{ok:true};
});
// Who has had this device: its tickets (with the crew code each was raised under) and its holder
// changes, newest first, with a summary per crew code.
resolver.define('getDeviceTimeline',async({payload})=>{
  const assetId=clean(payload?.assetId||'');if(!assetId)return null;
  const asset=await kvs.get(ASSET_PREFIX+assetId);if(!asset)return null;
  let tickets=[],truncated=false,live=true,searchError='';
  // One retry: a busy Jira (429) often answers a second later.
  try{({tickets,truncated}=await searchAssetTicketsDetailed(assetId).catch(async()=>{await new Promise(r=>setTimeout(r,1500));return searchAssetTicketsDetailed(assetId);}));}
  catch(e){live=false;searchError=clean(e?.message||'')||'Jira search failed';const byKey=new Map();for(const t of await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`))if(!byKey.has(t.key)||t.relation==='primary')byKey.set(t.key,t);tickets=[...byKey.values()];}
  const history=await queryAllByPrefix(`${HISTORY_PREFIX}${assetId}:`,1000);
  const names=await jiraUserNames(history.map(h=>h.changedBy||h.resolvedBy));
  const named=history.map(h=>{const by=h.changedBy||h.resolvedBy;return by&&names.get(by)?{...h,changedByName:names.get(by)}:h;});
  return{...buildDeviceTimeline(asset,tickets,named),truncated,live,searchError};
});
// Bulk holder review, one page of open holder conflicts per call. A device is a candidate when
// its newest minTickets or more tickets (as recorded by the Jira scan) were all raised under one
// crew code that isn't its holder, the newest on or after since. apply: move those devices to
// that person, assigned since the first ticket of that run. Kept conflicts are left alone.
const BULK_CONFLICT_PAGE=40;
resolver.define('bulkHolderConflicts',async({payload,context})=>{
  const settings=await getSettingsValue();const minTickets=Math.max(1,Math.min(Number(payload?.minTickets)||2,20));const since=dateOnly(payload?.since);const apply=payload?.apply===true;
  let q=kvs.query().where('key',WhereConditions.beginsWith(HOLDER_CONFLICT_PREFIX)).limit(BULK_CONFLICT_PAGE);const cursor=clean(payload?.cursor||'');if(cursor)q=q.cursor(cursor);
  const page=await q.getMany();const conflicts=safeArray(page.results).map(r=>r.value).filter(c=>c?.assetId&&c.status==='open');
  const candidates=[];let applied=0;const by=clean(context?.accountId||'');
  await Promise.all(conflicts.map(async(c)=>{
    const[asset,tickets]=await Promise.all([kvs.get(ASSET_PREFIX+c.assetId),queryAllByPrefix(`${ASSET_TICKET_PREFIX}${c.assetId}:`,200)]);
    if(!asset)return;
    const run=bulkCandidate(asset,tickets.filter(t=>ticketMatchesConfiguredProject(t,settings)),{minTickets,since});if(!run)return;
    const person=mappedCrewPerson(settings,run.crewCode);const holderName=person?.displayName||run.crewCode;
    const row={assetId:asset.id,deviceName:asset.name||'',deviceId:asset.jiraIdentifier||asset.name||'',currentHolder:holderOf(asset),currentCrewCode:clean(asset.crewCode),proposedCrewCode:run.crewCode,proposedHolder:holderName,tickets:run.count,since:run.since,until:run.until,issueKeys:run.issueKeys.slice(0,5)};
    candidates.push(row);
    if(!apply)return;
    await saveOneAsset({...asset,crewCode:run.crewCode,assigneeName:holderName,assigneeAccountId:person?.accountId||''},'bulk-holder-review',{existing:asset,assignedAt:dateOnly(run.since)});
    await addHistory(asset.id,{type:'holder-bulk-accepted',source:'bulk-holder-review',resolvedBy:by,issueKey:run.issueKeys[0]||'',message:`Holder changed from ${row.currentHolder||'unassigned'} to ${holderName}: the last ${run.count} tickets (${run.issueKeys.slice(0,3).join(', ')}${run.count>3?', …':''}) were raised by ${run.crewCode}`});
    applied+=1;
  }));
  candidates.sort((a,b)=>String(b.until).localeCompare(String(a.until)));
  return{checked:conflicts.length,candidates,applied,nextCursor:page.nextCursor||null};
});
// One page of the register: devices whose type differs only in case or spacing from a known type
// are changed to that spelling. The UI calls this until nextCursor is empty.
resolver.define('tidyAssetTypes',async({payload})=>{
  const types=typeCatalog(await getSettingsValue());
  let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);const cursor=clean(payload?.cursor||'');if(cursor)q=q.cursor(cursor);
  const page=await q.getMany();let changed=0;
  for(const {value:asset} of safeArray(page.results)){
    if(!asset?.id||!clean(asset.type))continue;
    const type=canonicalType(types,asset.type);if(type===asset.type)continue;
    await kvs.set(ASSET_PREFIX+asset.id,{...asset,type,updatedAt:now()});
    await addHistory(asset.id,{type:'updated',source:'type-tidy',message:'Device type matched to the Asset types list',changes:[{field:'device type',from:asset.type,to:type}]});
    changed+=1;
  }
  const typesAdded=await addNewAssetTypes(types);
  return{scanned:page.results.length,changed,typesAdded,nextCursor:page.nextCursor||null};
});
// Open fault tickets across the whole scanned project, counted by Jira in one request: tickets with a
// device and a fault, not resolved and not done (the same rule as the fault report). count is null
// when Jira cannot count, so the Overview falls back to the devices it has loaded.
resolver.define('getOpenFaultCount',async()=>{
  const settings=await getSettingsValue();
  if(!settings.jiraFaultField?.id)return{count:0,configured:false};
  const field=await resolveJiraAssetField().catch(()=>null);if(!field)return{count:null,configured:true};
  const id=(f)=>String(f).replace('customfield_','');
  const jql=`${projectScope(settings)}cf[${id(field.id)}] is not EMPTY AND cf[${id(settings.jiraFaultField.id)}] is not EMPTY AND resolution is EMPTY AND statusCategory != Done`;
  try{const response=await api.asUser().requestJira(route`/rest/api/3/search/approximate-count`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({jql})});if(!response.ok)return{count:null,configured:true};const body=await response.json();return{count:Number.isFinite(body?.count)?body.count:null,configured:true};}
  catch{return{count:null,configured:true};}
});
// The clean-up list: values in the Device ID field that are not Device IDs, each with a suggested
// device when the value is a registered device's serial number, name, old ID, or contains its ID.
const REVIEW_ASSET_PAGES=100;
async function deviceLookup(){
  const byId=new Map(),bySerial=new Map();let cursor=null,pages=0;
  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();pages+=1;cursor=page.nextCursor||null;
    for(const {value:a} of safeArray(page.results)){if(!a?.id)continue;
      for(const v of [a.jiraIdentifier,a.name,...safeArray(a.jiraAliases)])if(clean(v)&&!byId.has(normaliseName(v)))byId.set(normaliseName(v),a);
      if(clean(a.serialNumber)&&!bySerial.has(normaliseName(a.serialNumber)))bySerial.set(normaliseName(a.serialNumber),a);}
  }while(cursor&&pages<REVIEW_ASSET_PAGES);
  return{byId,bySerial,partial:Boolean(cursor)};
}
function suggestDevice(value,lookup){
  const key=normaliseName(value);const pick=(a,matchedBy)=>({assetId:a.id,deviceId:a.jiraIdentifier||a.name,name:a.name,matchedBy});
  if(lookup.bySerial.has(key))return pick(lookup.bySerial.get(key),'serial number');
  if(lookup.byId.has(key))return pick(lookup.byId.get(key),'device name or earlier ID');
  for(const token of String(value).split(/[\s,;/|=^:]+/).map(normaliseName).filter(t=>t.length>=4)){
    if(lookup.byId.has(token))return pick(lookup.byId.get(token),'Device ID inside the value');
    if(lookup.bySerial.has(token))return pick(lookup.bySerial.get(token),'serial number inside the value');
  }
  return null;
}
resolver.define('getDeviceIdReview',async()=>{
  const records=await queryAllByPrefix(DEVICE_ID_REVIEW_PREFIX,1000);
  // Checked again against the format as saved now: a value the format has since been widened to
  // accept (e.g. a new "EXS_@#####" line) leaves the list.
  const settings=await getSettingsValue();const compiled=compileDeviceIdPatterns(settings.deviceIdPatterns,settings.assetTypes);
  const nowValid=records.filter(r=>r.status==='open'&&checkDeviceId(r.value,compiled)?.ok);
  await Promise.all(nowValid.map(r=>kvs.delete(deviceIdReviewKey(r.value))));
  const open=records.filter(r=>r.status==='open'&&!nowValid.includes(r));const lookup=await deviceLookup();
  const values=open.map(r=>({...r,suggestion:suggestDevice(r.value,lookup)})).sort((a,b)=>Number(b.ticketCount||0)-Number(a.ticketCount||0)||String(a.value).localeCompare(String(b.value)));
  return{values,nowValid:nowValid.length,ignored:records.filter(r=>r.status==='ignored').length,fixed:records.filter(r=>r.status==='fixed'||r.status==='cleared').length,suggestionsPartial:lookup.partial,truncated:records.length>=1000};
});
// JQL finding tickets whose Device ID field holds this exact value (filtered exactly afterwards).
function exactValueClause(field,value){
  const cf=`cf[${String(field.id).replace('customfield_','')}]`;const custom=String(field.customType||'');
  if(field.schemaType==='string'||/:(textfield|textarea)$/.test(custom))return `${cf} ~ ${jqlString(`"${value}"`)}`;
  if(field.schemaType==='option'||field.schemaType==='array'||/:(select|radiobuttons|multiselect|multicheckboxes|labels)$/.test(custom))return `${cf} = ${jqlString(value)}`;
  return null;
}
// The field's new content: the bad value replaced by (or, when replacement is null, removed in favour
// of) the right one. Multi-value fields keep their other values.
function replacedFieldValue(field,current,bad,replacement){
  const isBad=(v)=>normaliseName(typeof v==='object'&&v!==null?(v.value??v.name??''):v)===normaliseName(bad);
  if(Array.isArray(current)){const kept=current.filter(v=>!isBad(v)).map(v=>typeof v==='object'&&v!==null?{value:v.value??v.name}:v);const next=replacement?[...kept,current.some(v=>typeof v==='object'&&v!==null)?{value:replacement}:replacement]:kept;return next.length?next:null;}
  if(!replacement)return null;
  if(field.schemaType==='option'||/:(select|radiobuttons)$/.test(String(field.customType||'')))return{value:replacement};
  return replacement;
}
const DEVICE_ID_FIX_BATCH=50;
// Fixes (writes the right Device ID), clears, ignores or reopens one value. Fix and clear work on up
// to 50 tickets per call; the UI calls again while `remaining` is true.
resolver.define('resolveDeviceIdValue',async({payload,context})=>{
  const value=clean(payload?.value||'');const action=payload?.action;
  if(!value||!['fix','clear','ignore','reopen'].includes(action))throw new Error('Choose a value and what to do with it.');
  const key=deviceIdReviewKey(value);const record=await kvs.get(key);if(!record)throw new Error('This value is no longer on the list. Refresh it.');
  const by=clean(context?.accountId||'');
  if(action==='ignore'||action==='reopen'){await kvs.set(key,{...record,status:action==='ignore'?'ignored':'open',resolvedBy:by,resolvedAt:now()});return{ok:true};}
  const settings=await getSettingsValue();const fields=await getJiraCustomFields();const field=await resolveJiraAssetField(fields);
  if(!field)throw new Error('Map the Jira Device ID field in Configuration first.');
  let device=null,replacement=null;
  if(action==='fix'){
    device=await findAssetForJiraIdentifier(field.id,clean(payload?.deviceId||''));
    if(!device)throw new Error(`“${clean(payload?.deviceId||'')}” is not a device in Asset Manager. Choose a registered device.`);
    replacement=device.jiraIdentifier||device.name;
    const check=checkDeviceId(replacement,compileDeviceIdPatterns(settings.deviceIdPatterns,settings.assetTypes),device.type||'');
    if(!check?.ok)throw new Error(`${replacement} does not pass the Device ID format rule (${check?.reason||'empty'}).`);
  }
  const clause=exactValueClause(field,value);
  if(!clause)throw new Error(`The ${field.name} field type cannot be searched, so these tickets need fixing in Jira: ${safeArray(record.issueKeys).join(', ')}.`);
  const jql=`${projectScope(settings)}${clause} ORDER BY created DESC`;
  const response=await api.asUser().requestJira(route`/rest/api/3/search/jql`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({jql,fields:[field.id],maxResults:100})});
  if(!response.ok)throw new Error(`Jira could not search for this value (${response.status}). Fix these tickets in Jira: ${safeArray(record.issueKeys).join(', ')}.`);
  const data=await response.json();
  const matching=safeArray(data.issues).filter(issue=>fieldValues(issue.fields?.[field.id]).some(v=>normaliseName(v)===normaliseName(value)));
  // Jira's text search skips some words ("N/A", very short values), so it can miss tickets the scan saw.
  if(!matching.length)return{updated:[],failed:[],remaining:false,done:false,notFound:true,issueKeys:safeArray(record.issueKeys)};
  const batch=matching.slice(0,DEVICE_ID_FIX_BATCH);const updated=[],failed=[];
  for(const issue of batch){
    const next=replacedFieldValue(field,issue.fields?.[field.id],value,replacement);
    try{const put=await api.asUser().requestJira(route`/rest/api/3/issue/${issue.key}`,{method:'PUT',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({fields:{[field.id]:next}})});
      if(put.ok)updated.push(issue.key);else{let detail='';try{detail=JSON.stringify(await put.json()).slice(0,200);}catch{}failed.push({key:issue.key,error:`Jira returned ${put.status}${detail?`: ${detail}`:''}`});}}
    catch(error){failed.push({key:issue.key,error:error?.message||'Update failed'});}
  }
  const remaining=matching.length>batch.length||Boolean(data.nextPageToken);
  if(device&&updated.length)await addHistory(device.id,{type:'device-id-fix',source:'device-id-cleanup',message:`Device ID set to ${replacement} on ${updated.join(', ')} (was “${value}”)`,issueKeys:updated});
  const done=!remaining&&!failed.length;
  await kvs.set(key,{...record,...(done?{status:action==='fix'?'fixed':'cleared',fixedTo:replacement||'',ticketCount:0}:{}),resolvedBy:by,resolvedAt:now()});
  return{updated,failed,remaining,done,notFound:false};
});
// Display names for account ids, in one Jira call per 100 people. Missing names are left out;
// the history still shows the change.
async function jiraUserNames(accountIds){
  const ids=[...new Set(accountIds.filter(Boolean))];const names=new Map();
  for(let i=0;i<ids.length;i+=100){
    const query=new URLSearchParams([['maxResults','100'],...ids.slice(i,i+100).map(id=>['accountId',id])]);
    try{const response=await api.asUser().requestJira(route`/rest/api/3/user/bulk?${query}`,{headers:{Accept:'application/json'}});if(!response.ok)continue;const body=await response.json();for(const user of safeArray(body?.values))if(user?.accountId)names.set(user.accountId,user.displayName||'');}catch{}
  }
  return names;
}
resolver.define('getAssetHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${HISTORY_PREFIX}${payload.assetId}:`,1000);const names=await jiraUserNames(history.map(h=>h.changedBy||h.resolvedBy));return history.map(h=>{const by=h.changedBy||h.resolvedBy;return by&&names.get(by)?{...h,changedByName:names.get(by)}:h;}).sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));});
resolver.define('getFaultHistory',async({payload})=>{if(!payload?.assetId)return[];const settings=await getSettingsValue();const history=await queryAllByPrefix(`${FAULT_HISTORY_PREFIX}${payload.assetId}:`,1000);return history.filter(item=>ticketMatchesConfiguredProject(item,settings)).sort((a,b)=>String(b.issueCreated||b.firstSeen||'').localeCompare(String(a.issueCreated||a.firstSeen||'')));});
resolver.define('getSettings',async()=>getSettingsValue());
resolver.define('saveSettings',async({payload})=>{const incoming=payload?.settings||{};const previousSettings=await getSettingsValue();const normaliseField=(f)=>f?.id?{id:clean(f.id),name:clean(f.name||f.id)}:null;const settings={assetTypes:safeArray(incoming.assetTypes).map(clean).filter(Boolean),statuses:safeArray(incoming.statuses).map(clean).filter(Boolean),locations:safeArray(incoming.locations).map(clean).filter(Boolean),customFields:safeArray(incoming.customFields).map(f=>({key:clean(f.key)||clean(f.label),label:clean(f.label)||clean(f.key),type:['text','date'].includes(clean(f.type))?clean(f.type):'text'})).filter(f=>f.key&&f.label),jiraAssetField:normaliseField(incoming.jiraAssetField),jiraRelatedAssetField:normaliseField(incoming.jiraRelatedAssetField),jiraLocationField:normaliseField(incoming.jiraLocationField),jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraClientField:normaliseField(incoming.jiraClientField),jiraProjectKey:clean(incoming.jiraProjectKey||''),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:safeArray(incoming.crewMappings).map(m=>({crewCode:clean(m.crewCode),accountId:clean(m.accountId),displayName:clean(m.displayName)})).filter(m=>m.crewCode&&(m.displayName||m.accountId)),jiraDiscoveryEnabled:incoming.jiraDiscoveryEnabled!==false,deviceIdPatterns:safeArray(incoming.deviceIdPatterns).map(clean).filter(Boolean).slice(0,20),fillTicketTypeFromRegister:incoming.fillTicketTypeFromRegister!==false};if(!settings.assetTypes.length)settings.assetTypes=DEFAULT_SETTINGS.assetTypes;if(!settings.statuses.length)settings.statuses=DEFAULT_SETTINGS.statuses;settings.statusAutomationEnabled=incoming.statusAutomationEnabled===true;settings.statusRules=normaliseStatusRules(incoming.statusRules,settings.statuses);settings.replacement=normaliseReplacementSettings(incoming.replacement,settings.statuses);const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');const previousProjectKey=clean(previousSettings?.jiraProjectKey||'');const nextProjectKey=clean(settings?.jiraProjectKey||'');if(previousFaultFieldId!==nextFaultFieldId||previousProjectKey!==nextProjectKey){const cachedTickets=await queryAllByPrefix(ASSET_TICKET_PREFIX);for(const ticket of cachedTickets){if(ticket?.assetId&&ticket?.key&&ticket?.relation)await kvs.delete(`${ASSET_TICKET_PREFIX}${ticket.assetId}:${ticket.key}:${ticket.relation}`);}const faultHistory=await queryAllByPrefix(FAULT_HISTORY_PREFIX);for(const item of faultHistory){if(item?.historyKey)await kvs.delete(item.historyKey);}console.log('Device Fault mapping changed; cleared cached ticket/fault data');}await kvs.set(SETTINGS_KEY,settings);if(scanSignature(previousSettings)!==scanSignature(settings)){await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);}return settings;});
resolver.define('searchUsers',async({payload})=>{const q=clean(payload?.query||'');if(!q||q.length<2)return[];const response=await api.asUser().requestJira(route`/rest/api/3/user/search?query=${q}&maxResults=20`,{headers:{Accept:'application/json'}});if(!response.ok)return[];const users=await response.json();return users.filter(u=>u.active!==false&&u.accountType!=='app').map(u=>({accountId:u.accountId,displayName:u.displayName,avatarUrl:u.avatarUrls?.['24x24']||''}));});
resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const settings=await getSettingsValue();const recorded=(await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`)).filter(ticket=>ticketMatchesConfiguredProject(ticket,settings));const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId&&ticketMatchesConfiguredProject({key:l.issueKey},settings)).map(l=>l.issueKey).filter(Boolean);
  // Live, targeted search first: the tickets recorded by sync are never pruned, so they go stale when a
  // ticket's device changes. Fall back to them only when Jira cannot be searched.
  try{const tickets=await searchAssetTickets(assetId,legacyKeys);const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);if(asset){await recordMissingFaultHistory(asset,tickets);await storeFaultSummary(asset,tickets);}return tickets;}catch{}
  const byKey=new Map();for(const ticket of recorded){const current=byKey.get(ticket.key);if(!current||ticket.relation==='primary')byKey.set(ticket.key,ticket);}for(const key of legacyKeys)if(!byKey.has(key))byKey.set(key,{key,relation:'linked'});return [...byKey.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));});
// Report rows for one batch of assets (the UI pages through the register in batches of
// REPORT_BATCH). Tickets come from a targeted search for these assets' identifiers, in
// chunks so each JQL stays small. `truncated` means some tickets may be missing.
const REPORT_BATCH=100,REPORT_IDENTIFIER_CHUNK=50;
// Reports: up to 2,000 devices per call, slimmed to what the Reports screens use, each with the
// fault figures saved by the Jira scan (faultSummary). No Jira search, so a large register loads
// in a few calls. Devices the scan hasn't reached yet have no faultSummary.
const REPORT_PAGE_KVS_PAGES=20;
// A Jira scan finished since repeat faults were counted has saved figures for every device with a
// ticket, so a device without figures has no tickets. The first page says whether one has.

resolver.define('getReportPage',async({payload})=>{
  let cursor=clean(payload?.cursor||'')||null,pages=0;const items=[];
  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();items.push(...safeArray(page.results).map(r=>r.value).filter(Boolean));cursor=page.nextCursor||null;pages+=1;}while(cursor&&pages<REPORT_PAGE_KVS_PAGES);
  const pick=(a)=>({id:a.id,name:a.name||'',jiraIdentifier:a.jiraIdentifier||'',type:a.type||'',manufacturer:a.manufacturer||'',model:a.model||'',serialNumber:a.serialNumber||'',assigneeName:a.assigneeName||'',crewCode:a.crewCode||'',status:a.status||'',location:a.location||'',client:a.client||'',purchaseDate:a.purchaseDate||'',warrantyExpiry:a.warrantyExpiry||'',assignedAt:a.assignedAt||'',faultSummary:a.faultSummary||null});
  const first=!clean(payload?.cursor||'');const last=first?await kvs.get(SYNC_KEY):null;
  return{items:items.map(pick),nextCursor:cursor,...(first?{scan:{complete:Boolean(last?.complete&&last?.faultSummaryVersion>=FAULT_SUMMARY_VERSION),timestamp:last?.timestamp||''}}:{})};
});
resolver.define('getAssetReport',async({payload}={})=>{
  const ids=[...new Set(safeArray(payload?.assetIds).map(clean).filter(Boolean))];
  // The asset list's Fault column reads only; the Reports screen records fault history.
  const recordHistory=payload?.recordHistory!==false;
  if(ids.length>REPORT_BATCH)throw new Error(`Request report rows for at most ${REPORT_BATCH} assets at a time.`);
  const assets=ids.length?(await (async()=>{const out=[];for(let i=0;i<ids.length;i+=25)out.push(...await Promise.all(ids.slice(i,i+25).map(id=>kvs.get(`${ASSET_PREFIX}${id}`))));return out;})()).filter(Boolean):await queryAllByPrefix(ASSET_PREFIX,REPORT_BATCH);
  if(!assets.length)return{rows:[],truncated:false};const rows=[];let truncated=false;
  let field=null,issues=[],settings=await getSettingsValue();
  const identifiers=[...new Set(assets.flatMap(a=>[a.jiraIdentifier||a.name,...safeArray(a.jiraAliases)]).map(reconciliationValue).filter(Boolean))];
  try{const known={settings,fields:await getJiraCustomFields()};const seen=new Set();for(let i=0;i<identifiers.length;i+=REPORT_IDENTIFIER_CHUNK){const found=await searchIssuesForIdentifiers(identifiers.slice(i,i+REPORT_IDENTIFIER_CHUNK),known);field=found.field;settings=found.settings;if(found.truncated)truncated=true;for(const issue of found.issues)if(!seen.has(issue.key)){seen.add(issue.key);issues.push(issue);}if(!field)break;}}catch{truncated=true;}
  const ticketsByIdentifier=new Map();
  const addTicket=(identifier,ticket,relation)=>{if(!validIdentifier(identifier))return;const key=normaliseName(identifier);if(!ticketsByIdentifier.has(key))ticketsByIdentifier.set(key,new Map());const current=ticketsByIdentifier.get(key).get(ticket.key);if(!current||relation==='primary')ticketsByIdentifier.get(key).set(ticket.key,{...ticket,relation});};
  if(field){for(const issue of issues){const ticket=ticketFields(issue,'primary',settings.jiraFaultField?.id);for(const identifier of fieldValues(issue.fields?.[field.id]))addTicket(identifier,ticket,'primary');if(settings.jiraRelatedAssetField?.id)for(const identifier of relatedIdentifiers(issue.fields?.[settings.jiraRelatedAssetField.id]))addTicket(identifier,ticket,'related');}}
  for(const asset of assets){const identifiers=[asset.jiraIdentifier||asset.name,...safeArray(asset.jiraAliases)].map(reconciliationValue).filter(Boolean);const mergedTickets=new Map();for(const identifier of identifiers){for(const ticket of ticketsByIdentifier.get(normaliseName(identifier))?.values()||[]){const current=mergedTickets.get(ticket.key);if(!current||ticket.relation==='primary')mergedTickets.set(ticket.key,ticket);}}const tickets=[...mergedTickets.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));const primary=tickets.filter(t=>t.relation==='primary');const related=tickets.filter(t=>t.relation==='related');const faults=primary.filter(t=>clean(t.fault||''));const open=faults.filter(t=>!t.resolved&&t.statusCategory!=='done').length;if(recordHistory)for(const ticket of faults){const key=faultHistoryKey(asset.id,ticket);if(key&&!(await kvs.get(key)))await recordFaultHistory(asset,ticket,null);}rows.push({assetId:asset.id,name:asset.name,type:asset.type,status:asset.status,assigneeName:asset.assigneeName||asset.crewCode||'',total:faults.length,related:related.length,involved:tickets.length,open,resolved:faults.length-open,lastFault:faults.find(t=>t.created)?.created||'',latestFault:faults[0]||null,error:false});}
  return{rows:rows.sort((a,b)=>(b.total??-1)-(a.total??-1)||String(b.lastFault||'').localeCompare(String(a.lastFault||''))||String(a.name).localeCompare(String(b.name))),truncated};
});
export const handler = resolver.getDefinitions();