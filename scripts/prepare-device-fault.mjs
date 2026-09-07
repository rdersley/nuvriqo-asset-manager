import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true",
    "jiraLocationField: null, jiraTypeField: null, jiraCrewCodeField: null,\n  jiraFaultField: null, jiraRelatedAssetField: null, crewMappings: [], jiraDiscoveryEnabled: true"
  ],
  [
    "function ticketFields(issue, relation='primary') { return { key:issue.key, relation, summary:issue.fields?.summary||'', status:issue.fields?.status?.name||'',",
    "function ticketFields(issue, relation='primary', faultFieldId=null) { return { key:issue.key, relation, summary:issue.fields?.summary||'', fault:faultFieldId?fieldValues(issue.fields?.[faultFieldId]).join(', '):'', status:issue.fields?.status?.name||'',"
  ],
  [
    "const fields=[field.id,settings.jiraRelatedAssetField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,'summary'",
    "const fields=[field.id,settings.jiraRelatedAssetField?.id,settings.jiraLocationField?.id,settings.jiraTypeField?.id,settings.jiraCrewCodeField?.id,settings.jiraFaultField?.id,'summary'"
  ],
  [
    "matched.set(issue.key,ticketFields(issue,'primary'));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'related'));",
    "matched.set(issue.key,ticketFields(issue,'primary',settings.jiraFaultField?.id));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'related',settings.jiraFaultField?.id));"
  ],
  [
    "const ticket=ticketFields(issue);for(const identifier",
    "const ticket=ticketFields(issue,'primary',settings.jiraFaultField?.id);for(const identifier"
  ],
  [
    "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),crewMappings:",
    "jiraTypeField:normaliseField(incoming.jiraTypeField),jiraCrewCodeField:normaliseField(incoming.jiraCrewCodeField),jiraFaultField:normaliseField(incoming.jiraFaultField),crewMappings:"
  ]
];

for (const [from, to] of replacements) {
  if (src.includes(to)) continue;
  if (!src.includes(from)) throw new Error(`Could not apply Device Fault backend patch: ${from.slice(0, 80)}`);
  src = src.replace(from, to);
}

fs.writeFileSync(path, src);
