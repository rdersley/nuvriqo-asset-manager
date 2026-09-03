import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import './styles.css';

const emptyAsset = {
  id: '', name: '', type: 'Laptop', manufacturer: '', model: '', serialNumber: '',
  assigneeAccountId: '', assigneeName: '', status: 'Available', location: '',
  purchaseDate: '', warrantyExpiry: '', notes: '', customFields: {}
};

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(cell); cell = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row); row = []; cell = ''; continue;
    }
    cell += ch;
  }
  row.push(cell); if (row.some((v) => v.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
  const map = {
    assetid: 'id', id: 'id', name: 'name', devicename: 'name', type: 'type', manufacturer: 'manufacturer',
    model: 'model', serial: 'serialNumber', serialnumber: 'serialNumber', assignee: 'assigneeName', assignedto: 'assigneeName',
    status: 'status', location: 'location', purchasedate: 'purchaseDate', warrantyexpiry: 'warrantyExpiry', notes: 'notes'
  };
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [map[h] || h, r[idx] ?? ''])));
}

function UserPicker({ asset, setAsset }) {
  const [query, setQuery] = useState(asset.assigneeName || '');
  const [results, setResults] = useState([]);
  useEffect(() => { setQuery(asset.assigneeName || ''); }, [asset.assigneeName]);
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.trim().length < 2 || query === asset.assigneeName) return setResults([]);
      try { setResults(await invoke('searchUsers', { query })); } catch { setResults([]); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, asset.assigneeName]);
  return <div className="user-picker">
    <input value={query} placeholder="Search Jira users…" onChange={(e) => {
      setQuery(e.target.value);
      if (!e.target.value) setAsset({ ...asset, assigneeAccountId: '', assigneeName: '' });
    }} />
    {results.length > 0 && <div className="user-results">
      {results.map((user) => <button type="button" key={user.accountId} onClick={() => {
        setAsset({ ...asset, assigneeAccountId: user.accountId, assigneeName: user.displayName });
        setQuery(user.displayName); setResults([]);
      }}><img src={user.avatarUrl} alt="" />{user.displayName}</button>)}
    </div>}
  </div>;
}

function AssetForm({ asset, settings, onSave, onCancel }) {
  const [draft, setDraft] = useState({ ...emptyAsset, ...asset });
  useEffect(() => setDraft({ ...emptyAsset, ...asset }), [asset]);
  const update = (field, value) => setDraft((prev) => ({ ...prev, [field]: value }));
  return <div className="card form-card">
    <div className="section-head"><div><h2>{draft.id ? 'Edit asset' : 'Add asset'}</h2><p>Keep the record simple and support-focused.</p></div></div>
    <div className="form-grid">
      <label>Device name<input value={draft.name} onChange={(e) => update('name', e.target.value)} /></label>
      <label>Asset type<select value={draft.type} onChange={(e) => update('type', e.target.value)}>{settings.assetTypes.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>Manufacturer<input value={draft.manufacturer} onChange={(e) => update('manufacturer', e.target.value)} /></label>
      <label>Model<input value={draft.model} onChange={(e) => update('model', e.target.value)} /></label>
      <label>Serial number<input value={draft.serialNumber} onChange={(e) => update('serialNumber', e.target.value)} /></label>
      <label>Assigned to<UserPicker asset={draft} setAsset={setDraft} /></label>
      <label>Status<select value={draft.status} onChange={(e) => update('status', e.target.value)}>{settings.statuses.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>Location<select value={draft.location} onChange={(e) => update('location', e.target.value)}><option value="">—</option>{settings.locations.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>Purchase date<input type="date" value={draft.purchaseDate} onChange={(e) => update('purchaseDate', e.target.value)} /></label>
      <label>Warranty expiry<input type="date" value={draft.warrantyExpiry} onChange={(e) => update('warrantyExpiry', e.target.value)} /></label>
      {settings.customFields.map((field) => <label key={field.key}>{field.label}<input type={field.type === 'date' ? 'date' : 'text'} value={draft.customFields?.[field.key] || ''} onChange={(e) => setDraft((prev) => ({ ...prev, customFields: { ...prev.customFields, [field.key]: e.target.value } }))} /></label>)}
      <label className="wide">Notes<textarea rows="4" value={draft.notes} onChange={(e) => update('notes', e.target.value)} /></label>
    </div>
    <div className="actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onSave(draft)} disabled={!draft.name.trim()}>Save asset</button></div>
  </div>;
}

function Settings({ initial, onSave, onClose }) {
  const [settings, setSettings] = useState(initial);
  const asLines = (items) => items.join('\n');
  const fromLines = (value) => value.split('\n').map((x) => x.trim()).filter(Boolean);
  return <div className="card form-card"><div className="section-head"><div><h2>Asset settings</h2><p>Keep lists short and familiar to your service desk.</p></div></div>
    <div className="form-grid">
      <label>Asset types<textarea rows="8" value={asLines(settings.assetTypes)} onChange={(e) => setSettings({ ...settings, assetTypes: fromLines(e.target.value) })} /></label>
      <label>Statuses<textarea rows="8" value={asLines(settings.statuses)} onChange={(e) => setSettings({ ...settings, statuses: fromLines(e.target.value) })} /></label>
      <label>Locations<textarea rows="8" value={asLines(settings.locations)} onChange={(e) => setSettings({ ...settings, locations: fromLines(e.target.value) })} /></label>
      <label>Custom fields<textarea rows="8" placeholder="assetOwner | Asset owner | text\nreplacementDate | Replacement date | date" value={(settings.customFields || []).map((f) => `${f.key} | ${f.label} | ${f.type}`).join('\n')} onChange={(e) => setSettings({ ...settings, customFields: e.target.value.split('\n').map((line) => { const [key, label, type = 'text'] = line.split('|').map((x) => x.trim()); return { key, label, type }; }).filter((f) => f.key && f.label) })} /></label>
    </div>
    <div className="actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(settings)}>Save settings</button></div>
  </div>;
}

function AssetDetail({ asset, settings, onEdit, onBack }) {
  const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]);
  useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); }, [asset.id]);
  const details = [['Asset ID', asset.id], ['Type', asset.type], ['Manufacturer', asset.manufacturer], ['Model', asset.model], ['Serial number', asset.serialNumber], ['Assigned to', asset.assigneeName || 'Unassigned'], ['Status', asset.status], ['Location', asset.location || '—'], ['Purchase date', asset.purchaseDate || '—'], ['Warranty expiry', asset.warrantyExpiry || '—']];
  return <><div className="toolbar"><button className="secondary" onClick={onBack}>← Assets</button><button className="primary" onClick={onEdit}>Edit asset</button></div>
    <div className="card detail-hero"><div><span className="eyebrow">{asset.id}</span><h1>{asset.name}</h1><p>{asset.manufacturer} {asset.model}</p></div><span className="status-pill">{asset.status}</span></div>
    <div className="detail-grid"><div className="card"><h2>Asset details</h2><dl>{details.map(([k,v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v || '—'}</dd></React.Fragment>)}{settings.customFields.map((f) => <React.Fragment key={f.key}><dt>{f.label}</dt><dd>{asset.customFields?.[f.key] || '—'}</dd></React.Fragment>)}</dl>{asset.notes && <div className="notes"><strong>Notes</strong><p>{asset.notes}</p></div>}</div>
    <div className="card"><h2>Linked Jira tickets</h2>{tickets.length ? <div className="ticket-list">{tickets.map((t) => <div key={t.key}><strong>{t.key}</strong><span>{t.summary || 'Ticket'}</span><small>{t.status}</small></div>)}</div> : <div className="empty-small">No linked tickets yet.</div>}</div></div>
    <div className="card"><h2>Activity</h2>{history.length ? <div className="timeline">{history.map((event, i) => <div key={`${event.timestamp}-${i}`}><span className="dot"/><div><strong>{event.message}</strong><small>{new Date(event.timestamp).toLocaleString()}</small>{event.changes?.map((c) => <p key={c.field}>{c.field}: {c.from || '—'} → {c.to || '—'}</p>)}</div></div>)}</div> : <div className="empty-small">No activity recorded.</div>}</div>
  </>;
}

function IssuePanel() {
  const [ctx, setCtx] = useState(null); const [assets, setAssets] = useState([]); const [selected, setSelected] = useState('');
  async function refresh() { const data = await invoke('getIssueContext'); setCtx(data); const list = await invoke('listAssets', {}); setAssets(list); }
  useEffect(() => { refresh().catch(() => setCtx({ error: true })); }, []);
  if (!ctx) return <div className="panel">Loading assets…</div>;
  return <div className="panel">{ctx.linkedAsset ? <><div className="panel-asset"><strong>{ctx.linkedAsset.name}</strong><span>{ctx.linkedAsset.id} · {ctx.linkedAsset.serialNumber || 'No serial'}</span><small>{ctx.linkedAsset.assigneeName || 'Unassigned'} · {ctx.linkedAsset.status}</small></div><button className="secondary" onClick={async () => { await invoke('unlinkAssetFromIssue', { issueKey: ctx.issueKey }); await refresh(); }}>Unlink asset</button></> : <><p>Link the device this ticket is about.</p><div className="panel-row"><select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select an asset…</option>{assets.map((a) => <option value={a.id} key={a.id}>{a.id} — {a.name}{a.assigneeName ? ` — ${a.assigneeName}` : ''}</option>)}</select><button className="primary" disabled={!selected} onClick={async () => { await invoke('linkAssetToIssue', { issueKey: ctx.issueKey, assetId: selected }); await refresh(); }}>Link</button></div></>}</div>;
}

function App() {
  const [context, setContext] = useState(null); const [assets, setAssets] = useState([]); const [settings, setSettings] = useState({ assetTypes: [], statuses: [], locations: [], customFields: [] });
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [type, setType] = useState(''); const [location, setLocation] = useState('');
  const [mode, setMode] = useState('list'); const [selected, setSelected] = useState(null); const [message, setMessage] = useState('');
  const load = async () => { const [assetRows, cfg] = await Promise.all([invoke('listAssets', { query, status, type, location }), invoke('getSettings')]); setAssets(assetRows); setSettings(cfg); };
  useEffect(() => { view.getContext().then(setContext); }, []);
  useEffect(() => { if (context?.extension?.type !== 'jira:issuePanel') load().catch((e) => setMessage(e.message)); }, [query, status, type, location, context]);
  if (context?.extension?.type === 'jira:issuePanel') return <IssuePanel />;
  const stats = useMemo(() => ({ total: assets.length, inUse: assets.filter((a) => a.status === 'In Use' || a.status === 'Assigned').length, available: assets.filter((a) => a.status === 'Available').length, repair: assets.filter((a) => a.status === 'Repair').length }), [assets]);
  async function saveAsset(asset) { try { const saved = await invoke('saveAsset', { asset }); setSelected(saved); setMode('detail'); setMessage('Asset saved.'); await load(); } catch (e) { setMessage(e.message || 'Could not save asset.'); } }
  async function importCsv(file) { const text = await file.text(); const rows = parseCsv(text); const result = await invoke('bulkImportAssets', { assets: rows }); setMessage(`Imported ${result.imported} asset${result.imported === 1 ? '' : 's'}${result.failed.length ? `; ${result.failed.length} failed` : ''}.`); await load(); }
  function exportCsv() { const headers = ['Asset ID','Name','Type','Manufacturer','Model','Serial Number','Assigned To','Status','Location','Purchase Date','Warranty Expiry','Notes']; const rows = assets.map((a) => [a.id,a.name,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location,a.purchaseDate,a.warrantyExpiry,a.notes]); const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n'); const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `nuvriqo-assets-${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url); }
  if (mode === 'form') return <main><AssetForm asset={selected || emptyAsset} settings={settings} onSave={saveAsset} onCancel={() => setMode(selected?.id ? 'detail' : 'list')} /></main>;
  if (mode === 'settings') return <main><Settings initial={settings} onClose={() => setMode('list')} onSave={async (cfg) => { const saved = await invoke('saveSettings', { settings: cfg }); setSettings(saved); setMode('list'); setMessage('Settings saved.'); }} /></main>;
  if (mode === 'detail' && selected) return <main><AssetDetail asset={selected} settings={settings} onBack={() => { setMode('list'); setSelected(null); }} onEdit={() => setMode('form')} /></main>;
  return <main>
    <div className="topbar"><div><span className="brand">NUVRIQO</span><h1>Asset Manager</h1><p>Simple device tracking for Jira and JSM.</p></div><div className="top-actions"><button className="secondary" onClick={() => setMode('settings')}>Settings</button><button className="primary" onClick={() => { setSelected(null); setMode('form'); }}>+ Add asset</button></div></div>
    {message && <div className="notice" onClick={() => setMessage('')}>{message}</div>}
    <div className="stats"><div><strong>{stats.total}</strong><span>Total assets</span></div><div><strong>{stats.inUse}</strong><span>In use</span></div><div><strong>{stats.available}</strong><span>Available</span></div><div><strong>{stats.repair}</strong><span>Repair</span></div></div>
    <div className="card"><div className="filters"><input className="search" placeholder="Search asset, serial, user…" value={query} onChange={(e) => setQuery(e.target.value)} /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{settings.statuses.map((x) => <option key={x}>{x}</option>)}</select><select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{settings.assetTypes.map((x) => <option key={x}>{x}</option>)}</select><select value={location} onChange={(e) => setLocation(e.target.value)}><option value="">All locations</option>{settings.locations.map((x) => <option key={x}>{x}</option>)}</select>
      <label className="file-button">Import CSV<input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} /></label><button className="secondary" onClick={exportCsv}>Export CSV</button></div>
      {assets.length ? <div className="table-wrap"><table><thead><tr><th>Asset</th><th>Type</th><th>Serial</th><th>Assigned to</th><th>Status</th><th>Location</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id} onClick={() => { setSelected(asset); setMode('detail'); }}><td><strong>{asset.name}</strong><small>{asset.id}</small></td><td>{asset.type}</td><td>{asset.serialNumber || '—'}</td><td>{asset.assigneeName || 'Unassigned'}</td><td><span className="status-pill">{asset.status}</span></td><td>{asset.location || '—'}</td></tr>)}</tbody></table></div> : <div className="empty"><h2>No assets found</h2><p>Add your first device or import a CSV register.</p></div>}
    </div>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
