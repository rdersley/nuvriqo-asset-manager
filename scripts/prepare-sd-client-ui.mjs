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
  const to = "<label>Device name *<input value={draft.name} onChange={(e) => update('name', e.target.value)} autoFocus /></label><label>Client<select value={draft.client||''} onChange={(e) => update('client', e.target.value)}><option value=\"\">Select client…</option>{[...new Set([...(clientOptions||[]),draft.client].filter(Boolean))].map(x=><option key={x} value={x}>{x}</option>)}</select></label><label>Asset type<select";
  if (!src.includes(from)) throw new Error('Could not locate asset form fields for Client.');
  src = src.replace(from, to);
}

if (!src.includes('jiraClientField:null')) {
  if (src.includes("jiraAssetField:null,jiraRelatedAssetField:null,jiraProjectKey:'',jiraLocationField:null")) {
    src = src.replace(
      "jiraAssetField:null,jiraRelatedAssetField:null,jiraProjectKey:'',jiraLocationField:null",
      "jiraAssetField:null,jiraRelatedAssetField:null,jiraClientField:null,jiraProjectKey:'',jiraLocationField:null"
    );
  } else {
    replaceOnce(
      'client settings state',
      "jiraAssetField:null,jiraRelatedAssetField:null,jiraLocationField:null",
      "jiraAssetField:null,jiraRelatedAssetField:null,jiraClientField:null,jiraLocationField:null"
    );
  }
}

const locationMapping = "{fieldSelect('Jira location field','jiraLocationField','Optional. The latest matching ticket updates the asset location.')}";
const clientMapping = "{fieldSelect('Jira client field','jiraClientField','Optional. Map your SD Client custom field here. The newest populated value for each Device ID is stored against the asset.')}";
if (!src.includes("'jiraClientField'")) {
  if (!src.includes(locationMapping)) throw new Error('Could not locate Jira location mapping for Client insertion.');
  src = src.replace(locationMapping, clientMapping + locationMapping);
}

replaceOnce(
  'client detail',
  "['Assignment reference', asset.crewCode || '—']",
  "['Client', asset.client || '—'], ['Assignment reference', asset.crewCode || '—']"
);

src = src.replaceAll('guard<2000', 'guard<10000');

if (/\$\{locationMapping\}|\{locationMapping\}/.test(src)) {
  throw new Error('SD Client UI patch left an unresolved locationMapping reference in the generated UI.');
}


if (!src.includes('jiraProjects,setJiraProjects')) {
  src = src.replace(
    "const [settings, setSettings] = useState(initial); const [jiraFields, setJiraFields] = useState([]);",
    "const [settings, setSettings] = useState(initial); const [jiraFields, setJiraFields] = useState([]); const [jiraProjects,setJiraProjects]=useState([]);"
  );
}

if (src.includes("useEffect(() => { invoke('getJiraCustomFields').then((rows) => setJiraFields(rows || [])).catch((e) => setFieldError(e.message || 'Could not load Jira fields.')).finally(() => setLoadingFields(false)); }, []);")) {
  src = src.replace(
    "useEffect(() => { invoke('getJiraCustomFields').then((rows) => setJiraFields(rows || [])).catch((e) => setFieldError(e.message || 'Could not load Jira fields.')).finally(() => setLoadingFields(false)); }, []);",
    "useEffect(() => { Promise.all([invoke('getJiraCustomFields'),invoke('getJiraProjects')]).then(([fields,projects])=>{setJiraFields(fields||[]);setJiraProjects(projects||[]);}).catch((e) => setFieldError(e.message || 'Could not load Jira configuration choices.')).finally(() => setLoadingFields(false)); }, []);"
  );
}

if (!src.includes('Jira project to scan')) {
  const marker = "{fieldSelect('Jira device identifier field','jiraAssetField','Required for Jira discovery and primary fault history. Your Device ID field should be selected here.')}";
  const projectControl = "<label className=\"wide\">Jira project to scan<select value={settings.jiraProjectKey||''} disabled={loadingFields||saving} onChange={(e)=>setSettings({...settings,jiraProjectKey:e.target.value})}><option value=\"\">Select one project…</option>{jiraProjects.map(p=><option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}</select><small>Required. Asset discovery, ticket history and fault reporting only use tickets from this project.</small></label>";
  if (!src.includes(marker)) throw new Error('Could not locate Jira Device ID field control for project scope.');
  src = src.replace(marker, projectControl + marker);
}

src = src.replace(
  "jiraAssetField:null,jiraRelatedAssetField:null,jiraClientField:null,jiraLocationField:null",
  "jiraAssetField:null,jiraRelatedAssetField:null,jiraClientField:null,jiraProjectKey:'',jiraLocationField:null"
);

src = src.replace(
  "disabled={saving||!settings.jiraAssetField?.id}",
  "disabled={saving||!settings.jiraAssetField?.id||!settings.jiraProjectKey}"
);

src = src.replace(
  "if(!saved.jiraAssetField?.id)throw new Error('Map a Jira Device ID field before scanning.');",
  "if(!saved.jiraAssetField?.id)throw new Error('Map a Jira Device ID field before scanning.');if(!saved.jiraProjectKey)throw new Error('Select the one Jira project Asset Manager should scan.');"
);

src = src.replaceAll(
  "saved.jiraAssetField?.id&&saved.jiraDiscoveryEnabled!==false",
  "saved.jiraAssetField?.id&&saved.jiraProjectKey&&saved.jiraDiscoveryEnabled!==false"
);

src = src.replaceAll(
  "cfg.jiraAssetField?.id&&cfg.jiraDiscoveryEnabled!==false",
  "cfg.jiraAssetField?.id&&cfg.jiraProjectKey&&cfg.jiraDiscoveryEnabled!==false"
);

fs.writeFileSync(path, src);
