import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { guardResolver } from './auth.js';

// Internal Asset Operations handles crew personal data (emails, usernames,
// contract dates) and rewrites asset holders, so every action is admin-only.
const resolver = guardResolver(new Resolver(), 'all');
const SETTINGS_KEY = 'settings:asset-manager';
const CREW_PREFIX = 'internal-crew:';
const CREW_ALIAS_PREFIX = 'internal-crew-alias:';
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const DEVICE_CODE_PREFIX = 'internal-vpos-device-code:';
const HISTORY_PREFIX = 'asset-history:';
const USAGE_SESSION_KEY = 'internal-device-usage:current-session';
const USAGE_BATCH_PREFIX = 'internal-device-usage-batch:';
const USAGE_EXCEPTION_PREFIX = 'internal-device-usage-exception:';

const clean = (v) => typeof v === 'string' ? v.trim() : v;
const safeArray = (v) => Array.isArray(v) ? v : [];
const normalise = (v) => String(clean(v) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const encoded = (v) => Buffer.from(normalise(v), 'utf8').toString('base64url');
const crewKey = (v) => `${CREW_PREFIX}${encoded(v)}`;
const crewAliasKey = (v) => `${CREW_ALIAS_PREFIX}${encoded(v)}`;
const nameIndexKey = (v) => `${ASSET_NAME_PREFIX}${encoded(v)}`;
const deviceCodeKey = (v) => `${DEVICE_CODE_PREFIX}${encoded(v)}`;
const internalAssetId = (v) => `AST-VPOS-${encoded(v).slice(0, 40).toUpperCase()}`;
const now = () => new Date().toISOString();

async function entries(prefix, limit = 500) {
  const out = []; let cursor;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, limit ? Math.max(1, limit - out.length) : 100));
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany(); out.push(...page.results); cursor = page.nextCursor;
    if (limit && out.length >= limit) break;
  } while (cursor);
  return out;
}
const values = async (prefix, limit = 500) => (await entries(prefix, limit)).map(e => e.value);

async function addHistory(assetId, event) {
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2,8)}`, { assetId, timestamp, ...event });
}
function fieldValues(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(fieldValues);
  if (typeof v === 'string' || typeof v === 'number') return [String(v).trim()].filter(Boolean);
  if (typeof v === 'object') { const c = v.value ?? v.name ?? v.label ?? v.displayName ?? v.objectKey ?? v.key; return c ? [String(c).trim()] : []; }
  return [];
}
const getSettings = async () => (await kvs.get(SETTINGS_KEY)) || {};

async function searchCrewTickets(settings) {
  const f = settings.jiraCrewCodeField; if (!f?.id) return [];
  const numericId = String(f.id).replace('customfield_','');
  const fields = [f.id, settings.jiraAssetField?.id, 'summary','status','created','resolutiondate','issuetype','priority'].filter(Boolean);
  const issues = []; let nextPageToken; let guard=0;
  do {
    const body = { jql:`cf[${numericId}] is not EMPTY ORDER BY created DESC`, fields, maxResults:100, ...(nextPageToken ? {nextPageToken}: {}) };
    const r = await api.asUser().requestJira(route`/rest/api/3/search/jql`, { method:'POST', headers:{Accept:'application/json','Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!r.ok) throw new Error(`Crew ticket lookup failed with status ${r.status}.`);
    const data = await r.json(); issues.push(...safeArray(data.issues)); nextPageToken = data.nextPageToken || null; guard+=1;
  } while (nextPageToken && guard<5);
  return issues;
}
function identityValues(r) {
  const email = clean(r?.email || ''); const emailUser = email.includes('@') ? email.split('@')[0] : '';
  return [...new Set([r?.crewCode,r?.easysimUsername,r?.ryrWinUsername,r?.username,emailUser].map(clean).filter(Boolean))];
}
async function saveCrewAliases(record, previous=null) {
  const next = identityValues(record), old = safeArray(previous?.identityAliases);
  for (const alias of old) if (!next.some(v => normalise(v) === normalise(alias))) {
    const indexed = await kvs.get(crewAliasKey(alias));
    if (indexed?.crewCode && normalise(indexed.crewCode) === normalise(record.crewCode)) await kvs.delete(crewAliasKey(alias));
  }
  for (const alias of next) await kvs.set(crewAliasKey(alias), { crewCode:record.crewCode });
  return next;
}
async function resolveCrew(login) {
  login = clean(login || ''); if (!login) return null;
  const direct = await kvs.get(crewKey(login)); if (direct) return direct;
  const alias = await kvs.get(crewAliasKey(login)); return alias?.crewCode ? (await kvs.get(crewKey(alias.crewCode))) || null : null;
}

async function lookupJsmCustomerByEmail(email) {
  email=clean(email||'');
  if(!email||!email.includes('@'))return{status:'no-email'};
  const response=await api.asUser().requestJira(route`/rest/api/3/user/search?query=${email}&maxResults=20`,{headers:{Accept:'application/json'}});
  if(!response.ok)return{status:'lookup-error'};
  const users=safeArray(await response.json()).filter(u=>u?.active!==false&&u?.accountType!=='app');
  const exact=users.filter(u=>u?.emailAddress&&normalise(u.emailAddress)===normalise(email));
  const matches=exact.length?exact:(users.length===1?users:[]);
  if(matches.length===1){const u=matches[0];return{status:'linked',accountId:clean(u.accountId||''),displayName:clean(u.displayName||email),accountType:clean(u.accountType||'')};}
  if(users.length>1)return{status:'multiple'};
  return{status:'not-found'};
}

resolver.define('importCrew', async ({payload}) => {
  const rows=safeArray(payload?.rows); let imported=0; const failed=[];
  for (let i=0;i<rows.length;i++) {
    const row=rows[i]||{}, crewCode=clean(row.crewCode||row.code||row.assignmentReference||'');
    if(!crewCode){failed.push({row:i+2,message:'Crew code is required.'});continue;}
    const existing=await kvs.get(crewKey(crewCode));
    const record={...(existing||{}),crewCode,name:clean(row.name||[clean(row.firstName||''),clean(row.lastName||'')].filter(Boolean).join(' ')||existing?.name||''),firstName:clean(row.firstName||existing?.firstName||''),lastName:clean(row.lastName||existing?.lastName||''),location:clean(row.location||row.base||existing?.location||''),email:clean(row.email||existing?.email||''),easysimUsername:clean(row.easysimUsername||existing?.easysimUsername||''),ryrWinUsername:clean(row.ryrWinUsername||existing?.ryrWinUsername||''),role:clean(row.role||existing?.role||''),contractEndDate:clean(row.contractEndDate||existing?.contractEndDate||''),trainingEndDate:clean(row.trainingEndDate||existing?.trainingEndDate||''),status:clean(row.status||existing?.status||'Active'),notes:clean(row.notes||existing?.notes||''),importedAt:now()};
    record.identityAliases=await saveCrewAliases(record,existing); await kvs.set(crewKey(crewCode),record); imported++;
  }
  return {imported,failed};
});

resolver.define('linkCrewCustomers',async({payload})=>{
  const retry=payload?.retry===true;
  const limit=Math.min(25,Math.max(1,Number(payload?.limit||20)));
  const crewRows=(await entries(CREW_PREFIX,500)).map(e=>e.value);
  const candidates=crewRows.filter(c=>clean(c?.email||'')&&(retry||!c?.jsmCustomerLinkStatus||c.jsmCustomerLinkStatus==='lookup-error')).slice(0,limit);
  const assets=(await entries(ASSET_PREFIX,500)).map(e=>e.value);
  let linked=0,notFound=0,multiple=0,errors=0,assetsLinked=0;
  for(const crew of candidates){
    const result=await lookupJsmCustomerByEmail(crew.email);
    const updated={...crew,jsmCustomerLinkStatus:result.status,jsmCustomerAccountId:result.accountId||'',jsmCustomerDisplayName:result.displayName||'',jsmCustomerAccountType:result.accountType||'',jsmCustomerLinkedAt:result.status==='linked'?now():(crew.jsmCustomerLinkedAt||'')};
    await kvs.set(crewKey(crew.crewCode),updated);
    if(result.status==='linked'){linked+=1;for(const asset of assets){if(normalise(asset?.crewCode)!==normalise(crew.crewCode))continue;if(asset.assigneeAccountId)continue;const currentName=clean(asset.assigneeName||'');if(currentName&&normalise(currentName)!==normalise(crew.name)&&normalise(currentName)!==normalise(crew.crewCode))continue;await kvs.set(`${ASSET_PREFIX}${asset.id}`,{...asset,assigneeAccountId:result.accountId,assigneeName:result.displayName||crew.name||crew.crewCode,updatedAt:now()});await addHistory(asset.id,{type:'jsm-customer-linked',source:'crew-customer-link',message:`Linked holder to JSM customer ${result.displayName||crew.email}`,crewCode:crew.crewCode,accountId:result.accountId});assetsLinked+=1;}}
    else if(result.status==='not-found')notFound+=1;else if(result.status==='multiple')multiple+=1;else errors+=1;
  }
  const remaining=crewRows.filter(c=>clean(c?.email||'')&&(retry||!c?.jsmCustomerLinkStatus||c.jsmCustomerLinkStatus==='lookup-error')).length-candidates.length;
  return{processed:candidates.length,linked,notFound,multiple,errors,assetsLinked,remaining:Math.max(0,remaining)};
});

resolver.define('getCrewReport', async () => {
  const settings=await getSettings(); if(!settings.jiraCrewCodeField?.id) throw new Error('Map the Jira assignment reference field in Asset Manager configuration before using Crew Tracking.');
  const [crewRows,assets,issues]=await Promise.all([values(CREW_PREFIX),values(ASSET_PREFIX),searchCrewTickets(settings)]);
  const map=new Map(crewRows.map(c=>[normalise(c.crewCode),{...c,currentDevices:[],historicalDevices:new Set(),tickets:[]}])) ;
  const ensure=(code)=>{const k=normalise(code);if(!k)return null;if(!map.has(k))map.set(k,{crewCode:clean(code),name:'',location:'',email:'',status:'Not in imported crew list',currentDevices:[],historicalDevices:new Set(),tickets:[]});return map.get(k);};
  for(const a of assets){if(!a?.crewCode)continue;const c=ensure(a.crewCode),id=a.jiraIdentifier||a.name||a.id;c.currentDevices.push({id:a.id,name:a.name||id,identifier:id,type:a.type||'Unspecified',status:a.status||'',location:a.location||''});if(id)c.historicalDevices.add(id);}
  for(const issue of issues){for(const code of fieldValues(issue.fields?.[settings.jiraCrewCodeField.id])){const c=ensure(code);if(!c)continue;const dev=settings.jiraAssetField?.id?fieldValues(issue.fields?.[settings.jiraAssetField.id]):[];dev.forEach(d=>c.historicalDevices.add(d));c.tickets.push({key:issue.key,summary:issue.fields?.summary||'',status:issue.fields?.status?.name||'',issueType:issue.fields?.issuetype?.name||'',priority:issue.fields?.priority?.name||'',created:issue.fields?.created||'',resolved:issue.fields?.resolutiondate||'',devices:dev});}}
  return [...map.values()].map(c=>{const tm=new Map();for(const d of c.currentDevices){const type=clean(d.type)||'Unspecified',k=normalise(type)||'unspecified';if(!tm.has(k))tm.set(k,{type,count:0,devices:[]});const g=tm.get(k);g.count++;g.devices.push(d);}const currentDeviceTypes=[...tm.values()].sort((a,b)=>String(a.type).localeCompare(String(b.type),undefined,{sensitivity:'base'}));const duplicateDeviceTypes=currentDeviceTypes.filter(g=>g.count>1);return {...c,historicalDevices:[...c.historicalDevices],currentDeviceTypes,duplicateDeviceTypes,currentDeviceCount:c.currentDevices.length,currentDeviceTypeCount:currentDeviceTypes.length,historicalDeviceCount:c.historicalDevices.size,ticketCount:c.tickets.length,reviewRequired:duplicateDeviceTypes.length>0,unreturnedIndicator:duplicateDeviceTypes.reduce((s,g)=>s+Math.max(0,g.count-1),0)};}).sort((a,b)=>a.reviewRequired!==b.reviewRequired?(a.reviewRequired?-1:1):String(a.crewCode).localeCompare(String(b.crewCode),undefined,{sensitivity:'base'}));
});
resolver.define('deleteCrew',async({payload})=>{const code=clean(payload?.crewCode||'');if(!code)throw new Error('Crew code is required.');const old=await kvs.get(crewKey(code));for(const a of safeArray(old?.identityAliases)){const x=await kvs.get(crewAliasKey(a));if(x?.crewCode&&normalise(x.crewCode)===normalise(code))await kvs.delete(crewAliasKey(a));}await kvs.delete(crewKey(code));return{deleted:true};});

async function findAsset(identifier,deviceCode='') {
  identifier=clean(identifier||'');
  if(identifier){const idx=await kvs.get(nameIndexKey(identifier));if(idx?.assetId){const a=await kvs.get(`${ASSET_PREFIX}${idx.assetId}`);if(a)return a;}const a=await kvs.get(`${ASSET_PREFIX}${internalAssetId(identifier)}`);if(a)return a;}
  if(deviceCode){const idx=await kvs.get(deviceCodeKey(deviceCode));if(idx?.assetId)return(await kvs.get(`${ASSET_PREFIX}${idx.assetId}`))||null;}return null;
}
async function createVposAsset({deviceIdentifier,deviceCode,crew,lastLoginAt,sourceFile}) {
  const timestamp=now(),id=internalAssetId(deviceIdentifier),existing=await kvs.get(`${ASSET_PREFIX}${id}`);if(existing)return{asset:existing,created:false};
  const crewCode=clean(crew?.crewCode||''),assignedPerson=crewCode?clean(crew?.name||crewCode):'';
  const asset={id,name:deviceIdentifier,jiraIdentifier:deviceIdentifier,jiraIdentifierFieldId:'',jiraIdentifierFieldName:'',crewCode,type:'vPOS',manufacturer:'',model:'',serialNumber:clean(deviceCode||''),assigneeAccountId:'',assigneeName:assignedPerson,status:'In Use',location:clean(crew?.location||''),purchaseDate:'',warrantyExpiry:'',notes:'Imported from vPOS Device Status report',customFields:{vposDeviceCode:clean(deviceCode||'')},createdAt:timestamp,updatedAt:timestamp};
  await kvs.set(`${ASSET_PREFIX}${id}`,asset);await kvs.set(nameIndexKey(deviceIdentifier),{assetId:id});if(deviceCode)await kvs.set(deviceCodeKey(deviceCode),{assetId:id});
  await addHistory(id,{type:'created',source:'vpos-device-import',message:'Asset created from vPOS Device Status report',deviceIdentifier,deviceCode,sourceFile:sourceFile||'',lastLoginAt:clean(lastLoginAt||'')});
  if(crewCode)await addHistory(id,{type:'assignment-from-device-login',source:'device-login-import',message:`Assigned to ${assignedPerson||crewCode} from device last-login report`,crewCode,deviceIdentifier,deviceCode,lastLoginAt:clean(lastLoginAt||''),sourceFile:sourceFile||''});
  return{asset,created:true};
}

// Remove legacy reconciliation batches incrementally. Assets, crew and history are never touched.
resolver.define('cleanupDeviceUsageStorage',async({payload})=>{
  const limit=Math.min(100,Math.max(10,Number(payload?.limit||100)));const old=await entries(USAGE_BATCH_PREFIX,limit);for(const e of old)await kvs.delete(e.key);const remaining=(await entries(USAGE_BATCH_PREFIX,1)).length>0;return{deleted:old.length,remaining};
});

resolver.define('beginDeviceUsageImport',async({payload})=>{
  const sessionId=clean(payload?.sessionId||'');if(!sessionId)throw new Error('Import session is required.');
  const meta={sessionId,sourceFile:clean(payload?.sourceFile||''),sourceRows:Number(payload?.sourceRows||0),usableRows:Number(payload?.usableRows||0),skippedNoLogin:Number(payload?.skippedNoLogin||0),importedRows:0,createdCount:0,assignedCount:0,mismatchCount:0,matchedCount:0,unknownCrewCount:0,reviewCount:0,startedAt:now(),completedAt:null};await kvs.set(USAGE_SESSION_KEY,meta);return meta;
});
resolver.define('importDeviceUsageBatch',async({payload})=>{
  const session=await kvs.get(USAGE_SESSION_KEY),sessionId=clean(payload?.sessionId||'');if(!session||!sessionId||session.sessionId!==sessionId)throw new Error('The device usage import session is no longer active. Start the import again.');
  const rows=safeArray(payload?.rows);let processed=0,createdCount=0,assignedCount=0,mismatchCount=0,matchedCount=0,unknownCrewCount=0,reviewCount=0;
  for(const row of rows){const deviceIdentifier=clean(row.deviceIdentifier||row.deviceName||row.deviceId||row.device||''),deviceCode=clean(row.deviceCode||''),loginValue=clean(row.crewCode||row.lastLogin||row.user||row.username||'');if(!deviceIdentifier||!loginValue)continue;processed++;
    const crew=await resolveCrew(loginValue);let asset=await findAsset(deviceIdentifier,deviceCode),wasCreated=false;if(!asset){const made=await createVposAsset({deviceIdentifier,deviceCode,crew,lastLoginAt:row.lastLoginAt,sourceFile:session.sourceFile});asset=made.asset;wasCreated=made.created;if(wasCreated)createdCount++;}
    const previous=clean(asset?.crewCode||'');let state='match',reviewRequired=false,action='No change required',assignedCrewCode=previous,assignedPerson=clean(asset?.assigneeName||'');
    if(!crew){state=wasCreated?'created-unassigned':'crew-not-in-register';reviewRequired=true;action=wasCreated?'Created vPOS asset; Last Login not found in crew register':'Last Login not found in imported crew register';unknownCrewCount++;}
    else if(wasCreated){state='created-and-assigned';assignedCrewCode=clean(crew.crewCode||loginValue);assignedPerson=clean(crew.name||assignedCrewCode);action=`Created vPOS asset and assigned to ${assignedPerson||assignedCrewCode}`;assignedCount++;}
    else if(!previous){assignedCrewCode=clean(crew.crewCode||loginValue);assignedPerson=clean(crew.name||assignedCrewCode);const updated={...asset,crewCode:assignedCrewCode,assigneeName:assignedPerson,status:asset.status||'In Use',updatedAt:now()};await kvs.set(`${ASSET_PREFIX}${asset.id}`,updated);asset=updated;await addHistory(asset.id,{type:'assignment-from-device-login',source:'device-login-import',message:`Assigned to ${assignedPerson||assignedCrewCode} from device last-login report`,crewCode:assignedCrewCode,loginValue,deviceIdentifier,deviceCode,lastLoginAt:clean(row.lastLoginAt||''),sourceFile:session.sourceFile||''});state='assigned-automatically';action=`Assigned to ${assignedPerson||assignedCrewCode}`;assignedCount++;}
    else if(normalise(previous)!==normalise(crew.crewCode)){state='assignment-mismatch';reviewRequired=true;action=`Review: Asset Manager=${previous}; last login resolves to ${crew.crewCode}`;mismatchCount++;}else matchedCount++;
    // Only exceptions are persisted. Clean matches/creates are represented by session counters.
    if(reviewRequired){reviewCount++;const key=`${USAGE_EXCEPTION_PREFIX}${sessionId}:${encoded(deviceIdentifier)}`;await kvs.set(key,{deviceIdentifier,deviceCode,crewCode:loginValue,resolvedCrewCode:crew?.crewCode||'',lastLoginAt:clean(row.lastLoginAt||''),crewName:crew?.name||'',crewLocation:crew?.location||'',assetId:asset?.id||'',assetName:asset?.name||'',assetType:asset?.type||'',assetStatus:asset?.status||'',assetLocation:asset?.location||'',assignedCrewCode,assignedPerson,previousCrewCode:previous,state,reviewRequired,action,created:wasCreated});}
  }
  const next={...session,importedRows:Number(session.importedRows||0)+processed,createdCount:Number(session.createdCount||0)+createdCount,assignedCount:Number(session.assignedCount||0)+assignedCount,mismatchCount:Number(session.mismatchCount||0)+mismatchCount,matchedCount:Number(session.matchedCount||0)+matchedCount,unknownCrewCount:Number(session.unknownCrewCount||0)+unknownCrewCount,reviewCount:Number(session.reviewCount||0)+reviewCount,completedAt:payload?.finalBatch?now():null};await kvs.set(USAGE_SESSION_KEY,next);return{imported:processed,createdCount,assignedCount,mismatchCount,matchedCount,unknownCrewCount,reviewCount,completedAt:next.completedAt};
});
resolver.define('getUsageReconciliation',async({payload})=>{
  const s=await kvs.get(USAGE_SESSION_KEY);if(!s?.sessionId)return{rows:[],importedCount:0,reviewCount:0,createdCount:0,mismatchCount:0,assignedCount:0,matchedCount:0,notInCrewListCount:0,totalRows:0,filteredCount:0,importedAt:null};
  let rows=(await values(`${USAGE_EXCEPTION_PREFIX}${s.sessionId}:`));const q=normalise(payload?.query||'');if(q)rows=rows.filter(r=>[r.deviceIdentifier,r.deviceCode,r.crewCode,r.resolvedCrewCode,r.crewName,r.assignedCrewCode,r.assetName,r.assetType,r.assetLocation].some(v=>normalise(v).includes(q)));const filteredCount=rows.length,offset=Math.max(0,Number(payload?.offset||0)),limit=Math.min(500,Math.max(1,Number(payload?.limit||250)));return{rows:rows.slice(offset,offset+limit),importedCount:Number(s.importedRows||0),reviewCount:Number(s.reviewCount||0),createdCount:Number(s.createdCount||0),mismatchCount:Number(s.mismatchCount||0),assignedCount:Number(s.assignedCount||0),matchedCount:Number(s.matchedCount||0),notInCrewListCount:Number(s.unknownCrewCount||0),missingAssetCount:0,totalRows:rows.length,filteredCount,offset,limit,importedAt:s.completedAt||s.startedAt||null,sourceFile:s.sourceFile||'',sourceRows:s.sourceRows||0,skippedNoLogin:s.skippedNoLogin||0};
});
resolver.define('clearDeviceUsage',async()=>{const s=await kvs.get(USAGE_SESSION_KEY);if(s?.sessionId){const ex=await entries(`${USAGE_EXCEPTION_PREFIX}${s.sessionId}:`,100);for(const e of ex)await kvs.delete(e.key);}await kvs.delete(USAGE_SESSION_KEY);return{deleted:true};});

export const handler=resolver.getDefinitions();
