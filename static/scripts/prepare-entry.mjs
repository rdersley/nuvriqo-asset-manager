import fs from 'node:fs';
const path=new URL('../src/main.jsx',import.meta.url);
let src=fs.readFileSync(path,'utf8');
if(!src.includes("import ReportsWorkspace from './ReportsWorkspace';")) src=src.replace("import ImportDialog from './ImportDialog';","import ImportDialog from './ImportDialog';\nimport ReportsWorkspace from './ReportsWorkspace';");
src=src.replace(/function Reports\(\{ onBack, onOpenAsset \}\) \{[\s\S]*?\n\}\n\nfunction IssuePanel/,"function Reports({ onBack }) { return <ReportsWorkspace onBack={onBack} />; }\n\nfunction IssuePanel");
const mappingNeedle="{fieldSelect('Jira related asset field','jiraRelatedAssetField','Optional. Map your secondary-device field here, for example Related Device ID. Related assets are shown in each asset’s ticket history without replacing the primary Device ID.')}{fieldSelect('Jira location / base field','jiraLocationField','Optional. The latest matching ticket updates the asset location/base.')}{fieldSelect('Jira device type field','jiraTypeField','Optional. The latest matching ticket updates the asset type.')}{fieldSelect('Jira assignment reference field','jiraCrewCodeField','Optional free-text field. The latest matching ticket stores the assignment reference and updates the device holder.')}";
const mappingReplacement="{fieldSelect('Jira related asset field','jiraRelatedAssetField','Optional. Map a secondary device field if required. Related assets are shown in each asset’s ticket history without replacing the primary device identifier.')}{fieldSelect('Jira location field','jiraLocationField','Optional. The latest matching ticket updates the asset location.')}{fieldSelect('Jira device type field','jiraTypeField','Optional. The latest matching ticket updates the asset type.')}{fieldSelect('Jira device fault field','jiraFaultField','Optional. Map the Jira field that contains the device fault or fault category. This is used in ticket history and fault reporting.')}{fieldSelect('Jira assignment reference field','jiraCrewCodeField','Optional free-text field. The latest matching ticket stores the assignment reference and updates the device holder.')}";
if(src.includes(mappingNeedle)) src=src.replace(mappingNeedle,mappingReplacement);
else if(!src.includes("'jiraFaultField'")) throw new Error('Could not locate Jira field mappings.');

src=src
  .replaceAll('Jira location / base field','Jira location field')
  .replaceAll('asset location/base','asset location')
  .replaceAll('base / location','location')
  .replaceAll('Base / location','Location')
  .replaceAll('holder or base','holder or location')
  .replaceAll('Base and holder remain opt-in','Location and holder remain opt-in');

src=src.replace("<td>{t.summary || 'Ticket'}</td>","<td>{t.fault || t.summary || 'Ticket'}</td>");
const faultStatsNeedle="const primaryTickets=tickets.filter(t=>t.relation!=='related'); const relatedTickets=tickets.filter(t=>t.relation==='related'); const open = primaryTickets.filter((t) => !t.resolved && t.statusCategory !== 'done').length;";
const faultStatsReplacement="const primaryTickets=tickets.filter(t=>t.relation!=='related'); const relatedTickets=tickets.filter(t=>t.relation==='related'); const faultTickets=primaryTickets.filter(t=>String(t.fault||'').trim()); const open = faultTickets.filter((t) => !t.resolved && t.statusCategory !== 'done').length;";
if(src.includes(faultStatsNeedle))src=src.replace(faultStatsNeedle,faultStatsReplacement);
else if(!src.includes('const faultTickets=primaryTickets.filter'))throw new Error('Could not update asset fault statistics.');

src=src
  .replace('<strong>{primaryTickets.length}</strong><span>Primary faults</span>','<strong>{faultTickets.length}</strong><span>Primary faults</span>')
  .replace('Primary Device ID tickets count as faults. Related Assets show where this device was involved without becoming the primary fault asset.','Only primary tickets with the mapped Device Fault field populated count as faults. Other tickets remain in Ticket history. Related Assets show where this device was involved without becoming the primary fault asset.');

const detailState="const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]);";
const detailStateReplacement="const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]); const [faultHistory,setFaultHistory]=useState([]);";
if(src.includes(detailState)) src=src.replace(detailState,detailStateReplacement);
else if(!src.includes('setFaultHistory')) throw new Error('Could not locate asset detail state.');
const detailLoad="useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); }, [asset.id]);";
const detailLoadReplacement="useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); invoke('getFaultHistory',{assetId:asset.id}).then(setFaultHistory).catch(()=>setFaultHistory([])); }, [asset.id]);";
if(src.includes(detailLoad)) src=src.replace(detailLoad,detailLoadReplacement);
else if(!src.includes("invoke('getFaultHistory'")) throw new Error('Could not locate asset detail loaders.');
const activityCard="<div className=\"card\"><h2>Activity</h2>{history.length ?";
const ledgerCard="<div className=\"card fault-card\"><div className=\"section-head\"><div><h2>Historical fault ledger</h2><p>Only tickets where the mapped Device Fault field is populated are recorded here.</p></div><span>{faultHistory.length} faults</span></div>{faultHistory.length?<div className=\"table-wrap\"><table className=\"fault-table\"><thead><tr><th>Jira issue</th><th>Device fault</th><th>Issue created</th><th>Status when first recorded</th></tr></thead><tbody>{faultHistory.map((f)=><tr key={f.historyKey}><td><button className=\"issue-link\" onClick={()=>router.open(`/browse/${f.issueKey}`)}>{f.issueKey}</button></td><td>{f.fault}</td><td>{formatDate(f.issueCreated||f.firstSeen)}</td><td>{f.statusAtFirstSeen||'—'}</td></tr>)}</tbody></table></div>:<div className=\"empty-small\">No populated device faults recorded yet.</div>}</div><div className=\"card\"><h2>Activity</h2>{history.length ?";
if(src.includes(activityCard)) src=src.replace(activityCard,ledgerCard);
else if(!src.includes('Historical fault ledger')) throw new Error('Could not locate activity card for fault ledger.');

const oldSync="async function syncAll({restart=false,setStage}={}){let sync=await invoke('syncAssetsFromJira',{restart});let guard=0;while(sync&&!sync.complete&&guard<50){const stage=`Syncing Jira devices… ${sync.processed||0} / ${sync.discovered||0}`;setMessage(stage);setStage?.(stage);sync=await invoke('syncAssetsFromJira',{restart:false});guard+=1;}if(sync&&!sync.complete)throw new Error('Jira sync did not complete. Please try again.');return sync;}";
const newSync="async function syncAll({restart=false,setStage}={}){let sync=await invoke('syncAssetsFromJira',{restart});let guard=0;while(sync&&!sync.complete&&guard<2000){const stage=`Syncing Jira devices… ${sync.issuesScanned||0} Jira tickets scanned · ${sync.discovered||0} unique devices found`;setMessage(stage);setStage?.(stage);sync=await invoke('syncAssetsFromJira',{restart:false});guard+=1;}if(sync&&!sync.complete)throw new Error(`Jira sync paused after ${sync.issuesScanned||0} tickets. Run the scan again to continue from the saved position.`);return sync;}";
if(src.includes(oldSync)) src=src.replace(oldSync,newSync);
else if(!src.includes('guard<2000')) throw new Error('Could not update Jira scan continuation guard.');

const rootCall="createRoot(document.getElementById('root')).render(<App/>);";
if(src.includes(rootCall)&&!src.includes('class AssetManagerErrorBoundary')){
  const boundary=`class AssetManagerErrorBoundary extends React.Component {\n  constructor(props){super(props);this.state={error:null};}\n  static getDerivedStateFromError(error){return{error};}\n  componentDidCatch(error,info){console.error('Asset Manager UI error',error,info);}\n  render(){if(this.state.error)return <div style={{padding:'24px',fontFamily:'Arial,sans-serif'}}><h2>Asset Manager could not load</h2><p>{this.state.error?.message||'Unexpected UI error.'}</p><p>Please refresh the page. If this remains, send this message to support.</p></div>;return this.props.children;}\n}\n${rootCall.replace('<App/>','<AssetManagerErrorBoundary><App/></AssetManagerErrorBoundary>')}`;
  src=src.replace(rootCall,boundary);
}

fs.writeFileSync(path,src);
