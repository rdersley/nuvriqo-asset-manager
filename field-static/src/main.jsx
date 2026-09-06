import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import './styles.css';

function DeviceField() {
  const [current, setCurrent] = useState(null);
  const [query, setQuery] = useState('');
  const [devices, setDevices] = useState([]);
  const [issueKey, setIssueKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applyLocation, setApplyLocation] = useState(false);
  const [applyOwner, setApplyOwner] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    view.getContext()
      .then((context) => {
        const value = context?.extension?.fieldValue || null;
        setCurrent(value);
        setQuery(value?.name || '');
        setIssueKey(context?.extension?.issue?.key || '');
      })
      .catch(() => setError('Could not load the current Device value.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loading) return undefined;
    const timer = setTimeout(async () => {
      try {
        setError('');
        const results = await invoke('searchDevices', { query });
        setDevices(Array.isArray(results) ? results : []);
      } catch (e) {
        setDevices([]);
        setError(e?.message || 'Could not load devices.');
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, loading]);

  const exactMatch = useMemo(
    () => devices.find((device) => device.name.toLowerCase() === query.trim().toLowerCase()),
    [devices, query]
  );

  async function choose(device) {
    setSaving(true);
    setError('');
    setMessage('Saving device…');
    try {
      await view.submit({ id: device.id, name: device.name });
      setCurrent(device);
      setQuery(device.name);
      if (issueKey) {
        setMessage('Updating ticket from Asset Manager…');
        const result = await invoke('applyAssetToIssue', {
          assetId: device.id,
          issueKey,
          choices: { deviceType: true, location: applyLocation, owner: applyOwner }
        });
        setMessage(result?.updated?.length ? `Updated: ${result.updated.join(', ')}` : 'Device saved. No mapped ticket fields needed updating.');
      } else {
        setMessage('Device selected. Ticket metadata can be applied after the issue is created.');
      }
    } catch (e) {
      setError(e?.message || 'Could not save Device or update ticket fields.');
      setMessage('');
    } finally {
      setSaving(false);
    }
  }

  async function clearValue() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await view.submit(null);
      setCurrent(null);
      setQuery('');
    } catch (e) {
      setError(e?.message || 'Could not clear Device.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="field-shell"><span className="muted">Loading devices…</span></div>;

  return (
    <div className="field-shell">
      <div className="picker-wrap">
        <input autoFocus value={query} onChange={(e) => { setQuery(e.target.value); setMessage(''); }} placeholder="Search device name…" aria-label="Device" disabled={saving} />
        {query && !saving && <button className="clear" type="button" onClick={clearValue} aria-label="Clear Device">×</button>}
      </div>

      <div className="sync-options">
        <strong>Ticket autofill</strong>
        <span>Device type is filled automatically from Asset Manager.</span>
        <label><input type="checkbox" checked={applyLocation} onChange={(e) => setApplyLocation(e.target.checked)} disabled={saving} /> Also apply base / location</label>
        <label><input type="checkbox" checked={applyOwner} onChange={(e) => setApplyOwner(e.target.checked)} disabled={saving} /> Also apply owner / assignment reference</label>
        <small>Base and owner are never changed automatically because a reassignment or location change may be intentional.</small>
      </div>

      <div className="results" role="listbox" aria-label="Devices">
        {devices.map((device) => (
          <button type="button" role="option" aria-selected={current?.id === device.id} key={device.id} className={current?.id === device.id ? 'selected' : ''} onClick={() => choose(device)} disabled={saving}>
            <strong>{device.name}</strong>
            <small>{[device.type, device.location, device.holder].filter(Boolean).join(' · ')}</small>
          </button>
        ))}
        {!devices.length && !error && <div className="empty">No matching devices.</div>}
      </div>

      {exactMatch && current?.id !== exactMatch.id && <div className="hint">Select the matching device above to save it.</div>}
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<DeviceField />);
