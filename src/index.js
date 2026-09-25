import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { guardResolver } from './auth.js';

// Actions that change configuration, run Jira discovery or write many assets
// at once. Everyday create/edit and guarded single delete stay open to users.
const ADMIN_RESOLVERS = new Set(['saveSettings', 'syncAssetsFromJira', 'bulkImportAssets', 'previewAssetImportReconciliation', 'reconcileAssetImport', 'bulkRemoveAssets']);
const resolver = guardResolver(new Resolver(), ADMIN_RESOLVERS);
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
const LINK_PREFIX = 'issue-link:';
const ASSET_TICKET_PREFIX = 'asset-ticket:';
const HISTORY_PREFIX = 'asset-history:';
const FAULT_HISTORY_PREFIX = 'fault-history:';
const SETTINGS_KEY = 'settings:asset-manager';
const SYNC_KEY = 'sync:asset-manager:jira-field';
const SYNC_PROGRESS_KEY = 'sync-progress:asset-manager:jira-field';
const SYNC_JIRA_PAGE_SIZE = 25;

const DEFAULT_SETTINGS = {
  assetTypes: ['Laptop', 'Desktop', 'Mobile', 'Tablet', 'Monitor', 'Printer', 'Accessory', 'Other'],
  statuses: ['Ordered', 'Available', 'In Use', 'Repair', 'Lost', 'Retired'],
  locations: [], customFields: [], jiraAssetField: null,
  jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null, jiraClientField: null, jiraProjectKey: '',
  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true
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
  return { ...existing, id: clean(input.id || existing.id || makeAssetId()), name: clean(input.name ?? existing.name ?? ''), jiraIdentifier: clean(input.jiraIdentifier ?? existing.jiraIdentifier ?? ''), jiraIdentifierFieldId: clean(input.jiraIdentifierFieldId ?? existing.jiraIdentifierFieldId ?? ''), jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), jiraSyncRunId: clean(input.jiraSyncRunId ?? existing.jiraSyncRunId ?? ''), client: clean(input.client ?? existing.client ?? ''), jiraClientSyncRunId: clean(input.jiraClientSyncRunId ?? existing.jiraClientSyncRunId ?? ''), crewCode: clean(input.crewCode ?? existing.crewCode ?? ''), type: clean(input.type ?? existing.type ?? 'Other'), manufacturer: clean(input.manufacturer ?? existing.manufacturer ?? ''), model: clean(input.model ?? existing.model ?? ''), serialNumber: clean(input.serialNumber ?? existing.serialNumber ?? ''), assigneeAccountId: clean(input.assigneeAccountId ?? existing.assigneeAccountId ?? ''), assigneeName: clean(input.assigneeName ?? existing.assigneeName ?? ''), status: clean(input.status ?? existing.status ?? 'Available'), location: clean(input.location ?? existing.location ?? ''), purchaseDate: clean(input.purchaseDate ?? existing.purchaseDate ?? ''), warrantyExpiry: clean(input.warrantyExpiry ?? existing.warrantyExpiry ?? ''), notes: clean(input.notes ?? existing.notes ?? ''), customFields: typeof input.customFields === 'object' && input.customFields !== null ? input.customFields : (existing.customFields || {}), createdAt: existing.createdAt || now(), updatedAt: now() };
}
async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event }); }
function faultHistoryKey(assetId,ticket){const label=clean(ticket?.fault||'');if(!label)return'';const fingerprint=createHash('sha256').update(`${ticket?.key||''}:${normaliseName(label)}`).digest('hex').slice(0,16);return `${FAULT_HISTORY_PREFIX}${assetId}:${ticket?.key||'unknown'}:${fingerprint}`;}
async function recordFaultHistory(asset,ticket,knownKeys){const fault=clean(ticket?.fault||'');if(!asset?.id||!ticket?.key||ticket.relation!=='primary'||!fault)return null;const key=faultHistoryKey(asset.id,ticket);if(!key||knownKeys?.has(key))return null;const value={historyKey:key,assetId:asset.id,deviceName:asset.name||'',issueKey:ticket.key,fault,summary:ticket.summary||'',issueCreated:ticket.created||'',firstSeen:now(),statusAtFirstSeen:ticket.status||'',resolvedAtFirstSeen:Boolean(ticket.resolved)||ticket.statusCategory==='done'};await kvs.set(key,value);knownKeys?.add(key);return value;}
async function queryAllByPrefix(prefix,limit=500) { const values = []; let cursor; const cap=Math.max(1,Math.min(Number(limit)||500,1000)); do { let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100,cap-values.length)); if (cursor) query = query.cursor(cursor); const page = await query.getMany(); values.push(...page.results.map((e) => e.value)); cursor = page.nextCursor; } while (cursor&&values.length<cap); return values.slice(0,cap); }
async function assertUniqueDeviceName(name, assetId) { const normalized = normaliseName(name); if (!normalized) throw new Error('Device name is required.'); const indexed = await kvs.get(nameIndexKey(name)); if (indexed?.assetId && indexed.assetId !== assetId) throw new Error(`Device name “${clean(name)}” already exists. Device names must be unique.`); const assets = await queryAllByPrefix(ASSET_PREFIX); const duplicate = assets.find((a) => a.id !== assetId && normaliseName(a.name) === normalized); if (duplicate) throw new Error(`Device name “${clean(name)}” already exists. Device names must be unique.`); }
async function assertIndexedUniqueDeviceName(name, assetId) { const normalized = normaliseName(name); if (!normalized) throw new Error('Device name is required.'); const indexed = await kvs.get(nameIndexKey(name)); if (indexed?.assetId && indexed.assetId !== assetId) throw new Error(`Device name “${clean(name)}” already exists. Device names must be unique.`); }
async function saveOneAsset(supplied, source = 'manual') {
  if (!clean(supplied?.name)) throw new Error('Device name is required.');
  const existing = supplied.id ? await kvs.get(`${ASSET_PREFIX}${supplied.id}`) : null;
  const asset = normaliseAsset(supplied, existing || {});
  if (source !== 'jira-sync' && !asset.curatedAt) asset.curatedAt = asset.updatedAt || now();
  if (source !== 'jira-sync') {
    const fastImportSources=new Set(['bulk-import','import','import-reconcile']);
    if(fastImportSources.has(source)) await assertIndexedUniqueDeviceName(asset.name,asset.id);
    else await assertUniqueDeviceName(asset.name, asset.id);
  }
  const oldNameKey = existing?.name ? nameIndexKey(existing.name) : null;
  const newNameKey = nameIndexKey(asset.name);
  await kvs.set(`${ASSET_PREFIX}${asset.id}`, asset);
  await kvs.set(newNameKey, { assetId: asset.id, name: asset.name, updatedAt: asset.updatedAt });
  if (oldNameKey && oldNameKey !== newNameKey) await kvs.delete(oldNameKey);
  if (!existing) await addHistory(asset.id, { type: 'created', source, message: source === 'jira-sync' ? 'Asset discovered from Jira' : 'Asset created' });
  else {
    const changes=[];
    if(existing.name!==asset.name)changes.push({field:'device name',from:existing.name||'',to:asset.name||''});
    if(existing.jiraIdentifier!==asset.jiraIdentifier)changes.push({field:asset.jiraIdentifierFieldName||'Jira device identifier',from:existing.jiraIdentifier||'',to:asset.jiraIdentifier||''});
    if(existing.crewCode!==asset.crewCode)changes.push({field:'assignment reference',from:existing.crewCode||'',to:asset.crewCode||''});
    if((existing.assigneeAccountId||existing.assigneeName)!==(asset.assigneeAccountId||asset.assigneeName))changes.push({field:'assigned person',from:existing.assigneeName||existing.crewCode||'Unassigned',to:asset.assigneeName||asset.crewCode||'Unassigned'});
    if(existing.type!==asset.type)changes.push({field:'device type',from:existing.type||'',to:asset.type||''});
    if(existing.status!==asset.status)changes.push({field:'status',from:existing.status||'',to:asset.status||''});
    if(existing.location!==asset.location)changes.push({field:'location',from:existing.location||'',to:asset.location||''});
    if(existing.client!==asset.client)changes.push({field:'client',from:existing.client||'',to:asset.client||''});
    if(changes.length)await addHistory(asset.id,{type:'updated',source,message:'Asset updated',changes});
  }
  return asset;
}
function ticketFields(issue, relation='primary', faultFieldId=null) { return { key:issue.key, relation, summary:issue.fields?.summary||'', fault:faultFieldId?fieldValues(issue.fields?.[faultFieldId]).join(', '):'', status:issue.fields?.status?.name||'', statusCategory:issue.fields?.status?.statusCategory?.key||'', issueType:issue.fields?.issuetype?.name||'', priority:issue.fields?.priority?.name||'', assignee:issue.fields?.assignee?.displayName||'', created:issue.fields?.created||'', resolved:issue.fields?.resolutiondate||'', resolution:issue.fields?.resolution?.name||'' }; }
function relatedTicketFields(issue,faultFieldId=null){return faultFieldId?ticketFields(issue,'related',faultFieldId):ticketFields(issue,'related');}
function fieldValues(value) { if(value==null)return[]; if(Array.isArray(value))return value.flatMap(fieldValues); if(typeof value==='string'||typeof value==='number')return[String(value).trim()].filter(Boolean); if(typeof value==='object'){const candidate=value.value??value.name??value.label??value.displayName??value.objectKey??value.key; return candidate?[String(candidate).trim()]:[];} return[]; }
function relatedIdentifiers(value) {
  if(value==null)return[];
  if(Array.isArray(value))return value.flatMap(relatedIdentifiers);
  if(typeof value==='object')return fieldValues(value).flatMap(relatedIdentifiers);
  return String(value).split(/[,;\n\r]+/).map(v=>v.trim()).filter(validIdentifier);
}
function ticketMatchesConfiguredProject(ticket,settings){const projectKey=clean(settings?.jiraProjectKey||'').toUpperCase();if(!projectKey)return true;const key=clean(ticket?.key||ticket?.issueKey||'').toUpperCase();return key.startsWith(projectKey+'-');}
async function getSettingsValue(){return{...DEFAULT_SETTINGS,...((await kvs.get(SETTINGS_KEY))||{})};}
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
async function searchIssuesForIdentifiers(identifiers){
  const settings=await getSettingsValue();const fields=await getJiraCustomFields();const field=await resolveJiraAssetField(fields);
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
function latestFieldValueForIdentifier(issues, identifierFieldId, identifier, valueFieldId){if(!valueFieldId||!validIdentifier(identifier))return'';for(const issue of issues){if(!issueMatchesIdentifier(issue,identifierFieldId,identifier))continue;const value=fieldValues(issue.fields?.[valueFieldId])[0]||'';if(value)return value;}return'';}
function mappedCrewPerson(settings,crewCode){const target=normaliseName(crewCode);return safeArray(settings.crewMappings).find(m=>normaliseName(m.crewCode)===target)||null;}
async function reconcileJiraAssets(){
  const assets=await queryAllByPrefix(ASSET_PREFIX);
  const links=await queryAllByPrefix(LINK_PREFIX);
  const groups=new Map();
  let removed=0;
  for(const asset of assets){
    const autoDiscovered=String(asset.notes||'').startsWith('Discovered automatically from Jira field');
    const identifier=asset.jiraIdentifier||asset.name||'';
    if(autoDiscovered&&!validIdentifier(identifier)){
      await kvs.delete(`${ASSET_PREFIX}${asset.id}`);
      if(asset.name){const indexed=await kvs.get(nameIndexKey(asset.name));if(indexed?.assetId===asset.id)await kvs.delete(nameIndexKey(asset.name));}
      removed+=1;continue;
    }
    if(!validIdentifier(asset.jiraIdentifier))continue;
    const key=normaliseName(asset.jiraIdentifier);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(asset);
  }
  for(const group of groups.values()){
    if(group.length<2)continue;
    group.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||''))||String(a.id).localeCompare(String(b.id)));
    const canonical=group[0];
    for(const duplicate of group.slice(1)){
      for(const link of links.filter(l=>l?.assetId===duplicate.id)){await kvs.set(`${LINK_PREFIX}${link.issueKey}`,{...link,assetId:canonical.id,deviceName:canonical.name});}
      await kvs.delete(`${ASSET_PREFIX}${duplicate.id}`);
      removed+=1;
    }
    await kvs.set(nameIndexKey(canonical.name),{assetId:canonical.id,name:canonical.name,updatedAt:now()});
    await addHistory(canonical.id,{type:'deduplicated',source:'jira-sync',message:`Reconciled ${group.length-1} duplicate Jira-discovered asset${group.length===2?'':'s'}`});
  }
  return removed;
}
function discoveredIdentifiersFromIssues(issues,fieldId){const discovered=new Map();let ignored=0;for(const issue of issues)for(const identifier of fieldValues(issue.fields?.[fieldId])){if(!validIdentifier(identifier)){ignored+=1;continue;}const normalized=normaliseName(identifier);if(!discovered.has(normalized))discovered.set(normalized,identifier);}return{identifiers:[...discovered.values()],ignored};}
async function findAssetForJiraIdentifier(fieldId,identifier){const deterministicId=makeJiraAssetId(fieldId,identifier);let asset=await kvs.get(`${ASSET_PREFIX}${deterministicId}`);if(asset)return asset;const indexed=await kvs.get(nameIndexKey(identifier));if(indexed?.assetId)asset=await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);return asset||null;}
async function recordScannedTicketsForAsset(asset,issues,field,settings,runId){if(!asset?.id||!field?.id)return;const identifier=asset.jiraIdentifier||asset.name||'';if(!validIdentifier(identifier))return;const client=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraClientField?.id);if(client&&asset.jiraClientSyncRunId!==runId)asset=await saveOneAsset({...asset,client,jiraClientSyncRunId:runId},'jira-sync');for(const issue of issues){let relation='';if(issueMatchesIdentifier(issue,field.id,identifier))relation='primary';else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,identifier))relation='related';if(!relation)continue;const ticket=ticketFields(issue,relation,settings.jiraFaultField?.id);await kvs.set(`${ASSET_TICKET_PREFIX}${asset.id}:${issue.key}:${relation}`,{assetId:asset.id,...ticket,recordedAt:now()});}}
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
  const{identifiers,ignored}=discoveredIdentifiersFromIssues(issues,field.id);
  let batchCreated=0,batchMatched=0,batchDiscovered=0;
  for(const identifier of identifiers){
    let asset=await findAssetForJiraIdentifier(field.id,identifier);
    const alreadyProcessed=asset?.jiraSyncRunId===progress.runId;
    if(!alreadyProcessed)batchDiscovered+=1;
    const location=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraLocationField?.id);const type=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraTypeField?.id);const crewCode=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraCrewCodeField?.id);const crewPerson=crewCode?mappedCrewPerson(settings,crewCode):null;const holderName=crewCode?(crewPerson?.displayName||crewCode):'';const holderAccountId=crewPerson?.accountId||'';const base={jiraIdentifier:identifier,jiraIdentifierFieldId:field.id,jiraIdentifierFieldName:field.name,jiraSyncRunId:progress.runId};
    if(asset){const locationUpdate=Boolean(location&&(!alreadyProcessed||!clean(asset.location)));const typeUpdate=Boolean(type&&(!alreadyProcessed||!clean(asset.type)||asset.type==='Other'));const crewUpdate=Boolean(crewCode&&(!alreadyProcessed||!clean(asset.crewCode)));if(!alreadyProcessed||locationUpdate||typeUpdate||crewUpdate){asset=await saveOneAsset({...asset,...base,...(locationUpdate?{location}:{}),...(typeUpdate?{type}:{}),...(crewUpdate?{crewCode,assigneeName:holderName,assigneeAccountId:holderAccountId}:{})},'jira-sync');}if(!alreadyProcessed)batchMatched+=1;}else{asset=await saveOneAsset({id:makeJiraAssetId(field.id,identifier),name:identifier,...base,type:type||'Other',status:'In Use',location:location||'',crewCode:crewCode||'',assigneeAccountId:holderAccountId,assigneeName:holderName,notes:`Discovered automatically from Jira field “${field.name}”.`},'jira-sync');batchCreated+=1;}
    await recordScannedTicketsForAsset(asset,issues,field,settings,progress.runId);
  }
  progress={...progress,nextPageToken:page.nextPageToken,issuesScanned:progress.issuesScanned+issues.length,discovered:progress.discovered+batchDiscovered,created:progress.created+batchCreated,matched:progress.matched+batchMatched,ignored:progress.ignored+ignored};
  const complete=!page.nextPageToken;const processed=progress.created+progress.matched;const result={timestamp:now(),field,issuesScanned:progress.issuesScanned,discovered:progress.discovered,processed,created:progress.created,matched:progress.matched,ignored:progress.ignored,reconciled:progress.reconciled,complete};if(complete){await kvs.set(SYNC_KEY,result);await kvs.delete(SYNC_PROGRESS_KEY);}else await kvs.set(SYNC_PROGRESS_KEY,progress);return result;
}
// Tickets for one device, including identifiers it had before a CSV merge
// (jiraAliases). `truncated` means the result may be incomplete.
async function searchAssetTicketsDetailed(assetId,legacyKeys=[]){
  const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);const matched=new Map();let truncated=false;
  const identifiers=[asset?.jiraIdentifier||asset?.name||'',...safeArray(asset?.jiraAliases)].filter(validIdentifier);
  if(identifiers.length){
    const found=await searchIssuesForIdentifiers(identifiers);const{field,issues,settings}=found;truncated=Boolean(found.truncated);
    if(field){for(const issue of issues){if(identifiers.some(id=>issueMatchesIdentifier(issue,field.id,id)))matched.set(issue.key,ticketFields(issue,'primary',settings.jiraFaultField?.id));else if(identifiers.some(id=>issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,id)))matched.set(issue.key,relatedTicketFields(issue,settings.jiraFaultField?.id));}}
  }
  const missingKeys=legacyKeys.filter(k=>ISSUE_KEY_PATTERN.test(k)&&!matched.has(k));
  if(missingKeys.length>100)truncated=true;
  if(missingKeys.length){const response=await api.asUser().requestJira(route`/rest/api/3/search/jql`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({jql:`key in (${missingKeys.slice(0,100).join(',')}) ORDER BY created DESC`,fields:['summary','status','issuetype','priority','assignee','created','resolutiondate','resolution'],maxResults:100})});if(response.ok){const data=await response.json();for(const issue of safeArray(data.issues))matched.set(issue.key,ticketFields(issue,'linked'));}}
  return{tickets:[...matched.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||''))),truncated};
}
async function searchAssetTickets(assetId,legacyKeys=[]){return(await searchAssetTicketsDetailed(assetId,legacyKeys)).tickets;}
resolver.define('listAssetsPage',async({payload})=>{
  const query=String(payload?.query||'').trim().toLowerCase(),status=clean(payload?.status||''),type=clean(payload?.type||''),location=clean(payload?.location||''),client=clean(payload?.client||'');
  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));
  const maxScanPages=Math.min(10,Math.max(1,Number(payload?.maxScanPages||1)));
  let cursor=payload?.cursor||null,items=[],scanned=0,pages=0;
  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();scanned+=page.results.length;pages+=1;cursor=page.nextCursor||null;for(const entry of page.results){const a=entry.value;const matchesQuery=!query||[a.id,a.name,a.jiraIdentifier,a.crewCode,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location,a.client].some(v=>String(v||'').toLowerCase().includes(query));if(!matchesQuery)continue;if(status&&a.status!==status)continue;if(type&&a.type!==type)continue;if(location&&a.location!==location)continue;if(client&&String(a.client||'')!==String(client))continue;items.push(a);if(items.length>=limit)break;}if(items.length>=limit)break;}while(cursor&&pages<maxScanPages);
  return{items:items.slice(0,limit),nextCursor:cursor,scanned,pages,complete:!cursor};
});
resolver.define('countAssetsPage',async({payload})=>{
  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));
  let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(limit);
  if(payload?.cursor)q=q.cursor(payload.cursor);
  const page=await q.getMany();
  const items=page.results.map(e=>e.value);
  const byType={};
  for(const a of items){const key=clean(a?.type||'Other')||'Other';byType[key]=(byType[key]||0)+1;}
  return{count:items.length,nextCursor:page.nextCursor||null,inUse:items.filter(a=>['In Use','Assigned','Active'].includes(a?.status)).length,available:items.filter(a=>a?.status==='Available').length,repair:items.filter(a=>['Repair','In Repair'].includes(a?.status)).length,byType};
});
resolver.define('listAssets',async({payload})=>{const query=String(payload?.query||'').toLowerCase(),status=clean(payload?.status||''),type=clean(payload?.type||''),location=clean(payload?.location||'');let assets=await queryAllByPrefix(ASSET_PREFIX);if(query)assets=assets.filter(a=>[a.id,a.name,a.jiraIdentifier,a.crewCode,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location].some(v=>String(v||'').toLowerCase().includes(query)));if(status)assets=assets.filter(a=>a.status===status);if(type)assets=assets.filter(a=>a.type===type);if(location)assets=assets.filter(a=>a.location===location);return assets.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));});
resolver.define('syncAssetsFromJira',async({payload})=>syncAssetsFromJira({restart:Boolean(payload?.restart)}));
resolver.define('getSyncStatus',async()=>await kvs.get(SYNC_PROGRESS_KEY)||await kvs.get(SYNC_KEY)||null);
resolver.define('getJiraCustomFields',async()=>getJiraCustomFields());
resolver.define('getJiraProjects',async()=>getJiraProjects());
resolver.define('getJiraClientOptions',async()=>{const values=new Set();let cursor=null,guard=0;do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();for(const entry of safeArray(page?.results)){const value=clean(entry?.value?.client||'');if(value)values.add(value);}cursor=page?.nextCursor||null;guard+=1;}while(cursor&&guard<10);return [...values].sort((a,b)=>String(a).localeCompare(String(b),undefined,{sensitivity:'base'}));});
resolver.define('searchDevices',async({payload})=>{const query=normaliseName(payload?.query||'');const assets=await queryAllByPrefix(ASSET_PREFIX);return assets.filter(a=>!query||normaliseName(a.name).includes(query)||normaliseName(a.jiraIdentifier).includes(query)).sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{sensitivity:'base'})).slice(0,50).map(a=>({id:a.id,name:a.name}));});
resolver.define('getAssetByName',async({payload})=>{const name=clean(payload?.name||'');if(!name)return null;const indexed=await kvs.get(nameIndexKey(name));if(indexed?.assetId)return kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);const assets=await queryAllByPrefix(ASSET_PREFIX);return assets.find(a=>normaliseName(a.name)===normaliseName(name))||null;});
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
  const byName=await reconciliationCandidateByName(row?.name);
  const byDevice=await reconciliationCandidateByIdentifier(fieldId,row?.jiraIdentifier);
  const bySerial=await reconciliationCandidateByIdentifier(fieldId,row?.serialNumber);
  const candidates=[byDevice,bySerial,byName].filter(Boolean);
  const unique=[...new Map(candidates.map(asset=>[asset.id,asset])).values()];
  if(unique.length>1){return{action:'review',message:'Multiple existing assets match this row. Review before importing.',candidateIds:unique.map(a=>a.id),existing:unique.map(a=>({id:a.id,name:a.name,jiraIdentifier:a.jiraIdentifier,serialNumber:a.serialNumber}))};}
  const existing=unique[0]||null;
  if(!existing)return{action:'create',message:'Create new asset.',existing:null};
  if(bySerial?.id===existing.id&&normaliseName(row?.serialNumber)!==normaliseName(row?.jiraIdentifier||''))return{action:'merge-serial',message:'Merge Jira-discovered record “'+existing.name+'” using matching serial number.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  if(byDevice?.id===existing.id)return{action:'update-device-id',message:'Update existing asset “'+existing.name+'” by Device ID.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  return{action:'update-name',message:'Update existing asset “'+existing.name+'” by device name.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
}
resolver.define('previewAssetImportReconciliation',async({payload})=>{
  const rows=safeArray(payload?.assets).slice(0,500);
  const settings=await getSettingsValue();
  const results=[];
  for(let i=0;i<rows.length;i+=1){const match=await classifyImportRow(rows[i],settings);results.push({index:i,...match});}
  return results;
});
resolver.define('reconcileAssetImport',async({payload})=>{
  const rows=safeArray(payload?.assets).slice(0,100);
  const settings=await getSettingsValue();
  let created=0,updated=0,merged=0;const failed=[];
  for(let i=0;i<rows.length;i+=1){
    const row=rows[i]||{};
    try{
      if(!clean(row.name))throw new Error('Device Name is required.');
      const match=await classifyImportRow(row,settings);
      if(match.action==='review')throw new Error(match.message);
      let existing=match.existing?.id?await kvs.get(ASSET_PREFIX+match.existing.id):null;
      if(!existing){await saveOneAsset(row,'import');created+=1;continue;}
      const oldName=existing.name||'';const oldIdentifier=existing.jiraIdentifier||existing.name||'';
      const aliases=[...new Set([...safeArray(existing.jiraAliases),oldIdentifier].map(reconciliationValue).filter(Boolean).filter(v=>normaliseName(v)!==normaliseName(row.jiraIdentifier||row.name||'')))];
      const saved=await saveOneAsset({...row,id:existing.id},'import-reconcile');
      const reconciled={...saved,jiraAliases:aliases,notes:clean(row.notes)||saved.notes||''};
      await kvs.set(ASSET_PREFIX+saved.id,reconciled);
      if(match.action==='merge-serial'){
        merged+=1;
        await addHistory(saved.id,{type:'merged',source:'import-reconcile',message:'Merged Jira-discovered record '+(oldIdentifier||oldName)+' into '+saved.name+' during CSV reconciliation',fromDevice:oldName,fromIdentifier:oldIdentifier,matchedBy:'serial-number'});
      }else{
        updated+=1;
        await addHistory(saved.id,{type:'import-update',source:'import-reconcile',message:'Updated '+saved.name+' from CSV import',matchedBy:match.action==='update-device-id'?'device-id':'device-name'});
      }
    }catch(error){failed.push({index:i,name:row?.name||'',error:error?.message||'Import reconciliation failed.'});}
  }
  return{processed:rows.length,created,updated,merged,failed};
});

resolver.define('getAssetHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${HISTORY_PREFIX}${payload.assetId}:`);return history.sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));});
resolver.define('getFaultHistory',async({payload})=>{if(!payload?.assetId)return[];const settings=await getSettingsValue();const history=await queryAllByPrefix(`${FAULT_HISTORY_PREFIX}${payload.assetId}:`);return history.filter(item=>ticketMatchesConfiguredProject(item,settings)).sort((a,b)=>String(b.issueCreated||b.firstSeen||'').localeCompare(String(a.issueCreated||a.firstSeen||'')));});
resolver.define('getSettings',async()=>getSettingsValue());
resolver.define('saveSettings',async({payload})=>{const incoming=payload?.settings||{};const previousSettings=await getSettingsValue();const normaliseField=(f)=>f?.id?{id:clean(f.id),name:clean(f.name||f.id)}:null;const settings={assetTypes:safeArray(incoming.assetTypes).map(clean).filter(Boolean),statuses:safeArray(incoming.statuses).map(clean).filter(Boolean),locations:safeArray(incoming.locations).map(clean).filter(Boolean),customFields:safeArray(incoming.customFields).map(f=>({key:clean(f.key),label:clean(f.label),type:clean(f.type||'text')})).filter(f=>f.key&&f.label),jiraAssetField:normaliseField(incoming.jiraAssetField),jiraRelatedAssetField:normaliseField(incoming.jiraRelatedAssetField),jiraLocationField:normaliseField(incoming.jiraLocationField),jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraClientField:normaliseField(incoming.jiraClientField),jiraProjectKey:clean(incoming.jiraProjectKey||''),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:safeArray(incoming.crewMappings).map(m=>({crewCode:clean(m.crewCode),accountId:clean(m.accountId),displayName:clean(m.displayName)})).filter(m=>m.crewCode&&(m.displayName||m.accountId)),jiraDiscoveryEnabled:incoming.jiraDiscoveryEnabled!==false};if(!settings.assetTypes.length)settings.assetTypes=DEFAULT_SETTINGS.assetTypes;if(!settings.statuses.length)settings.statuses=DEFAULT_SETTINGS.statuses;const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');const previousProjectKey=clean(previousSettings?.jiraProjectKey||'');const nextProjectKey=clean(settings?.jiraProjectKey||'');if(previousFaultFieldId!==nextFaultFieldId||previousProjectKey!==nextProjectKey){const cachedTickets=await queryAllByPrefix(ASSET_TICKET_PREFIX);for(const ticket of cachedTickets){if(ticket?.assetId&&ticket?.key&&ticket?.relation)await kvs.delete(`${ASSET_TICKET_PREFIX}${ticket.assetId}:${ticket.key}:${ticket.relation}`);}const faultHistory=await queryAllByPrefix(FAULT_HISTORY_PREFIX);for(const item of faultHistory){if(item?.historyKey)await kvs.delete(item.historyKey);}console.log('Device Fault mapping changed; cleared cached ticket/fault data');}await kvs.set(SETTINGS_KEY,settings);if(scanSignature(previousSettings)!==scanSignature(settings)){await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);}return settings;});
resolver.define('searchUsers',async({payload})=>{const q=clean(payload?.query||'');if(!q||q.length<2)return[];const response=await api.asUser().requestJira(route`/rest/api/3/user/search?query=${q}&maxResults=20`,{headers:{Accept:'application/json'}});if(!response.ok)return[];const users=await response.json();return users.filter(u=>u.active!==false&&u.accountType!=='app').map(u=>({accountId:u.accountId,displayName:u.displayName,avatarUrl:u.avatarUrls?.['24x24']||''}));});
resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const settings=await getSettingsValue();const recorded=(await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`)).filter(ticket=>ticketMatchesConfiguredProject(ticket,settings));const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId&&ticketMatchesConfiguredProject({key:l.issueKey},settings)).map(l=>l.issueKey).filter(Boolean);
  // Live, targeted search first: the tickets recorded by sync are never pruned, so they go stale when a
  // ticket's device changes. Fall back to them only when Jira cannot be searched.
  try{return await searchAssetTickets(assetId,legacyKeys);}catch{}
  const byKey=new Map();for(const ticket of recorded){const current=byKey.get(ticket.key);if(!current||ticket.relation==='primary')byKey.set(ticket.key,ticket);}for(const key of legacyKeys)if(!byKey.has(key))byKey.set(key,{key,relation:'linked'});return [...byKey.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));});
// Report rows for one batch of assets (the UI pages through the register in batches of
// REPORT_BATCH). Tickets come from a targeted search for these assets' identifiers, in
// chunks so each JQL stays small. `truncated` means some tickets may be missing.
const REPORT_BATCH=100,REPORT_IDENTIFIER_CHUNK=50;
resolver.define('getAssetReport',async({payload}={})=>{
  const ids=[...new Set(safeArray(payload?.assetIds).map(clean).filter(Boolean))];
  if(ids.length>REPORT_BATCH)throw new Error(`Request report rows for at most ${REPORT_BATCH} assets at a time.`);
  const assets=ids.length?(await Promise.all(ids.map(id=>kvs.get(`${ASSET_PREFIX}${id}`)))).filter(Boolean):await queryAllByPrefix(ASSET_PREFIX,REPORT_BATCH);
  if(!assets.length)return{rows:[],truncated:false};const rows=[];let truncated=false;
  let field=null,issues=[],settings=await getSettingsValue();
  const identifiers=[...new Set(assets.flatMap(a=>[a.jiraIdentifier||a.name,...safeArray(a.jiraAliases)]).map(reconciliationValue).filter(Boolean))];
  try{const seen=new Set();for(let i=0;i<identifiers.length;i+=REPORT_IDENTIFIER_CHUNK){const found=await searchIssuesForIdentifiers(identifiers.slice(i,i+REPORT_IDENTIFIER_CHUNK));field=found.field;settings=found.settings;if(found.truncated)truncated=true;for(const issue of found.issues)if(!seen.has(issue.key)){seen.add(issue.key);issues.push(issue);}if(!field)break;}}catch{truncated=true;}
  const ticketsByIdentifier=new Map();
  const addTicket=(identifier,ticket,relation)=>{if(!validIdentifier(identifier))return;const key=normaliseName(identifier);if(!ticketsByIdentifier.has(key))ticketsByIdentifier.set(key,new Map());const current=ticketsByIdentifier.get(key).get(ticket.key);if(!current||relation==='primary')ticketsByIdentifier.get(key).set(ticket.key,{...ticket,relation});};
  if(field){for(const issue of issues){const ticket=ticketFields(issue,'primary',settings.jiraFaultField?.id);for(const identifier of fieldValues(issue.fields?.[field.id]))addTicket(identifier,ticket,'primary');if(settings.jiraRelatedAssetField?.id)for(const identifier of relatedIdentifiers(issue.fields?.[settings.jiraRelatedAssetField.id]))addTicket(identifier,ticket,'related');}}
  for(const asset of assets){const identifiers=[asset.jiraIdentifier||asset.name,...safeArray(asset.jiraAliases)].map(reconciliationValue).filter(Boolean);const mergedTickets=new Map();for(const identifier of identifiers){for(const ticket of ticketsByIdentifier.get(normaliseName(identifier))?.values()||[]){const current=mergedTickets.get(ticket.key);if(!current||ticket.relation==='primary')mergedTickets.set(ticket.key,ticket);}}const tickets=[...mergedTickets.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));const primary=tickets.filter(t=>t.relation==='primary');const related=tickets.filter(t=>t.relation==='related');const faults=primary.filter(t=>clean(t.fault||''));const open=faults.filter(t=>!t.resolved&&t.statusCategory!=='done').length;for(const ticket of faults){const key=faultHistoryKey(asset.id,ticket);if(key&&!(await kvs.get(key)))await recordFaultHistory(asset,ticket,null);}rows.push({assetId:asset.id,name:asset.name,type:asset.type,status:asset.status,assigneeName:asset.assigneeName||asset.crewCode||'',total:faults.length,related:related.length,involved:tickets.length,open,resolved:faults.length-open,lastFault:faults.find(t=>t.created)?.created||'',latestFault:faults[0]||null,error:false});}
  return{rows:rows.sort((a,b)=>(b.total??-1)-(a.total??-1)||String(b.lastFault||'').localeCompare(String(a.lastFault||''))||String(a.name).localeCompare(String(b.name))),truncated};
});
export const handler = resolver.getDefinitions();