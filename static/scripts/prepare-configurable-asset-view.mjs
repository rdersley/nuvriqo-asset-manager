import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

if (!src.includes('function ConfigurableAssetsTable(')) {
  const marker = 'function App() {';
  if (!src.includes(marker)) throw new Error('Could not locate Asset Manager App component.');

  const component = `const BASE_ASSET_COLUMNS=[
  {key:'name',label:'Device name',default:true,get:a=>a.name||'—'},
  {key:'jiraIdentifier',label:'Jira Device ID',default:false,get:a=>a.jiraIdentifier||'—'},
  {key:'id',label:'Asset ID',default:false,get:a=>a.id||'—'},
  {key:'type',label:'Type',default:true,get:a=>a.type||'—'},
  {key:'holder',label:'Holder',default:true,get:a=>a.assigneeName||a.crewCode||'Unassigned'},
  {key:'crewCode',label:'Assignment reference',default:false,get:a=>a.crewCode||'—'},
  {key:'status',label:'Status',default:true,get:a=>a.status||'—'},
  {key:'location',label:'Location',default:true,get:a=>a.location||'—'},
  {key:'client',label:'Client',default:true,get:a=>a.client||'—'},
  {key:'manufacturer',label:'Manufacturer',default:false,get:a=>a.manufacturer||'—'},
  {key:'model',label:'Model',default:false,get:a=>a.model||'—'},
  {key:'serialNumber',label:'Serial number',default:true,get:a=>a.serialNumber||'—'},
  {key:'purchaseDate',label:'Purchase date',default:false,get:a=>a.purchaseDate||'—'},
  {key:'warrantyExpiry',label:'Warranty expiry',default:false,get:a=>a.warrantyExpiry||'—'},
  {key:'fault',label:'Fault',default:true,get:()=>''},
  {key:'notes',label:'Notes',default:false,get:a=>a.notes||'—'}
];

function ConfigurableAssetsTable({assets,settings,reportByAsset,query,setQuery,status,setStatus,type,setType,location,setLocation,onImport,onExport,onCreate,onOpenAsset}){
  const columns=useMemo(()=>[
    ...BASE_ASSET_COLUMNS,
    ...(settings.customFields||[]).map(f=>({key:\`custom:\${f.key}\`,label:f.label||f.key,default:false,get:a=>a.customFields?.[f.key]||'—'}))
  ],[settings.customFields]);
  const defaultColumns=useMemo(()=>columns.filter(c=>c.default).map(c=>c.key),[columns]);
  const [visibleColumns,setVisibleColumns]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem('nuvriqo.assetView.columns')||'null');return Array.isArray(saved)&&saved.length?saved:null;}catch{return null;}});
  const [activeFilters,setActiveFilters]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem('nuvriqo.assetView.filters')||'[]');return Array.isArray(saved)?saved:[];}catch{return[];}});
  const [filterValues,setFilterValues]=useState({});
  const [showOptions,setShowOptions]=useState(false);
  const [totalAssetCount,setTotalAssetCount]=useState(null);
  const [countingAssets,setCountingAssets]=useState(false);
  useEffect(()=>{let cancelled=false;const run=async()=>{setCountingAssets(true);try{let cursor=null,total=0,guard=0;do{const page=await invoke('countAssetsPage',{cursor,limit:100});total+=Number(page?.count||0);cursor=page?.nextCursor||null;guard+=1;}while(cursor&&guard<500&&!cancelled);if(!cancelled)setTotalAssetCount(total);}catch{if(!cancelled)setTotalAssetCount(null);}finally{if(!cancelled)setCountingAssets(false);}};run();return()=>{cancelled=true;};},[]);
  const selectedColumns=(visibleColumns||defaultColumns).filter(key=>columns.some(c=>c.key===key));
  useEffect(()=>{if(visibleColumns)localStorage.setItem('nuvriqo.assetView.columns',JSON.stringify(visibleColumns));},[visibleColumns]);
  useEffect(()=>{localStorage.setItem('nuvriqo.assetView.filters',JSON.stringify(activeFilters));},[activeFilters]);
  const valueFor=(asset,key)=>{const col=columns.find(c=>c.key===key);return col?String(col.get(asset)??''):'';};
  const shownAssets=useMemo(()=>assets.filter(asset=>activeFilters.every(key=>{const wanted=String(filterValues[key]||'').trim().toLowerCase();return !wanted||valueFor(asset,key).toLowerCase().includes(wanted);})),[assets,activeFilters,filterValues,columns]);
  const toggleColumn=(key)=>setVisibleColumns(current=>{const base=current||defaultColumns;return base.includes(key)?base.filter(x=>x!==key):[...base,key];});
  const addFilter=(key)=>{if(key&&!activeFilters.includes(key))setActiveFilters([...activeFilters,key]);};
  const removeFilter=(key)=>{setActiveFilters(activeFilters.filter(x=>x!==key));setFilterValues(v=>{const next={...v};delete next[key];return next;});};
  const renderCell=(asset,key)=>{
    if(key==='name')return <><strong>{asset.name||'—'}</strong>{asset.jiraIdentifier&&asset.jiraIdentifier!==asset.name?<small style={{display:'block'}}>{asset.jiraIdentifier}</small>:null}</>;
    if(key==='status')return <span className="status-pill">{asset.status||'—'}</span>;
    if(key==='fault'){const fault=reportByAsset.get(asset.id)?.latestFault;return fault?<><strong>{fault.key}</strong><small style={{display:'block'}}>{fault.relation==='related'?'Related · ':''}{fault.fault||'—'} · {fault.status||'—'}</small></>:'—';}
    return valueFor(asset,key)||'—';
  };
  return <div className="nv-assets-card card">
    <div className="nv-card-heading"><div><h2>Assets</h2><p>{totalAssetCount!=null?<><strong>{totalAssetCount.toLocaleString()}</strong> total assets · </>:countingAssets?'Counting total assets… · ':''}{shownAssets.length} devices in this view{shownAssets.length!==assets.length?(' · '+assets.length+' loaded'):''}</p></div><div className="top-actions"><button className="secondary" onClick={()=>setShowOptions(!showOptions)}>Columns & filters</button><button className="secondary" onClick={onImport}>Import</button><button className="secondary" onClick={onExport}>Export</button><button className="primary" onClick={onCreate}>+ Create asset</button></div></div>
    {showOptions&&<div className="card" style={{margin:'0 12px 12px',padding:'14px'}}><div className="nv-card-heading"><div><h3 style={{margin:0}}>Choose columns</h3><p>Select exactly what you want to see. Your choice is remembered on this browser.</p></div><button className="secondary" onClick={()=>setVisibleColumns(defaultColumns)}>Reset defaults</button></div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:'8px 16px'}}>{columns.map(c=><label key={c.key} style={{display:'flex',gap:'8px',alignItems:'center'}}><input type="checkbox" checked={selectedColumns.includes(c.key)} onChange={()=>toggleColumn(c.key)}/>{c.label}</label>)}</div></div>}
    <div className="filters"><input className="search" placeholder="Search assets…" value={query} onChange={e=>setQuery(e.target.value)}/><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">Status</option>{settings.statuses.map(x=><option key={x}>{x}</option>)}</select><select value={type} onChange={e=>setType(e.target.value)}><option value="">Device type</option>{[...new Set(assets.map(a=>a.type).filter(Boolean))].sort().map(x=><option key={x}>{x}</option>)}</select><select value={location} onChange={e=>setLocation(e.target.value)}><option value="">Location</option>{[...new Set(assets.map(a=>a.location).filter(Boolean))].sort().map(x=><option key={x}>{x}</option>)}</select><select value="" onChange={e=>addFilter(e.target.value)}><option value="">+ Add filter</option>{columns.filter(c=>!['name','status','type','location','fault'].includes(c.key)&&!activeFilters.includes(c.key)).map(c=><option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
    {activeFilters.length>0&&<div style={{display:'flex',gap:'8px',flexWrap:'wrap',padding:'0 12px 12px'}}>{activeFilters.map(key=>{const col=columns.find(c=>c.key===key);const clientOptions=key==='client'?[...new Set(assets.map(a=>String(a.client||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{sensitivity:'base'})):[];return <div key={key} style={{display:'flex',alignItems:'center',gap:'6px'}}>{key==='client'?<select style={{minWidth:'180px'}} value={filterValues[key]||''} onChange={e=>setFilterValues({...filterValues,[key]:e.target.value})}><option value="">All clients</option>{clientOptions.map(x=><option key={x} value={x}>{x}</option>)}</select>:<input style={{minWidth:'160px'}} placeholder={'Filter by '+(col?.label||key)+'…'} value={filterValues[key]||''} onChange={e=>setFilterValues({...filterValues,[key]:e.target.value})}/>}<button className="secondary" onClick={()=>removeFilter(key)}>×</button></div>;})}</div>}
    {shownAssets.length?<div className="table-wrap"><table><thead><tr>{selectedColumns.map(key=><th key={key}>{columns.find(c=>c.key===key)?.label||key}</th>)}</tr></thead><tbody>{shownAssets.map(asset=><tr key={asset.id} onClick={()=>onOpenAsset(asset)}>{selectedColumns.map(key=><td key={key}>{renderCell(asset,key)}</td>)}</tr>)}</tbody></table></div>:<div className="empty"><h2>No assets found</h2><p>Adjust your filters, create an asset or import your existing register.</p></div>}
  </div>;
}

`;
  src = src.replace(marker, component + marker);
}

const startMarker = '  const listView=<div className="nv-assets-card card">';
const returnMarker = '\n  return <div className="nv-shell">';
const start = src.indexOf(startMarker);
if (start >= 0) {
  const end = src.indexOf(returnMarker, start);
  if (end < 0) throw new Error('Could not locate end of Asset list view.');
  const replacement = `  const listView=<ConfigurableAssetsTable assets={assets} settings={settings} reportByAsset={reportByAsset} query={query} setQuery={setQuery} status={status} setStatus={setStatus} type={type} setType={setType} location={location} setLocation={setLocation} onImport={()=>setShowImport(true)} onExport={exportCsv} onCreate={()=>{setSelected(null);setMode('form');}} onOpenAsset={(asset)=>{setSelected(asset);setMode('detail');}}/>;`;
  src = src.slice(0, start) + replacement + src.slice(end);
} else if (!src.includes('const listView=<ConfigurableAssetsTable')) {
  throw new Error('Could not locate existing Asset list view.');
}

if (!src.includes('estateOverview')) {
  const appMarker = 'function App() {';
  const stateBlock = `function App() {
  const [estateOverview,setEstateOverview]=useState(null);
  useEffect(()=>{let cancelled=false;const run=async()=>{try{let cursor=null,total=0,inUse=0,available=0,repair=0,guard=0;const byType={};do{const page=await invoke('countAssetsPage',{cursor,limit:100});total+=Number(page?.count||0);inUse+=Number(page?.inUse||0);available+=Number(page?.available||0);repair+=Number(page?.repair||0);for(const [k,v] of Object.entries(page?.byType||{}))byType[k]=(byType[k]||0)+Number(v||0);cursor=page?.nextCursor||null;guard+=1;}while(cursor&&guard<500&&!cancelled);if(!cancelled)setEstateOverview({total,inUse,available,repair,byType});}catch{if(!cancelled)setEstateOverview(null);}};run();return()=>{cancelled=true;};},[]);`;
  if (!src.includes(appMarker)) throw new Error('Could not locate App for full-estate overview metrics.');
  src = src.replace(appMarker, stateBlock);

  const statsNeedle = "const stats=useMemo(()=>{const inUse=assets.filter(a=>['In Use','Assigned','Active'].includes(a.status)).length,available=assets.filter(a=>a.status==='Available').length,repair=assets.filter(a=>['Repair','In Repair'].includes(a.status)).length,openFaults=reportRows.reduce((sum,r)=>sum+(r.open||0),0);return{total:assets.length,inUse,available,repair,openFaults};},[assets,reportRows]);";
  const statsReplacement = "const stats=useMemo(()=>{const localInUse=assets.filter(a=>['In Use','Assigned','Active'].includes(a.status)).length,localAvailable=assets.filter(a=>a.status==='Available').length,localRepair=assets.filter(a=>['Repair','In Repair'].includes(a.status)).length,openFaults=reportRows.reduce((sum,r)=>sum+(r.open||0),0);return{total:estateOverview?.total??assets.length,inUse:estateOverview?.inUse??localInUse,available:estateOverview?.available??localAvailable,repair:estateOverview?.repair??localRepair,openFaults};},[assets,reportRows,estateOverview]);";
  if (!src.includes(statsNeedle)) throw new Error('Could not locate overview stats calculation.');
  src = src.replace(statsNeedle, statsReplacement);

  const typeNeedle = "const typeGroups=useMemo(()=>Object.entries(assets.reduce((acc,a)=>{const key=a.type||'Other';acc[key]=(acc[key]||0)+1;return acc;},{})).sort((a,b)=>b[1]-a[1]).slice(0,5),[assets]);";
  const typeReplacement = "const typeGroups=useMemo(()=>Object.entries(estateOverview?.byType||assets.reduce((acc,a)=>{const key=a.type||'Other';acc[key]=(acc[key]||0)+1;return acc;},{})).sort((a,b)=>b[1]-a[1]).slice(0,5),[assets,estateOverview]);";
  if (!src.includes(typeNeedle)) throw new Error('Could not locate overview type grouping.');
  src = src.replace(typeNeedle, typeReplacement);
}

fs.writeFileSync(path, src);
console.log('Prepared configurable Asset columns and filters.');
