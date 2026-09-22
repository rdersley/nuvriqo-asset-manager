import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(label, from, to) {
  if (src.includes(to)) return;
  if (!src.includes(from)) throw new Error(`Could not apply ${label} patch.`);
  src = src.replace(from, to);
}

replaceOnce(
  'SD Client settings',
  "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true",
  "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null, jiraClientField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true"
);

replaceOnce(
  'asset client storage',
  "jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), jiraSyncRunId: clean(input.jiraSyncRunId ?? existing.jiraSyncRunId ?? ''), crewCode:",
  "jiraIdentifierFieldName: clean(input.jiraIdentifierFieldName ?? existing.jiraIdentifierFieldName ?? ''), jiraSyncRunId: clean(input.jiraSyncRunId ?? existing.jiraSyncRunId ?? ''), client: clean(input.client ?? existing.client ?? ''), jiraClientSyncRunId: clean(input.jiraClientSyncRunId ?? existing.jiraClientSyncRunId ?? ''), crewCode:"
);

replaceOnce(
  'Jira client field search',
  "fields:[field.id,settings.jiraRelatedAssetField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,settings.jiraFaultField?.id,'summary'",
  "fields:[field.id,settings.jiraRelatedAssetField?.id,settings.jiraClientField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,settings.jiraFaultField?.id,'summary'"
);

replaceOnce(
  'SD Client settings persistence',
  "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:",
  "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraClientField:normaliseField(incoming.jiraClientField),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:"
);

replaceOnce(
  'client history',
  "if(existing.location!==asset.location)changes.push({field:'location',from:existing.location||'',to:asset.location||''});",
  "if(existing.location!==asset.location)changes.push({field:'location',from:existing.location||'',to:asset.location||''});\n    if(existing.client!==asset.client)changes.push({field:'client',from:existing.client||'',to:asset.client||''});"
);

replaceOnce(
  'paged SD Client sync helper',
  "async function recordScannedTicketsForAsset(asset,issues,field,settings){if(!asset?.id||!field?.id)return;const identifier=asset.jiraIdentifier||asset.name||'';if(!validIdentifier(identifier))return;for(const issue of issues){",
  "async function recordScannedTicketsForAsset(asset,issues,field,settings,runId){if(!asset?.id||!field?.id)return;const identifier=asset.jiraIdentifier||asset.name||'';if(!validIdentifier(identifier))return;const client=latestFieldValueForIdentifier(issues,field.id,identifier,settings.jiraClientField?.id);if(client&&asset.jiraClientSyncRunId!==runId)asset=await saveOneAsset({...asset,client,jiraClientSyncRunId:runId},'jira-sync');for(const issue of issues){"
);

replaceOnce(
  'paged SD Client sync call',
  "await recordScannedTicketsForAsset(asset,issues,field,settings);",
  "await recordScannedTicketsForAsset(asset,issues,field,settings,progress.runId);"
);


replaceOnce(
  'single Jira project scope setting',
  "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null, jiraClientField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true",
  "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null, jiraClientField: null, jiraProjectKey: '',\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true"
);

if (!src.includes('async function getJiraProjects()')) {
  const marker = "async function resolveJiraAssetField(){";
  if (!src.includes(marker)) throw new Error('Could not locate Jira asset field resolver for project helper.');
  const helper = "async function getJiraProjects(){const response=await api.asUser().requestJira(route\`/rest/api/3/project/search?maxResults=100&orderBy=name\`,{headers:{Accept:'application/json'}});if(!response.ok)throw new Error(\`Could not load Jira projects (\${response.status}).\`);const data=await response.json();return safeArray(data.values).map(p=>({id:p.id,key:p.key,name:p.name})).filter(p=>p.key).sort((a,b)=>String(a.name||a.key).localeCompare(String(b.name||b.key),undefined,{sensitivity:'base'}));}\n";
  src = src.replace(marker, helper + marker);
}

if (!src.includes("const scope=projectKey?")) {
  const from = "function jiraAssetSearchShape(field,settings){const numericId=String(field.id).replace('customfield_','');return{jql:\`cf[\${numericId}] is not EMPTY ORDER BY created DESC\`,fields:";
  const to = "function jiraAssetSearchShape(field,settings){const numericId=String(field.id).replace('customfield_','');const projectKey=clean(settings.jiraProjectKey||'').replace(/[^A-Za-z0-9_-]/g,'');const scope=projectKey?\`project = \\\"\${projectKey}\\\" AND \`:'';return{jql:\`\${scope}cf[\${numericId}] is not EMPTY ORDER BY created DESC\`,fields:";
  if (!src.includes(from)) throw new Error('Could not scope Jira asset search to one project.');
  src = src.replace(from, to);
}

replaceOnce(
  'project setting persistence',
  "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraClientField:normaliseField(incoming.jiraClientField),jiraFaultField:",
  "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraClientField:normaliseField(incoming.jiraClientField),jiraProjectKey:clean(incoming.jiraProjectKey||''),jiraFaultField:"
);

if (!src.includes("resolver.define('getJiraProjects'")) {
  const marker = "resolver.define('getJiraCustomFields',async()=>getJiraCustomFields());";
  if (!src.includes(marker)) throw new Error('Could not locate Jira custom-fields resolver for project resolver.');
  src = src.replace(marker, marker + "\nresolver.define('getJiraProjects',async()=>getJiraProjects());");
}

if (src.includes("const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');if(previousFaultFieldId!==nextFaultFieldId){")) {
  src = src.replace(
    "const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');if(previousFaultFieldId!==nextFaultFieldId){",
    "const previousFaultFieldId=clean(previousSettings?.jiraFaultField?.id||'');const nextFaultFieldId=clean(settings?.jiraFaultField?.id||'');const previousProjectKey=clean(previousSettings?.jiraProjectKey||'');const nextProjectKey=clean(settings?.jiraProjectKey||'');if(previousFaultFieldId!==nextFaultFieldId||previousProjectKey!==nextProjectKey){"
  );
}

if (!src.includes('ticketMatchesConfiguredProject')) {
  const marker = "async function getSettingsValue(){";
  if (!src.includes(marker)) throw new Error('Could not locate settings helper for project ticket filter.');
  const helper = "function ticketMatchesConfiguredProject(ticket,settings){const projectKey=clean(settings?.jiraProjectKey||'').toUpperCase();if(!projectKey)return true;const key=clean(ticket?.key||ticket?.issueKey||'').toUpperCase();return key.startsWith(projectKey+'-');}\n";
  src = src.replace(marker, helper + marker);
}

if (!src.includes('recorded.filter(ticket=>ticketMatchesConfiguredProject(ticket,settings))')) {
  const from = "resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const recorded=await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`);const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId).map(l=>l.issueKey).filter(Boolean);if(recorded.length){const byKey=new Map();for(const ticket of recorded){";
  const to = "resolver.define('getAssetTickets',async({payload})=>{const assetId=clean(payload?.assetId||'');if(!assetId)return[];const settings=await getSettingsValue();const recorded=(await queryAllByPrefix(`${ASSET_TICKET_PREFIX}${assetId}:`)).filter(ticket=>ticketMatchesConfiguredProject(ticket,settings));const links=await queryAllByPrefix(LINK_PREFIX);const legacyKeys=links.filter(l=>l?.assetId===assetId&&ticketMatchesConfiguredProject({key:l.issueKey},settings)).map(l=>l.issueKey).filter(Boolean);if(recorded.length){const byKey=new Map();for(const ticket of recorded){";
  if (!src.includes(from)) throw new Error('Could not locate getAssetTickets resolver for project filtering.');
  src = src.replace(from, to);
}

if (!src.includes('history.filter(item=>ticketMatchesConfiguredProject(item,settings))')) {
  const from = "resolver.define('getFaultHistory',async({payload})=>{if(!payload?.assetId)return[];const history=await queryAllByPrefix(`${FAULT_HISTORY_PREFIX}${payload.assetId}:`);return history.sort((a,b)=>String(b.issueCreated||b.firstSeen||'').localeCompare(String(a.issueCreated||a.firstSeen||'')));});";
  const to = "resolver.define('getFaultHistory',async({payload})=>{if(!payload?.assetId)return[];const settings=await getSettingsValue();const history=await queryAllByPrefix(`${FAULT_HISTORY_PREFIX}${payload.assetId}:`);return history.filter(item=>ticketMatchesConfiguredProject(item,settings)).sort((a,b)=>String(b.issueCreated||b.firstSeen||'').localeCompare(String(a.issueCreated||a.firstSeen||'')));});";
  if (!src.includes(from)) throw new Error('Could not locate getFaultHistory resolver for project filtering.');
  src = src.replace(from, to);
}


if (!src.includes("resolver.define('getJiraClientOptions'")) {
  const marker = "resolver.define('getJiraProjects',async()=>getJiraProjects());";
  if (!src.includes(marker)) throw new Error('Could not locate Jira project resolver for Client options resolver.');
  const resolver = "resolver.define('getJiraClientOptions',async()=>{const values=new Set();let cursor=null,guard=0;do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();for(const entry of safeArray(page?.results)){const value=clean(entry?.value?.client||'');if(value)values.add(value);}cursor=page?.nextCursor||null;guard+=1;}while(cursor&&guard<10);return [...values].sort((a,b)=>String(a).localeCompare(String(b),undefined,{sensitivity:'base'}));});";
  src = src.replace(marker, marker + "\n" + resolver);
}

fs.writeFileSync(path, src);
