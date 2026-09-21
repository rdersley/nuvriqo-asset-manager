import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    "const LINK_PREFIX = 'issue-link:';\nconst HISTORY_PREFIX = 'asset-history:';",
    "const LINK_PREFIX = 'issue-link:';\nconst ASSET_TICKET_PREFIX = 'asset-ticket:';\nconst HISTORY_PREFIX = 'asset-history:';"
  ],
  [
    "const HISTORY_PREFIX = 'asset-history:';\nconst SETTINGS_KEY = 'settings:asset-manager';",
    "const HISTORY_PREFIX = 'asset-history:';\nconst FAULT_HISTORY_PREFIX = 'fault-history:';\nconst SETTINGS_KEY = 'settings:asset-manager';"
  ],
  [
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true",
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true"
  ],
  [
    "jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), crewCode:",
    "jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), jiraSyncRunId: clean(input.jiraSyncRunId ?? existing.jiraSyncRunId ?? ''), crewCode:"
  ],
  [
    "async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event }); }",
    "async function addHistory(assetId, event) { const timestamp = now(); await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event }); }\nfunction faultHistoryKey(assetId,ticket){const label=clean(ticket?.fault||'');if(!label)return'';const fingerprint=createHash('sha256').update(`${ticket?.key||''}:${normaliseName(label)}`).digest('hex').slice(0,16);return `${FAULT_HISTORY_PREFIX}${assetId}:${ticket?.key||'unknown'}:${fingerprint}`;}\nasync function recordFaultHistory(asset,ticket,knownKeys){const fault=clean(ticket?.fault||'');if(!asset?.id||!ticket?.key||ticket.relation!=='primary'||!fault)return null;const key=faultHistoryKey(asset.id,ticket);if(!key||knownKeys?.has(key))return null;const value={historyKey:key,assetId:asset.id,deviceName:asset.name||'',issueKey:ticket.key,fault,summary:ticket.summary||'',issueCreated:ticket.created||'',firstSeen:now(),statusAtFirstSeen:ticket.status||'',resolvedAtFirstSeen:Boolean(ticket.resolved)||ticket.statusCategory==='done'};await kvs.set(key,value);knownKeys?.add(key);return value;}"
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
    "async function findAssetForJiraIdentifier(fieldId,identifier){const deterministicId=makeJiraAssetId(fieldId,identifier);let asset=await kvs.get(`${ASSET_PREFIX}${deterministicId}`);if(asset)return asset;const indexed=await kvs.get(nameIndexKey(identifier));if(indexed?.assetId)asset=await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);return asset||null;}",
    "async function findAssetForJiraIdentifier(fieldId,identifier){const deterministicId=makeJiraAssetId(fieldId,identifier);let asset=await kvs.get(`${ASSET_PREFIX}${deterministicId}`);if(asset)return asset;const indexed=await kvs.get(nameIndexKey(identifier));if(indexed?.assetId)asset=await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);return asset||null;}\nasync function recordScannedTicketsForAsset(asset,issues,field,settings){if(!asset?.id||!field?.id)return;const identifier=asset.jiraIdentifier||asset.name||'';if(!validIdentifier(identifier))return;for(const issue of issues){let relation='';if(issueMatchesIdentifier(issue,field.id,identifier))relation='primary';else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,identifier))relation='related';if(!relation)continue;const ticket=ticketFields(issue,relation,settings.jiraFaultField?.id);await kvs.set(`${ASSET_TICKET_PREFIX}${asset.id}:${issue.key}:${relation}`,{assetId:asset.id,...ticket,recordedAt:now()});}}"
  ],
  [
    "    let asset=await findAssetForJiraIdentifier(field.id,identifier);\n    if(asset?.jiraSyncRunId===progress.runId)continue;\n    batchDiscovered+=1;",
    "    let asset=await findAssetForJiraIdentifier(field.id,identifier);\n    const alreadyProcessed=asset?.jiraSyncRunId===progress.runId;\n    if(!alreadyProcessed)batchDiscovered+=1;"
  ],
  [
    "    if(asset){asset=await saveOneAsset({...asset,...base,...(location?{location}:{}),...(type?{type}:{}),...(crewCode?{crewCode,assigneeName:holderName,assigneeAccountId:holderAccountId}:{})},'jira-sync');batchMatched+=1;}else{asset=await saveOneAsset({id:makeJiraAssetId(field.id,identifier),name:identifier,...base,type:type||'Other',status:'In Use',location:location||'',crewCode:crewCode||'',assigneeAccountId:holderAccountId,assigneeName:holderName,notes:`Discovered automatically from Jira field “${field.name}”.`},'jira-sync');batchCreated+=1;}\n  }",
    "    if(asset){const locationUpdate=Boolean(location&&(!alreadyProcessed||!clean(asset.location)));const typeUpdate=Boolean(type&&(!alreadyProcessed||!clean(asset.type)||asset.type==='Other'));const crewUpdate=Boolean(crewCode&&(!alreadyProcessed||!clean(asset.crewCode)));if(!alreadyProcessed||locationUpdate||typeUpdate||crewUpdate){asset=await saveOneAsset({...asset,...base,...(locationUpdate?{location}:{}),...(typeUpdate?{type}:{}),...(crewUpdate?{crewCode,assigneeName:holderName,assigneeAccountId:holderAccountId}:{})},'jira-sync');}if(!alreadyProcessed)batchMatched+=1;}else{asset=await saveOneAsset({id:makeJiraAssetId(field.id,identifier),name:identifier,...base,type:type||'Other',status:'In Use',location:location||'',crewCode:crewCode||'',assigneeAccountId:holderAccountId,assigneeName:holderName,notes:`Discovered automatically from Jira field “${field.name}”.`},'jira-sync');batchCreated+=1;}\n    await recordScannedTicketsForAsset(asset,issues,field,settings);\n  }"
  ],
  [
    "matched.set(issue.key,ticketFields(issue,'primary'));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'related'));",
    "matched.set(issue.key,ticketFields(issue,'primary',settings.jiraFaultField?.id));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,relatedTicketFields(issue,settings.jiraFaultField?.id));"
  ],
  [
    "resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId).map(l=>l.issueKey).filter(Boolean);try{return await searchAssetTickets(assetId,legacyKeys);}catch{return legacyKeys.map(key=>({key,relation:'linked'}));}});",
    "resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const recorded=await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`);const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId).map(l=>l.issueKey).filter(Boolean);if(recorded.length){const byKey=new Map();for(const ticket of recorded){const current=byKey.get(ticket.key);if(!current||ticket.relation==='primary')byKey.set(ticket.key,ticket);}for(const key of legacyKeys)if(!byKey.has(key))byKey.set(key,{key,relation:'linked'});return [...byKey.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));}try{return await searchAssetTickets(assetId,legacyKeys);}catch{return legacyKeys.map(key=>({key,relation:'linked'}));}});"
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
    "const faults=primary.filter(t=>clean(t.fault||''));const open=faults.filter(t=>!t.resolved&&t.statusCategory!=='done').length;for(const ticket of faults)await recordFaultHistory(asset,ticket,knownFaultHistoryKeys);rows.push({assetId:asset.id"
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

// Reporting distinguishes "ticket involving the device" from an actual device fault.
// Only primary tickets with a populated mapped Device Fault field count as faults.
const oldFaultTotals="total:primary.length,related:related.length,involved:tickets.length,open,resolved:primary.length-open,lastFault:primary.find(t=>t.created)?.created||'',latestFault:primary[0]||related[0]||null";
const newFaultTotals="total:faults.length,related:related.length,involved:tickets.length,open,resolved:faults.length-open,lastFault:faults.find(t=>t.created)?.created||'',latestFault:faults[0]||null";
if (src.includes(oldFaultTotals)) src=src.replace(oldFaultTotals,newFaultTotals);
else if (!src.includes(newFaultTotals)) throw new Error('Could not apply true Device Fault reporting totals.');

// If the configured Device Fault field changes, remove data captured using the old mapping.
// Ticket snapshots and fault-history rows are then rebuilt from Jira by the next scan using
// the newly selected field, so an accidental mapping cannot remain in Asset Manager.
if (!src.includes('Device Fault mapping changed; cleared cached ticket/fault data')) {
  const saveNeedle = "resolver.define('saveSettings',async({payload})=>{const incoming=payload?.settings||{};";
  if (!src.includes(saveNeedle)) throw new Error('Could not locate saveSettings resolver for Device Fault mapping reset.');
  src = src.replace(
    saveNeedle,
    saveNeedle + "const previousSettings=await getSettingsValue();"
  );

  const persistNeedle = "if(!settings.statuses.length)settings.statuses=DEFAULT_SETTINGS.statuses;await kvs.set(SETTINGS_KEY,settings);await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);return settings;});";
  const persistReplacement = "if(!settings.statuses.length)settings.statuses=DEFAULT_SETTINGS.statuses;const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');if(previousFaultFieldId!==nextFaultFieldId){const cachedTickets=await queryAllByPrefix(ASSET_TICKET_PREFIX);for(const ticket of cachedTickets){if(ticket?.assetId&&ticket?.key&&ticket?.relation)await kvs.delete(\`\${ASSET_TICKET_PREFIX}\${ticket.assetId}:\${ticket.key}:\${ticket.relation}\`);}const faultHistory=await queryAllByPrefix(FAULT_HISTORY_PREFIX);for(const item of faultHistory){if(item?.historyKey)await kvs.delete(item.historyKey);}console.log('Device Fault mapping changed; cleared cached ticket/fault data');}await kvs.set(SETTINGS_KEY,settings);await kvs.delete(SYNC_KEY);await kvs.delete(SYNC_PROGRESS_KEY);return settings;});";
  if (!src.includes(persistNeedle)) throw new Error('Could not locate saveSettings persistence for Device Fault mapping reset.');
  src = src.replace(persistNeedle, persistReplacement);
}

fs.writeFileSync(path, src);