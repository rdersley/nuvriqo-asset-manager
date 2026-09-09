import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke,router,view} from '@forge/bridge';
import * as XLSX from 'xlsx';
import './styles.css';

const norm=(v)=>String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
const crewAliases={crewCode:['crewcode','crew','code','assignmentreference','staffcode','employeecode'],name:['name','crewname','displayname','fullname','employeename'],location:['location','base','station'],email:['email','emailaddress'],status:['status','employmentstatus'],notes:['notes','comment','comments']};
const usageAliases={deviceIdentifier:['deviceidentifier','deviceid','device','assetid','asset','devicename','hostname','terminalid'],crewCode:['crewcode','crew','user','username','staffcode','employeecode','assignmentreference','lastuser','lastloggedinuser'],lastLoginAt:['lastloginat','lastlogin','lastlogindate','logindate','lastseen','lastused','lastactivity'],source:['source','system','reportsource']};
function mapWithAliases(row,aliases){const out={};for(const [k,v] of Object.entries(row||{})){const nk=norm(k);for(const [target,list] of Object.entries(aliases)){if(list.includes(nk)){out[target]=v;break;}}}return out;}
async function sheetRows(file,aliases){const data=await file.arrayBuffer();const wb=XLSX.read(data,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];return XLSX.utils.sheet_to_json(ws,{defval:''}).map(r=>mapWithAliases(r,aliases));}
const chunk=(items,size)=>{const out=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out;};

function CrewTracking(){
 const [rows,setRows]=useState([]),[report,setReport]=useState([]),[selected,setSelected]=useState(null),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[query,setQuery]=useState(''),[onlyReview,setOnlyReview]=useState(false);
 const load=async()=>{setLoading(true);try{setReport(await invoke('getCrewReport'));setMessage('');}catch(e){setMessage(e.message||'Could not load crew report.');}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 async function readFile(file){try{const mapped=(await sheetRows(file,crewAliases)).filter(r=>Object.values(r).some(Boolean));setRows(mapped);setMessage(mapped.length?`${mapped.length} crew records ready to import.`:'No usable rows found.');}catch(e){setMessage(e.message||'Could not read file.');}}
 async function doImport(){
   if(!rows.length)return;
   setLoading(true);
   try{
     const batches=chunk(rows,100);
     let imported=0,failed=[];
     for(let i=0;i<batches.length;i+=1){
       setMessage(`Importing crew ${Math.min(i*100+1,rows.length)}-${Math.min((i+1)*100,rows.length)} of ${rows.length}…`);
       const result=await invoke('importCrew',{rows:batches[i]});
       imported+=result.imported||0;
       if(result.failed?.length)failed.push(...result.failed.map(f=>({...f,batch:i+1})));
     }
     setRows([]);
     await load();
     setMessage(`Crew import complete: ${imported} imported${failed.length?`, ${failed.length} failed`:''}.`);
   }catch(e){setMessage(`${e.message||'Crew import failed.'} The import is resumable: records already completed are kept; select the file again and rerun after the app refreshes.`);}finally{setLoading(false);}
 }
 const filtered=useMemo(()=>report.filter(c=>{const q=query.trim().toLowerCase();const matches=!q||[c.crewCode,c.name,c.location,...(c.historicalDevices||[])].some(v=>String(v||'').toLowerCase().includes(q));return matches&&(!onlyReview||c.reviewRequired);}),[report,query,onlyReview]);
 return <div className="page"><header><div><h1>Internal Crew Tracking</h1><p>Import the crew register and review current devices and Jira history by crew member.</p></div><button onClick={load} disabled={loading}>Refresh</button></header>{message&&<div className="notice">{message}</div>}
 <section className="card import"><div><h2>Crew register import</h2><p>Upload Excel or CSV. Recognised columns include Crew Code, Name, Location/Base, Email and Status. Large files are imported automatically in safe batches to avoid Forge timeouts.</p></div><input type="file" accept=".xlsx,.xls,.csv" onChange={e=>e.target.files?.[0]&&readFile(e.target.files[0])}/>{rows.length>0&&<button className="primary" onClick={doImport} disabled={loading}>Import {rows.length} crew</button>}</section>
 <section className="kpis"><div><span>Total crew</span><strong>{report.length}</strong></div><div><span>Review required</span><strong>{report.filter(c=>c.reviewRequired).length}</strong></div><div><span>Current devices</span><strong>{report.reduce((s,c)=>s+(c.currentDeviceCount||0),0)}</strong></div><div><span>Historical tickets</span><strong>{report.reduce((s,c)=>s+(c.ticketCount||0),0)}</strong></div></section>
 <section className="card"><div className="toolbar"><input placeholder="Search crew, name, location or device…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyReview} onChange={e=>setOnlyReview(e.target.checked)}/> Show review required only</label></div>{loading?<div className="empty">Loading…</div>:<div className="tablewrap"><table><thead><tr><th>Crew code</th><th>Name</th><th>Location</th><th>Current devices</th><th>Historical devices</th><th>Tickets</th><th>Review</th></tr></thead><tbody>{filtered.map(c=><tr key={c.crewCode} onClick={()=>setSelected(c)}><td><strong>{c.crewCode}</strong></td><td>{c.name||'—'}</td><td>{c.location||'—'}</td><td>{c.currentDeviceCount}</td><td>{c.historicalDeviceCount}</td><td>{c.ticketCount}</td><td>{c.reviewRequired?<span className="flag">Check devices</span>:'—'}</td></tr>)}</tbody></table></div>}</section>
 {selected&&<div className="modal" onClick={()=>setSelected(null)}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><div><h2>{selected.crewCode}{selected.name?` · ${selected.name}`:''}</h2><p>{selected.location||'No location'} · {selected.status||'—'}</p></div><button onClick={()=>setSelected(null)}>×</button></div>{selected.reviewRequired&&<div className="warning">This crew member currently has {selected.currentDeviceCount} devices assigned. Review whether older devices should have been returned.</div>}<h3>Currently assigned devices</h3>{selected.currentDevices?.length?<ul>{selected.currentDevices.map(d=><li key={d.id}><strong>{d.identifier}</strong> · {d.type||'Unknown type'} · {d.status||'—'} · {d.location||'—'}</li>)}</ul>:<p>No devices currently assigned.</p>}<h3>Historical devices</h3><div className="chips">{(selected.historicalDevices||[]).map(d=><span key={d}>{d}</span>)}</div><h3>Jira ticket history</h3>{selected.tickets?.length?<div className="tablewrap"><table><thead><tr><th>Issue</th><th>Created</th><th>Status</th><th>Devices</th><th>Summary</th></tr></thead><tbody>{selected.tickets.map(t=><tr key={t.key}><td><button className="link" onClick={()=>router.open(`/browse/${t.key}`)}>{t.key}</button></td><td>{t.created?new Date(t.created).toLocaleDateString():'—'}</td><td>{t.status||'—'}</td><td>{t.devices.join(', ')||'—'}</td><td>{t.summary||'—'}</td></tr>)}</tbody></table></div>:<p>No matching Jira tickets.</p>}</div></div>}
 </div>;
}

const stateLabel={match:'Match','crew-mismatch':'Crew mismatch','crew-not-in-register':'Crew not in register','device-not-in-assets':'Device not in Asset Manager','crew-and-device-missing':'Crew and device not found','no-current-assignment':'No current assignment'};
function DeviceUsage(){
 const [rows,setRows]=useState([]),[report,setReport]=useState({rows:[]}),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[query,setQuery]=useState(''),[onlyReview,setOnlyReview]=useState(true);
 const load=async()=>{setLoading(true);try{setReport(await invoke('getUsageReconciliation'));setMessage('');}catch(e){setMessage(e.message||'Could not load reconciliation report.');}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 async function readFile(file){try{const mapped=(await sheetRows(file,usageAliases)).filter(r=>r.deviceIdentifier||r.crewCode);setRows(mapped);setMessage(mapped.length?`${mapped.length} device login records ready to import.`:'No usable rows found.');}catch(e){setMessage(e.message||'Could not read login report.');}}
 async function doImport(){if(!rows.length)return;setLoading(true);try{const result=await invoke('importDeviceUsage',{rows});setRows([]);await load();setMessage(`Device usage import complete: ${result.imported} imported${result.failed?.length?`, ${result.failed.length} failed`:''}.`);}catch(e){setMessage(e.message||'Device usage import failed.');}finally{setLoading(false);}}
 const filtered=useMemo(()=>Array.isArray(report.rows)?report.rows.filter(r=>{const q=query.trim().toLowerCase();const matches=!q||[r.deviceIdentifier,r.crewCode,r.crewName,r.assignedCrewCode,r.assetName,r.assetLocation].some(v=>String(v||'').toLowerCase().includes(q));return matches&&(!onlyReview||r.reviewRequired);}):[],[report,query,onlyReview]);
 return <div className="page"><header><div><h1>Device Usage Reconciliation</h1><p>Compare the crew member who last logged into each device with the crew register and Asset Manager's current assignment.</p></div><button onClick={load} disabled={loading}>Refresh</button></header>{message&&<div className="notice">{message}</div>}
 <section className="card import"><div><h2>Import device last-login report</h2><p>Upload Excel or CSV. Recognised columns include Device ID, Crew Code/User and Last Login/Last Seen.</p></div><input type="file" accept=".xlsx,.xls,.csv" onChange={e=>e.target.files?.[0]&&readFile(e.target.files[0])}/>{rows.length>0&&<button className="primary" onClick={doImport} disabled={loading}>Import {rows.length} records</button>}</section>
 <section className="kpis usage-kpis"><div><span>Imported devices</span><strong>{report.importedCount||0}</strong></div><div><span>Review required</span><strong>{report.reviewCount||0}</strong></div><div><span>Crew mismatches</span><strong>{report.mismatchCount||0}</strong></div><div><span>Clean matches</span><strong>{report.matchedCount||0}</strong></div><div><span>Crew not in register</span><strong>{report.notInCrewListCount||0}</strong></div><div><span>Devices not found</span><strong>{report.missingAssetCount||0}</strong></div></section>
 <section className="card"><div className="toolbar"><input placeholder="Search device, crew, name or location…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyReview} onChange={e=>setOnlyReview(e.target.checked)}/> Show exceptions only</label></div>{report.importedAt&&<p className="snapshot">Latest snapshot imported {new Date(report.importedAt).toLocaleString()}</p>}{loading?<div className="empty">Loading…</div>:<div className="tablewrap"><table><thead><tr><th>Device</th><th>Last logged-in crew</th><th>Crew name</th><th>Current assigned crew</th><th>Asset status</th><th>Location</th><th>Last login</th><th>Result</th></tr></thead><tbody>{filtered.map(r=><tr key={`${r.deviceIdentifier}-${r.crewCode}`}><td><strong>{r.deviceIdentifier}</strong>{r.assetName&&r.assetName!==r.deviceIdentifier?<small className="subline">{r.assetName}</small>:null}</td><td>{r.crewCode||'—'}</td><td>{r.crewName||'—'}</td><td>{r.assignedCrewCode||'Unassigned'}</td><td>{r.assetStatus||'—'}</td><td>{r.assetLocation||r.crewLocation||'—'}</td><td>{r.lastLoginAt?String(r.lastLoginAt):'—'}</td><td><span className={`state ${r.reviewRequired?'bad':'good'}`}>{stateLabel[r.state]||r.state}</span></td></tr>)}</tbody></table></div>}</section>
 <section className="card help"><h2>How to use the exceptions</h2><p><strong>Crew mismatch</strong> is the key signal: Asset Manager says the device belongs to one crew member, but another crew member was the last person to log in. This may indicate an undocumented swap, a replacement where the old device was not returned, or an incorrect assignment.</p></section></div>;
}

function App(){
 const [route,setRoute]=useState('crew-tracking');
 useEffect(()=>{let unlisten;view.createHistory().then(history=>{const apply=location=>{const p=(location?.pathname||'').replace(/^\/+|\/+$/g,'');setRoute(p==='device-usage'?'device-usage':'crew-tracking');};apply(history.location);unlisten=history.listen(apply);}).catch(()=>{});return()=>unlisten?.();},[]);
 return route==='device-usage'?<DeviceUsage/>:<CrewTracking/>;
}
createRoot(document.getElementById('root')).render(<App/>);
