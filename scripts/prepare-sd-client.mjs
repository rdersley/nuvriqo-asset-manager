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

fs.writeFileSync(path, src);
