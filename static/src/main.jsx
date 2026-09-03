import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import ImportDialog from './ImportDialog';
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
    <div className="section-head"><div><h2>{draft.id ? 'Edit asset' : 'Add asset'}</h2><p>Device Name is required and must be unique.</p></div></div>
    <div className="form-grid">
      <label>Device name *<input value={draft.name} onChange={(e) => update('name', e.target.value)} autoFocus /></label>
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
  return <div className="card form-card"><div className="section-head"><div><h2>Asset settings</h2><p>Configure the short lists used by your service desk.</p></div></div>
    <div className="form-grid">
      <label>Asset types<textarea rows="8" value={asLines(settings.assetTypes)} onChange={(e) => setSettings({ ...settings, assetTypes: fromLines(e.target.value) })} /></label>
      <label>Statuses<textarea rows="8" value={asLines(settings.statuses)} onChange={(e) => setSettings({ ...settings, statuses: fromLines(e.target.value) })} /></label>
      <label>Locations<textarea rows="8" value={asLines(settings.locations)} onChange={(e) => setSettings({ ...settings, locations: fromLines(e.target.value) })} /></label>
      <label>Custom fields<textarea rows="8" placeholder="assetOwner | Asset owner | text\nreplacementDate | Replacement date | date" value={(settings.customFields || []).map((f) => `${f.key} | ${f.label} | ${f.type}`).join('\n')} onChange={(e) => setSettings({ ...settings, customFields: e.target.value.split('\n').map((line) => { const [key, label, type = 'text'] = line.split('|').map((x) => x.trim()); return { key, label, type }; }).filter((f) => f.key && f.label) })} /></label>
    </div>
    <div className="actions"><button className="secondary" onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(settings)}>Save settings</button></div>
  </div>;
}

function AssetDetail({ asset, settings, onEdit, onDelete, onBack }) {
  const [tickets, setTickets] = useState([]); const [history, setHistory] = useState([]);
  useEffect(() => { invoke('getAssetTickets', { assetId: asset.id }).then(setTickets).catch(() => setTickets([])); invoke('getAssetHistory', { assetId: asset.id }).then(setHistory).catch(() => setHistory([])); }, [asset.id]);
  const details = [['Asset ID', asset.id], ['Type', asset.type], ['Manufacturer', asset.manufacturer], ['Model', asset.model], ['Serial number', asset.serialNumber], ['Assigned to', asset.assigneeName || 'Unassigned'], ['Status', asset.status], ['Location', asset.location || '—'], ['Purchase date', asset.purchaseDate || '—'], ['Warranty expiry', asset.warrantyExpiry || '—']];
  return <><div className="toolbar"><button className="secondary" onClick={onBack}>← Assets</button><div className="actions"><button className="secondary" onClick={onDelete}>Delete</button><button className="primary" onClick={onEdit}>Edit asset</button></div></div>
    <div className="card detail-hero"><div><span className="eyebrow">{asset.id}</span><h1>{asset.name}</h1><p>{[asset.manufacturer, asset.model].filter(Boolean).join(' ') || 'Device'}</p></div><span className="status-pill">{asset.status}</span></div>
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
  return <div className="panel">{ctx.linkedAsset ? <><div className="panel-asset"><strong>{ctx.linkedAsset.name}</strong><span>{ctx.linkedAsset.serialNumber || 'No serial number'}</span><small>{ctx.linkedAsset.assigneeName || 'Unassigned'} · {ctx.linkedAsset.status}</small></div><button className="secondary" onClick={async () => { await invoke('unlinkAssetFromIssue', { issueKey: ctx.issueKey }); await refresh(); }}>Unlink device</button></> : <><p>Link the device this ticket is about.</p><div className="panel-row"><select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select a device…</option>{assets.map((a) => <option value={a.id} key={a.id}>{a.name}</option>)}</select><button className="primary" disabled={!selected} onClick={async () => { await invoke('linkAssetToIssue', { issueKey: ctx.issueKey, assetId: selected }); await refresh(); }}>Link</button></div></>}</div>;
}

function App() {
  const [context, setContext] = useState(null); const [assets, setAssets] = useState([]); const [settings, setSettings] = useState({ assetTypes: [], statuses: [], locations: [], customFields: [] });
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [type, setType] = useState(''); const [location, setLocation] = useState('');
  const [mode, setMode] = useState('list'); const [selected, setSelected] = useState(null); const [message, setMessage] = useState(''); const [showImport, setShowImport] = useState(false);
  const load = async () => { const [assetRows, cfg] = await Promise.all([invoke('listAssets', { query, status, type, location }), invoke('getSettings')]); setAssets(assetRows); setSettings(cfg); };
  useEffect(() => { view.getContext().then(setContext); }, []);
  useEffect(() => { if (context?.extension?.type !== 'jira:issuePanel') load().catch((e) => setMessage(e.message)); }, [query, status, type, location, context]);
  if (context?.extension?.type === 'jira:issuePanel') return <IssuePanel />;
  const stats = useMemo(() => ({ total: assets.length, inUse: assets.filter((a) => a.status === 'In Use' || a.status === 'Assigned').length, available: assets.filter((a) => a.status === 'Available').length, repair: assets.filter((a) => a.status === 'Repair').length }), [assets]);

  async function saveAsset(asset) {
    try { const saved = await invoke('saveAsset', { asset }); setSelected(saved); setMode('detail'); setMessage('Asset saved.'); await load(); }
    catch (e) { setMessage(e.message || 'Could not save asset.'); }
  }

  async function importAssets(rows) {
    const result = await invoke('bulkImportAssets', { assets: rows });
    const failures = result.failed || [];
    setMessage(`Import complete: ${result.imported} created${failures.length ? `, ${failures.length} failed` : ''}.`);
    await load();
    if (failures.length) throw new Error(failures.slice(0, 5).map((f) => `Row ${f.row}: ${f.message}`).join(' '));
  }

  async function deleteSelected() {
    if (!selected) return;
    if (!window.confirm(`Delete ${selected.name}? This removes the asset from the register.`)) return;
    try { await invoke('deleteAsset', { id: selected.id }); setSelected(null); setMode('list'); setMessage('Asset deleted.'); await load(); }
    catch (e) { setMessage(e.message || 'Could not delete asset.'); }
  }

  function exportCsv() {
    const customHeaders = settings.customFields.map((f) => f.label);
    const headers = ['Asset ID','Device Name','Type','Manufacturer','Model','Serial Number','Assigned To','Status','Location','Purchase Date','Warranty Expiry','Notes', ...customHeaders];
    const rows = assets.map((a) => [a.id,a.name,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location,a.purchaseDate,a.warrantyExpiry,a.notes, ...settings.customFields.map((f) => a.customFields?.[f.key] || '')]);
    const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `nuvriqo-assets-${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(url);
  }

  if (mode === 'form') return <main><AssetForm asset={selected || emptyAsset} settings={settings} onSave={saveAsset} onCancel={() => setMode(selected?.id ? 'detail' : 'list')} /></main>;
  if (mode === 'settings') return <main><Settings initial={settings} onClose={() => setMode('list')} onSave={async (cfg) => { const saved = await invoke('saveSettings', { settings: cfg }); setSettings(saved); setMode('list'); setMessage('Settings saved.'); }} /></main>;
  if (mode === 'detail' && selected) return <main><AssetDetail asset={selected} settings={settings} onBack={() => { setMode('list'); setSelected(null); }} onEdit={() => setMode('form')} onDelete={deleteSelected} /></main>;

  return <main>
    <div className="topbar"><div><span className="brand">NUVRIQO</span><h1>Asset Manager</h1><p>Simple device tracking for Jira and JSM.</p></div><div className="top-actions"><button className="secondary" onClick={() => setMode('settings')}>Settings</button><button className="primary" onClick={() => { setSelected(null); setMode('form'); }}>+ Add asset</button></div></div>
    {message && <div className="notice" onClick={() => setMessage('')}>{message}</div>}
    <div className="stats"><div><strong>{stats.total}</strong><span>Total assets</span></div><div><strong>{stats.inUse}</strong><span>In use</span></div><div><strong>{stats.available}</strong><span>Available</span></div><div><strong>{stats.repair}</strong><span>Repair</span></div></div>
    <div className="card"><div className="filters"><input className="search" placeholder="Search device, serial, user…" value={query} onChange={(e) => setQuery(e.target.value)} /><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{settings.statuses.map((x) => <option key={x}>{x}</option>)}</select><select value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{settings.assetTypes.map((x) => <option key={x}>{x}</option>)}</select><select value={location} onChange={(e) => setLocation(e.target.value)}><option value="">All locations</option>{settings.locations.map((x) => <option key={x}>{x}</option>)}</select>
      <button className="secondary" onClick={() => setShowImport(true)}>Import CSV / Excel</button><button className="secondary" onClick={exportCsv}>Export CSV</button></div>
      {assets.length ? <div className="table-wrap"><table><thead><tr><th>Device Name</th><th>Type</th><th>Serial</th><th>Assigned to</th><th>Status</th><th>Location</th></tr></thead><tbody>{assets.map((asset) => <tr key={asset.id} onClick={() => { setSelected(asset); setMode('detail'); }}><td><strong>{asset.name}</strong></td><td>{asset.type}</td><td>{asset.serialNumber || '—'}</td><td>{asset.assigneeName || 'Unassigned'}</td><td><span className="status-pill">{asset.status}</span></td><td>{asset.location || '—'}</td></tr>)}</tbody></table></div> : <div className="empty"><h2>No assets found</h2><p>Add your first device manually or import a CSV / Excel register.</p></div>}
    </div>
    {showImport && <ImportDialog existingAssets={assets} onImport={importAssets} onClose={() => setShowImport(false)} />}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
