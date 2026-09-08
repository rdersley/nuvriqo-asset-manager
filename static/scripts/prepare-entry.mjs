import fs from 'node:fs';
const path=new URL('../src/main.jsx',import.meta.url);
let src=fs.readFileSync(path,'utf8');
if(!src.includes("import ReportsWorkspace from './ReportsWorkspace';")) src=src.replace("import ImportDialog from './ImportDialog';","import ImportDialog from './ImportDialog';\nimport ReportsWorkspace from './ReportsWorkspace';");
src=src.replace(/function Reports\(\{ onBack, onOpenAsset \}\) \{[\s\S]*?\n\}\n\nfunction IssuePanel/,"function Reports({ onBack }) { return <ReportsWorkspace onBack={onBack} />; }\n\nfunction IssuePanel");
const mappingNeedle="{fieldSelect('Jira related asset field','jiraRelatedAssetField','Optional. Map your secondary-device field here, for example Related Device ID. Related assets are shown in each asset’s ticket history without replacing the primary Device ID.')}{fieldSelect('Jira location / base field','jiraLocationField','Optional. The latest matching ticket updates the asset location/base.')}{fieldSelect('Jira device type field','jiraTypeField','Optional. The latest matching ticket updates the asset type.')}{fieldSelect('Jira assignment reference field','jiraCrewCodeField','Optional free-text field. The latest matching ticket stores the assignment reference and updates the device holder.')}";
const mappingReplacement="{fieldSelect('Jira related asset field','jiraRelatedAssetField','Optional. Map a secondary device field if required. Related assets are shown in each asset’s ticket history without replacing the primary device identifier.')}{fieldSelect('Jira location field','jiraLocationField','Optional. The latest matching ticket updates the asset location.')}{fieldSelect('Jira device type field','jiraTypeField','Optional. The latest matching ticket updates the asset type.')}{fieldSelect('Jira device fault field','jiraFaultField','Optional. Map the Jira field that contains the device fault or fault category. This is used in ticket history and fault reporting.')}{fieldSelect('Jira assignment reference field','jiraCrewCodeField','Optional free-text field. The latest matching ticket stores the assignment reference and updates the device holder.')}";
if(src.includes(mappingNeedle)) src=src.replace(mappingNeedle,mappingReplacement);
else if(!src.includes("'jiraFaultField'")) throw new Error('Could not locate Jira field mappings.');

// Marketplace-facing terminology must stay customer-neutral.
src=src
  .replaceAll('Jira location / base field','Jira location field')
  .replaceAll('asset location/base','asset location')
  .replaceAll('base / location','location')
  .replaceAll('Base / location','Location')
  .replaceAll('holder or base','holder or location')
  .replaceAll('Base and holder remain opt-in','Location and holder remain opt-in');

src=src.replace("<td>{t.summary || 'Ticket'}</td>","<td>{t.fault || t.summary || 'Ticket'}</td>");
const detailState="const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]);";
const detailStateReplacement="const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]); const [faultHistory,setFaultHistory]=useState([]);";
if(src.includes(detailState)) src=src.replace(detailState,detailStateReplacement);
else if(!src.includes('setFaultHistory')) throw new Error('Could not locate asset detail state.');
const detailLoad="useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); }, [asset.id]);";
const detailLoadReplacement="useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); invoke('getFaultHistory',{assetId:asset.id}).then(setFaultHistory).catch(()=>setFaultHistory([])); }, [asset.id]);";
if(src.includes(detailLoad)) src=src.replace(detailLoad,detailLoadReplacement);
else if(!src.includes("invoke('getFaultHistory'")) throw new Error('Could not locate asset detail loaders.');
const activityCard="<div className=\"card\"><h2>Activity</h2>{history.length ?";
const ledgerCard="<div className=\"card fault-card\"><div className=\"section-head\"><div><h2>Historical fault ledger</h2><p>Permanent record of each distinct fault ever recorded against this device.</p></div><span>{faultHistory.length} faults</span></div>{faultHistory.length?<div className=\"table-wrap\"><table className=\"fault-table\"><thead><tr><th>Jira issue</th><th>Device fault</th><th>Issue created</th><th>Status when first recorded</th></tr></thead><tbody>{faultHistory.map((f)=><tr key={f.historyKey}><td><button className=\"issue-link\" onClick={()=>router.open(`/browse/${f.issueKey}`)}>{f.issueKey}</button></td><td>{f.fault||f.summary||'Fault'}</td><td>{formatDate(f.issueCreated||f.firstSeen)}</td><td>{f.statusAtFirstSeen||'—'}</td></tr>)}</tbody></table></div>:<div className=\"empty-small\">No historical faults recorded yet.</div>}</div><div className=\"card\"><h2>Activity</h2>{history.length ?";
if(src.includes(activityCard)) src=src.replace(activityCard,ledgerCard);
else if(!src.includes('Historical fault ledger')) throw new Error('Could not locate activity card for fault ledger.');

// Keep the app navigation visible on every full-page screen, including edit,
// configuration, reports and asset detail views.
const navNeedle="function NavButton({ active, icon, children, onClick }) { return <button className={`nv-nav-item ${active ? 'active' : ''}`} onClick={onClick}><span className=\"nv-nav-icon\">{icon}</span><span>{children}</span></button>; }";
const navHelper=`${navNeedle}\nfunction PersistentNav({ mode, onNavigate, onImport }) { return <aside className=\"nv-sidebar\"><div className=\"nv-brand\"><div className=\"nv-logo\">N</div><div><strong>Nuvriqo</strong><small>Asset Manager</small></div></div><nav><NavButton active={mode==='overview'} icon=\"⌂\" onClick={()=>onNavigate('overview')}>Overview</NavButton><NavButton active={mode==='assets'||mode==='detail'||mode==='form'} icon=\"▣\" onClick={()=>onNavigate('assets')}>Assets</NavButton><NavButton icon=\"⇧\" onClick={onImport}>Imports</NavButton><NavButton active={mode==='reports'} icon=\"▥\" onClick={()=>onNavigate('reports')}>Reports</NavButton><NavButton active={mode==='settings'} icon=\"⚙\" onClick={()=>onNavigate('settings')}>Configuration</NavButton></nav><div className=\"nv-sidebar-bottom\"><span>Help & Support</span><span>Documentation</span><span className=\"nv-version\">Nuvriqo · UI v1</span></div></aside>; }`;
if(src.includes(navNeedle)&&!src.includes('function PersistentNav(')) src=src.replace(navNeedle,navHelper);
const wrapScreen=(modeName)=>{
  const re=new RegExp(`if\\(mode==='${modeName}'([^\\n]*?)\\)return <main>([\\s\\S]*?)<\\/main>;`);
  const match=src.match(re);
  if(!match) return;
  const condition=match[1]||'';
  const inner=match[2];
  const replacement=`if(mode==='${modeName}'${condition})return <div className=\"nv-shell\"><PersistentNav mode={mode} onNavigate={(next)=>{setMode(next);if(next!=='detail')setSelected(null);}} onImport={()=>{setMode('assets');setShowImport(true);}}/><main className=\"nv-main\">${inner}</main></div>;`;
  src=src.replace(match[0],replacement);
};
['form','settings','reports','detail'].forEach(wrapScreen);
if(!src.includes('<PersistentNav mode={mode}')) throw new Error('Could not add persistent navigation to full-page screens.');

const old="useEffect(()=>{view.getContext().then(setContext);},[]); useEffect(()=>{if(context?.extension?.type!=='jira:issuePanel')load().catch(e=>setMessage(e.message));},[query,status,type,location,context]);";
const replacement="useEffect(()=>{view.getContext().then(setContext);},[]); useEffect(()=>{let unlisten; view.createHistory().then((history)=>{const apply=(location)=>{const route=(location?.pathname||'').replace(/^\\/+|\\/+$/g,''); if(route==='reports')setMode('reports'); else if(route==='overview'||route==='')setMode('overview');}; apply(history.location); unlisten=history.listen((location)=>apply(location));}).catch(()=>{}); return()=>unlisten?.();},[]); useEffect(()=>{if(context?.extension?.type!=='jira:issuePanel')load().catch(e=>setMessage(e.message));},[query,status,type,location,context]);";
if(src.includes(old)) src=src.replace(old,replacement);
else if(!src.includes('view.createHistory().then')) throw new Error('Could not locate Asset Manager routing hook.');
fs.writeFileSync(path,src);
