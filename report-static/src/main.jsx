import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@forge/bridge';
import './styles.css';
import { downloadCsv } from '../../shared/csv.js';

const formatDate = (value) => value ? new Date(value).toLocaleDateString() : '—';

function Bars({ title, rows }) {
  const max=Math.max(...rows.map(r=>r.count),1);
  return <div className="card"><h2>{title}</h2><div className="bars">{rows.slice(0,10).map(row=><div key={row.name}><span>{row.name}</span><div><i style={{width:`${Math.max(4,Math.round(row.count/max*100))}%`}}/></div><b>{row.count}</b></div>)}</div></div>;
}

function App(){
  const [data,setData]=useState(null); const [error,setError]=useState(''); const [view,setView]=useState('inventory'); const [query,setQuery]=useState('');
  useEffect(()=>{invoke('getOperationalReports').then(setData).catch(e=>setError(e?.message||'Could not load reports.'));},[]);
  const rows=useMemo(()=>{if(!data)return[];const q=query.trim().toLowerCase();if(!q)return data.rows;return data.rows.filter(r=>[r.name,r.deviceId,r.type,r.manufacturer,r.model,r.serialNumber,r.holder,r.assignmentReference,r.status,r.location,...r.organisations,...r.qualityFlags].some(v=>String(v||'').toLowerCase().includes(q)));},[data,query]);
  if(error)return <main><div className="state error">{error}</div></main>;
  if(!data)return <main><div className="state">Loading Asset Manager reporting…</div></main>;
  const s=data.summary;
  const exportRows=rows.map(r=>[r.deviceId,r.name,r.type,r.manufacturer,r.model,r.serialNumber,r.holder,r.assignmentReference,r.status,r.location,r.organisations.join('; '),r.primaryFaults,r.openFaults,r.resolvedFaults,r.latestFaultKey,r.latestFaultDate,r.purchaseDate,r.warrantyExpiry,r.warrantyState,r.qualityFlags.join('; ')]);
  const tableRows=view==='faults'?[...rows].sort((a,b)=>b.primaryFaults-a.primaryFaults||b.openFaults-a.openFaults):view==='quality'?rows.filter(r=>r.qualityFlags.length):view==='assignment'?[...rows].sort((a,b)=>String(a.holder||'').localeCompare(String(b.holder||''))):rows;
  return <main>
    <header><div><span className="brand">NUVRIQO</span><h1>Asset Reports</h1><p>Operational reporting across inventory, faults, assignments, organisations and data quality.</p></div><button className="primary" onClick={()=>downloadCsv(`nuvriqo-asset-report-${new Date().toISOString().slice(0,10)}.csv`,['Device ID','Device name','Type','Manufacturer','Model','Serial number','Holder','Assignment reference','Status','Location','Organisations','Primary faults','Open faults','Resolved faults','Latest fault','Latest fault date','Purchase date','Warranty expiry','Warranty state','Data quality issues'],exportRows)}>Export CSV</button></header>
    {data.jiraWarning&&<div className="notice">{data.jiraWarning}</div>}
    <section className="kpis"><div><small>Total assets</small><strong>{s.totalAssets}</strong></div><div><small>In use</small><strong>{s.inUse}</strong></div><div><small>Available</small><strong>{s.available}</strong></div><div><small>In repair</small><strong>{s.inRepair}</strong></div><div><small>Open faults</small><strong>{s.openFaults}</strong></div><div><small>Unassigned</small><strong>{s.unassigned}</strong></div><div><small>Warranty ≤90 days</small><strong>{s.warrantyExpiring}</strong></div><div><small>Data quality issues</small><strong>{s.dataQualityIssues}</strong></div></section>
    <section className="charts"><Bars title="Assets by type" rows={data.groups.byType}/><Bars title="Assets by status" rows={data.groups.byStatus}/><Bars title="Assets by location" rows={data.groups.byLocation}/></section>
    <div className="toolbar"><div className="tabs"><button className={view==='inventory'?'active':''} onClick={()=>setView('inventory')}>Inventory</button><button className={view==='faults'?'active':''} onClick={()=>setView('faults')}>Faults</button><button className={view==='assignment'?'active':''} onClick={()=>setView('assignment')}>Assignments</button><button className={view==='organisations'?'active':''} onClick={()=>setView('organisations')}>Organisations</button><button className={view==='quality'?'active':''} onClick={()=>setView('quality')}>Data quality</button></div><input placeholder="Search report…" value={query} onChange={e=>setQuery(e.target.value)}/></div>
    {view==='organisations'?<div className="card"><h2>Organisation summary</h2>{data.organisations.length?<div className="table-wrap"><table><thead><tr><th>Organisation</th><th>Assets</th><th>Primary faults</th><th>Open faults</th></tr></thead><tbody>{data.organisations.map(o=><tr key={o.name}><td><strong>{o.name}</strong></td><td>{o.assets}</td><td>{o.faults}</td><td>{o.openFaults}</td></tr>)}</tbody></table></div>:<div className="empty">No organisation-linked assets found yet.</div>}</div>:<div className="card"><div className="table-wrap"><table><thead><tr><th>Device</th><th>Type</th><th>Holder</th><th>Status</th><th>Location</th><th>Organisation</th>{view==='faults'&&<><th>Faults</th><th>Open</th><th>Latest</th></>}{view==='quality'&&<th>Issues</th>}{view==='inventory'&&<><th>Serial</th><th>Warranty</th></>}</tr></thead><tbody>{tableRows.map(r=><tr key={r.id}><td><strong>{r.name||r.deviceId}</strong><small>{r.deviceId!==r.name?r.deviceId:''}</small></td><td>{r.type||'—'}</td><td>{r.holder||'Unassigned'}</td><td>{r.status||'—'}</td><td>{r.location||'—'}</td><td>{r.organisations.join(', ')||'—'}</td>{view==='faults'&&<><td>{r.primaryFaults}</td><td>{r.openFaults}</td><td>{r.latestFaultKey?<><strong>{r.latestFaultKey}</strong><small>{formatDate(r.latestFaultDate)}</small></>:'—'}</td></>}{view==='quality'&&<td>{r.qualityFlags.join(', ')}</td>}{view==='inventory'&&<><td>{r.serialNumber||'—'}</td><td>{r.warrantyState}{r.warrantyExpiry?<small>{formatDate(r.warrantyExpiry)}</small>:null}</td></>}</tr>)}</tbody></table></div></div>}
    <footer>Generated {new Date(data.generatedAt).toLocaleString()}</footer>
  </main>;
}

createRoot(document.getElementById('root')).render(<App/>);
