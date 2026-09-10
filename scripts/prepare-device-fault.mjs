import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    "const HISTORY_PREFIX = 'asset-history:';\nconst SETTINGS_KEY = 'settings:asset-manager';",
    "const HISTORY_PREFIX = 'asset-history:';\nconst FAULT_HISTORY_PREFIX = 'fault-history:';\nconst SETTINGS_KEY = 'settings:asset-manager';"
  ],
  [
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true",
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true"
  ],
  [
    "async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event }); }",
    "async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event }); }\nfunction faultHistoryKey(assetId,ticket){const label=clean(ticket?.fault||ticket?.summary||'Fault')||'Fault';const fingerprint=createHash('sha256').update(`${ticket?.key||''}:${normaliseName(label)}`).digest('hex').slice(0,16);return `${FAULT_HISTORY_PREFIX}${assetId}:${ticket?.key||'unknown'}:${fingerprint}`;}\nasync function recordFaultHistory(asset,ticket,knownKeys){if(!asset?.id||!ticket?.key||ticket.relation!=='primary')return null;const key=faultHistoryKey(asset.id,ticket);if(knownKeys?.has(key))return null;const value={historyKey:key,assetId:asset.id,deviceName:asset.name||'',issueKey:ticket.key,fault:clean(ticket.fault||ticket.summary||'Fault')||'Fault',summary:ticket.summary||'',issueCreated:ticket.created||'',firstSeen:now(),statusAtFirstSeen:ticket.status||'',resolvedAtFirstSeen:Boolean(ticket.resolved)||ticket.statusCategory==='done'};await kvs.set(key,value);knownKeys?.add(key);return value;}"
  ],
  [
    "function ticketFields(issue, relation='primary') { return { key:issue.key, relation, summary:issue.fields?.summary||'', status:issue.fields?.status?.name||'',",
    "function ticketFields(issue, relation='primary', faultFieldId=null) { return { key:issue.key, relation, summary:issue.fields?.summary||'', fault:faultFieldId?fieldValues(issue.fields?.[faultFieldId]).join(', '):'', status:issue.fields?.status?.name||'',"
  ],
  [
    "function fieldValues(value) { if(value==null)return[];",
    "function relatedTicketFields(issue,faultFieldId=null){return faultFieldId?ticketFields(issue,'related',faultFieldId):ticketFields(issue,'related');}\nfunction fieldValues(value) { if(value==null)return[];"
  ],
  [
    "fields:[field.id,settings.jiraRelatedAssetField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,'summary'",
    "fields:[field.id,settings.jiraRelatedAssetField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,settings.jiraFaultField?.id,'summary'"
  ],
  [
    "matched.set(issue.key,ticketFields(issue,'primary'));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'related'));",
    "matched.set(issue.key,ticketFields(issue,'primary',settings.jiraFaultField?.id));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,relatedTicketFields(issue,settings.jiraFaultField?.id));"
  ],
  [
    "const ticket=ticketFields(issue);for(const identifier",
    "const ticket=ticketFields(issue,'primary',settings.jiraFaultField?.id);for(const identifier"
  ],
  [
    "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),crewMappings:",
    "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:"
  ],
  [
    "resolver.define('getAssetReport',async()=>{\n  const assets=await queryAllByPrefix(ASSET_PREFIX);if(!assets.length)return[];const rows=[];",
    "resolver.define('getAssetReport',async()=>{\n  const assets=await queryAllByPrefix(ASSET_PREFIX);if(!assets.length)return[];const rows=[];const existingFaultHistory=await queryAllByPrefix(FAULT_HISTORY_PREFIX);const knownFaultHistoryKeys=new Set(existingFaultHistory.map(item=>item?.historyKey).filter(Boolean));"
  ],
  [
    "const open=primary.filter(t=>!t.resolved&&t.statusCategory!=='done').length;rows.push({assetId:asset.id",
    "const open=primary.filter(t=>!t.resolved&&t.statusCategory!=='done').length;for(const ticket of primary)await recordFaultHistory(asset,ticket,knownFaultHistoryKeys);rows.push({assetId:asset.id"
  ],
  [
    "resolver.define('getAssetHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${HISTORY_PREFIX}${payload.assetId}:`);return history.sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));});",
    "resolver.define('getAssetHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${HISTORY_PREFIX}${payload.assetId}:`);return history.sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));});\nresolver.define('getFaultHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${FAULT_HISTORY_PREFIX}${payload.assetId}:`);return history.sort((a,b)=>String(b.issueCreated||b.firstSeen||'').localeCompare(String(a.issueCreated||a.firstSeen||'')));});"
  ]
];

for (const [from, to] of replacements) {
  if (src.includes(to)) continue;
  if (!src.includes(from)) throw new Error(`Could not apply Device Fault backend patch: ${from.slice(0, 90)}`);
  src = src.replace(from, to);
}

fs.writeFileSync(path, src);
