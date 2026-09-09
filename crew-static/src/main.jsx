import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {invoke,router} from '@forge/bridge';
import * as XLSX from 'xlsx';
import './styles.css';

const norm=(v)=>String(v||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'');
const aliases={
  crewCode:['crewcode','crew','code','assignmentreference','staffcode','employeecode'],
  name:['name','crewname','displayname','fullname','employeename'],
  location:['location','base','station'],
  email:['email','emailaddress'],
  status:['status','employmentstatus'],
  notes:['notes','comment','comments']
};
function mapRow(row){const out={};for(const [k,v] of Object.entries(row||{})){const nk=norm(k);for(const [target,list] of Object.entries(aliases)){if(list.includes(nk)){out[target]=v;break;}}}return out;}

function App(){
 const [rows,setRows]=useState([]),[report,setReport]=useState([]),[selected,setSelected]=useState(null),[message,setMessage]=useState(''),[loading,setLoading]=useState(false),[query,setQuery]=useState(''),[onlyReview,setOnlyReview]=useState(false);
 const load=async()=>{setLoading(true);try{setReport(await invoke('getCrewReport'));setMessage('');}catch(e){setMessage(e.message||'Could not load crew report.');}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 async function readFile(file){try{const data=await file.arrayBuffer();const wb=XLSX.read(data,{type:'array'});const ws=wb.Sheets[wb.SheetNames[0]];const raw=XLSX.utils.sheet_to_json(ws,{defval:''});const mapped=raw.map(mapRow).filter(r=>Object.values(r).some(Boolean));setRows(mapped);setMessage(mapped.length?`${mapped.length} crew records ready to import.`:'No usable rows found.');}catch(e){setMessage(e.message||'Could not read file.');}}
 async function doImport(){if(!rows.length)return;setLoading(true);try{const result=await invoke('importCrew',{rows});setMessage(`Crew import complete: ${result.imported} imported${result.failed?.length?`, ${result.failed.length} failed`:''}.`);setRows([]);await load();}catch(e){setMessage(e.message||'Crew import failed.');}finally{setLoading(false);}}
 const filtered=useMemo(()=>report.filter(c=>{const q=query.trim().toLowerCase();const matches=!q||[c.crewCode,c.name,c.location,...c.historicalDevices].some(v=>String(v||'').toLowerCase().includes(q));return matches&&(!onlyReview||c.reviewRequired);}),[report,query,onlyReview]);
 return <div className="page"><header><div><h1>Internal Crew Tracking</h1><p>Import the full crew register and review every Jira ticket and device historically linked to each crew member.</p></div><button onClick={load} disabled={loading}>Refresh</button></header>{message&&<div className="notice">{message}</div>}
 <section className="card import"><div><h2>Crew register import</h2><p>Upload an Excel or CSV file. Recognised columns include Crew Code, Name, Location/Base, Email and Status.</p></div><input type="file" accept=".xlsx,.xls,.csv" onChange={e=>e.target.files?.[0]&&readFile(e.target.files[0])}/>{rows.length>0&&<button className="primary" onClick={doImport} disabled={loading}>Import {rows.length} crew</button>}</section>
 <section className="kpis"><div><span>Total crew</span><strong>{report.length}</strong></div><div><span>Review required</span><strong>{report.filter(c=>c.reviewRequired).length}</strong></div><div><span>Current devices</span><strong>{report.reduce((s,c)=>s+c.currentDeviceCount,0)}</strong></div><div><span>Historical tickets</span><strong>{report.reduce((s,c)=>s+c.ticketCount,0)}</strong></div></section>
 <section className="card"><div className="toolbar"><input placeholder="Search crew, name, location or device…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyReview} onChange={e=>setOnlyReview(e.target.checked)}/> Show review required only</label></div>{loading?<div className="empty">Loading…</div>:<div className="tablewrap"><table><thead><tr><th>Crew code</th><th>Name</th><th>Location</th><th>Current devices</th><th>Historical devices</th><th>Tickets</th><th>Review</th></tr></thead><tbody>{filtered.map(c=><tr key={c.crewCode} onClick={()=>setSelected(c)}><td><strong>{c.crewCode}</strong></td><td>{c.name||'—'}</td><td>{c.location||'—'}</td><td>{c.currentDeviceCount}</td><td>{c.historicalDeviceCount}</td><td>{c.ticketCount}</td><td>{c.reviewRequired?<span className="flag">Check devices</span>:'—'}</td></tr>)}</tbody></table></div>}</section>
 {selected&&<div className="modal" onClick={()=>setSelected(null)}><div className="dialog" onClick={e=>e.stopPropagation()}><div className="dialoghead"><div><h2>{selected.crewCode}{selected.name?` · ${selected.name}`:''}</h2><p>{selected.location||'No location'} · {selected.status||'—'}</p></div><button onClick={()=>setSelected(null)}>×</button></div>{selected.reviewRequired&&<div className="warning">This crew member currently has {selected.currentDeviceCount} devices assigned. Review whether older devices should have been returned.</div>}<h3>Currently assigned devices</h3>{selected.currentDevices.length?<ul>{selected.currentDevices.map(d=><li key={d.id}><strong>{d.identifier}</strong> · {d.type||'Unknown type'} · {d.status||'—'} · {d.location||'—'}</li>)}</ul>:<p>No devices currently assigned.</p>}<h3>Historical devices</h3><div className="chips">{selected.historicalDevices.map(d=><span key={d}>{d}</span>)}</div><h3>Jira ticket history</h3>{selected.tickets.length?<div className="tablewrap"><table><thead><tr><th>Issue</th><th>Created</th><th>Status</th><th>Devices</th><th>Summary</th></tr></thead><tbody>{selected.tickets.map(t=><tr key={t.key}><td><button className="link" onClick={()=>router.open(`/browse/${t.key}`)}>{t.key}</button></td><td>{t.created?new Date(t.created).toLocaleDateString():'—'}</td><td>{t.status||'—'}</td><td>{t.devices.join(', ')||'—'}</td><td>{t.summary||'—'}</td></tr>)}</tbody></table></div>:<p>No matching Jira tickets.</p>}</div></div>}
 </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
