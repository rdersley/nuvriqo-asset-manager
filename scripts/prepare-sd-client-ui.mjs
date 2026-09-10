import fs from 'node:fs';

const path = new URL('../static/src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

function replaceOnce(label, from, to) {
  if (src.includes(to)) return;
  if (!src.includes(from)) throw new Error(`Could not apply ${label} UI patch.`);
  src = src.replace(from, to);
}

replaceOnce(
  'client default',
  "const emptyAsset = { id: '', name: '', type: 'Laptop'",
  "const emptyAsset = { id: '', name: '', client: '', type: 'Laptop'"
);

if (!src.includes('placeholder="Client / organisation"')) {
  const from = "<label>Device name *<input value={draft.name} onChange={(e) => update('name', e.target.value)} autoFocus /></label><label>Asset type<select";
  const to = "<label>Device name *<input value={draft.name} onChange={(e) => update('name', e.target.value)} autoFocus /></label><label>Client<input value={draft.client||''} onChange={(e) => update('client', e.target.value)} placeholder=\"Client / organisation\" /></label><label>Asset type<select";
  if (!src.includes(from)) throw new Error('Could not locate asset form fields for Client.');
  src = src.replace(from, to);
}

replaceOnce(
  'client settings state',
  "jiraAssetField:null,jiraRelatedAssetField:null,jiraLocationField:null",
  "jiraAssetField:null,jiraRelatedAssetField:null,jiraClientField:null,jiraLocationField:null"
);

const locationMapping = "{fieldSelect('Jira location field','jiraLocationField','Optional. The latest matching ticket updates the asset location.')}";
if (!src.includes("'jiraClientField'")) {
  if (!src.includes(locationMapping)) throw new Error('Could not locate Jira location mapping for Client insertion.');
  src = src.replace(locationMapping, "{fieldSelect('Jira client field','jiraClientField','Optional. Map your SD Client custom field here. The newest populated value for each Device ID is stored against the asset.')}${locationMapping}");
}

replaceOnce(
  'client detail',
  "['Assignment reference', asset.crewCode || '—']",
  "['Client', asset.client || '—'], ['Assignment reference', asset.crewCode || '—']"
);

src = src.replaceAll('guard<2000', 'guard<10000');

fs.writeFileSync(path, src);
