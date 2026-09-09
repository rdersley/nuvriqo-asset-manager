import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke} from '@forge/bridge';
import * as XLSX from 'xlsx';
import './styles.css';

const norm=(v)=>String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
const aliases={
  deviceIdentifier:['deviceidentifier','deviceid','device','assetid','asset','devicename','hostname','terminalid'],
  crewCode:['crewcode','crew','user','username','staffcode','employeecode','assignmentreference','lastuser','lastloggedinuser'],
  lastLoginAt:['lastloginat','lastlogin','lastlogindate','logindate','lastseen','lastused','lastactivity'],
  source:['source','system','reportsource']
};
function mapRow(row){const out={};for(const [k,v] of Object.entries(row||{})){const nk=norm(k);for(const [target,list] of Object.entries(aliases)){if(list.includes(nk)){out[target]=v;break;}}}return out;}
const stateLabel={
  match:'Match',
  'crew-mismatch':'Crew mismatch',
  'crew-not-in-register':'Crew not in register',
  'device-not-in-assets':'Device not in Asset Manager',
  'crew-and-device-missing':'Crew and device not found',
  'no-current-assignment':'No current assignment'
};
function App(){
 const [rows,setRows]=useState([]),[report,setReport]=useState({rows:[]}),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[query,setQuery]=useState(''),[onlyReview,setOnlyReview]=useState(true);
 const load=async()=>{setLoading(true);try{setReport(await invoke('getUsageReconciliation'));setMessage('');}catch(e){setMessage(e.message||'Could not load reconciliation report.');}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 async function readFile(file){try{const data=await file.arrayBuffer();const wb=XLSX.read(data,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const raw=XLSX.utils.sheet_to_json(ws,{defval:''});const mapped=raw.map(mapRow).filter(r=>r.deviceIdentifier||r.crewCode);setRows(mapped);setMessage(mapped.length?`${mapped.length} device login records ready to import.`:'No usable rows found.');}catch(e){setMessage(e.message||'Could not read login report.');}}
 async function doImport(){if(!rows.length)return;setLoading(true);try{const result=await invoke('importDeviceUsage',{rows});setRows([]);await load();setMessage(`Device usage import complete: ${result.imported} imported${result.failed?.length?`, ${result.failed.length} failed`:''}.`);}catch(e){setMessage(e.message||'Device usage import failed.');}finally{setLoading(false);}}
 const filtered=useMemo(()=>safeRows(report.rows).filter(r=>{const q=query.trim().toLowerCase();const matches=!q||[r.deviceIdentifier,r.crewCode,r.crewName,r.assignedCrewCode,r.assetName,r.assetLocation].some(v=>String(v||'').toLowerCase().includes(q));return matches&&(!onlyReview||r.reviewRequired);}),[report,query,onlyReview]);
 return <div className="page"><header><div><h1>Device Usage Reconciliation</h1><p>Compare the crew member who last logged into each device with the imported crew register and Asset Manager's current assignment.</p></div><button onClick={load} disabled={loading}>Refresh</button></header>{message&&<div className="notice">{message}</div>}
 <section className="card import"><div><h2>Import device last-login report</h2><p>Upload Excel or CSV. Recognised columns include Device ID, Crew Code/User and Last Login/Last Seen.</p></div><input type="file" accept=".xlsx,.xls,.csv" onChange={e=>e.target.files?.[0]&&readFile(e.target.files[0])}/>{rows.length>0&&<button className="primary" onClick={doImport} disabled={loading}>Import {rows.length} records</button>}</section>
 <section className="kpis"><div><span>Imported devices</span><strong>{report.importedCount||0}</strong></div><div><span>Review required</span><strong>{report.reviewCount||0}</strong></div><div><span>Crew mismatches</span><strong>{report.mismatchCount||0}</strong></div><div><span>Clean matches</span><strong>{report.matchedCount||0}</strong></div><div><span>Crew not in register</span><strong>{report.notInCrewListCount||0}</strong></div><div><span>Devices not found</span><strong>{report.missingAssetCount||0}</strong></div></section>
 <section className="card"><div className="toolbar"><input placeholder="Search device, crew, name or location…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyReview} onChange={e=>setOnlyReview(e.target.checked)}/> Show exceptions only</label></div>{report.importedAt&&<p className="snapshot">Latest snapshot imported {new Date(report.importedAt).toLocaleString()}</p>}{loading?<div className="empty">Loading…</div>:<div className="tablewrap"><table><thead><tr><th>Device</th><th>Last logged-in crew</th><th>Crew name</th><th>Current assigned crew</th><th>Asset status</th><th>Location</th><th>Last login</th><th>Result</th></tr></thead><tbody>{filtered.map(r=><tr key={`${r.deviceIdentifier}-${r.crewCode}`}><td><strong>{r.deviceIdentifier}</strong>{r.assetName&&r.assetName!==r.deviceIdentifier?<small>{r.assetName}</small>:null}</td><td>{r.crewCode||'—'}</td><td>{r.crewName||'—'}</td><td>{r.assignedCrewCode||'Unassigned'}</td><td>{r.assetStatus||'—'}</td><td>{r.assetLocation||r.crewLocation||'—'}</td><td>{r.lastLoginAt?String(r.lastLoginAt):'—'}</td><td><span className={`state ${r.reviewRequired?'bad':'good'}`}>{stateLabel[r.state]||r.state}</span></td></tr>)}</tbody></table></div>}</section>
 <section className="card help"><h2>How to use the exceptions</h2><p><strong>Crew mismatch</strong> is the key signal: Asset Manager says the device belongs to one crew member, but another crew member was the last person to log in. This may indicate an undocumented swap, a replacement where the old device was not returned, or an incorrect assignment. Other exception types identify gaps in the crew register or asset register.</p></section>
 </div>;
}
function safeRows(value){return Array.isArray(value)?value:[];}
createRoot(document.getElementById('root')).render(<App/>);
