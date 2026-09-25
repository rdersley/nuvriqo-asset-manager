import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@forge/bridge';
import './styles.css';

function App() {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    invoke('getPortalAssets')
      .then((result) => setData(result || { assets: [], organisations: [] }))
      .catch((e) => setError(e?.message || 'Could not load your organisation devices.'));
  }, []);

  const assets = data?.assets || [];
  const types = useMemo(() => [...new Set(assets.map((a) => a.type).filter(Boolean))].sort(), [assets]);
  const statuses = useMemo(() => [...new Set(assets.map((a) => a.status).filter(Boolean))].sort(), [assets]);
  const locations = useMemo(() => [...new Set(assets.map((a) => a.location).filter(Boolean))].sort(), [assets]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((asset) => {
      if (q && ![asset.deviceId, asset.name, asset.type, asset.manufacturer, asset.model, asset.serialNumber, asset.holder, asset.location, ...(asset.organisationNames || [])].some((value) => String(value || '').toLowerCase().includes(q))) return false;
      if (status && asset.status !== status) return false;
      if (type && asset.type !== type) return false;
      if (location && asset.location !== location) return false;
      return true;
    });
  }, [assets, query, status, type, location]);

  if (error) return <div className="state error">{error}</div>;
  if (!data) return <div className="state">Loading your organisation devices…</div>;

  return <main>
    <div className="hero">
      <div><span className="brand">NUVRIQO ASSET MANAGER</span><h1>My organisation's devices</h1><p>Devices linked to the Jira Service Management organisations your account belongs to.</p></div>
      <div className="count"><strong>{filtered.length}</strong><span>devices</span></div>
    </div>

    {!!data.organisations?.length && <div className="orgs"><strong>Organisations:</strong> {data.organisations.map((org) => org.name).join(', ')}</div>}

    {data.reason && !assets.length ? <div className="state info">{data.reason}</div> : <>{data.partial && <div className="state info">Showing devices from your organisation's most recent tickets. Some older devices may not be listed.</div>}
      <div className="filters">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search Device ID, model, serial number, holder…" />
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={type} onChange={(e) => setType(e.target.value)}><option value="">All device types</option>{types.map((value) => <option key={value}>{value}</option>)}</select>
        <select value={location} onChange={(e) => setLocation(e.target.value)}><option value="">All locations</option>{locations.map((value) => <option key={value}>{value}</option>)}</select>
      </div>

      {filtered.length ? <div className="cards">{filtered.map((asset) => <article key={asset.id}>
        <div className="card-head"><div><span className="device-id">{asset.deviceId}</span><h2>{[asset.manufacturer, asset.model].filter(Boolean).join(' ') || asset.name}</h2></div>{asset.status && <span className="pill">{asset.status}</span>}</div>
        <dl>
          <dt>Device type</dt><dd>{asset.type || '—'}</dd>
          <dt>Serial number</dt><dd>{asset.serialNumber || '—'}</dd>
          <dt>Location</dt><dd>{asset.location || '—'}</dd>
          <dt>Assigned person / holder</dt><dd>{asset.holder || 'Unassigned'}</dd>
          <dt>Organisation</dt><dd>{(asset.organisationNames || []).join(', ') || '—'}</dd>
        </dl>
      </article>)}</div> : <div className="state info">No devices match the current filters.</div>}
    </>}
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
