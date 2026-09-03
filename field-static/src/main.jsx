import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import './styles.css';

function DeviceField() {
  const [current, setCurrent] = useState(null);
  const [query, setQuery] = useState('');
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    view.getContext()
      .then((context) => {
        const value = context?.extension?.fieldValue || null;
        setCurrent(value);
        setQuery(value?.name || '');
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
    try {
      await view.submit({ id: device.id, name: device.name });
      setCurrent(device);
      setQuery(device.name);
    } catch (e) {
      setError(e?.message || 'Could not save Device.');
    } finally {
      setSaving(false);
    }
  }

  async function clearValue() {
    setSaving(true);
    setError('');
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
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search device name…"
          aria-label="Device"
          disabled={saving}
        />
        {query && !saving && (
          <button className="clear" type="button" onClick={clearValue} aria-label="Clear Device">×</button>
        )}
      </div>

      <div className="results" role="listbox" aria-label="Devices">
        {devices.map((device) => (
          <button
            type="button"
            role="option"
            aria-selected={current?.id === device.id}
            key={device.id}
            className={current?.id === device.id ? 'selected' : ''}
            onClick={() => choose(device)}
            disabled={saving}
          >
            {device.name}
          </button>
        ))}
        {!devices.length && !error && <div className="empty">No matching devices.</div>}
      </div>

      {exactMatch && current?.id !== exactMatch.id && (
        <div className="hint">Select the matching device above to save it.</div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<DeviceField />);
