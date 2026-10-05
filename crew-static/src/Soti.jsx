import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

const when = (v) => (v ? new Date(v).toLocaleString() : '—');
const day = (v) => (v ? new Date(v).toLocaleDateString() : '—');

// SOTI Sync (internal edition): connection, sync, and what needs review. Read-only towards SOTI.
export default function Soti() {
  const [form, setForm] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [test, setTest] = useState(null);
  const [types, setTypes] = useState({});

  async function loadAll() {
    try {
      const [settings, rep] = await Promise.all([invoke('getSotiSettings'), invoke('getSotiReport')]);
      setForm({ ...settings, clientSecret: '', password: '', trackedAppsText: (settings.trackedApps || []).join('\n') });
      setReport(rep);
    } catch (e) { setMessage(e.message || 'Could not load SOTI settings.'); }
  }
  useEffect(() => { loadAll(); }, []);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function save() {
    setBusy('save'); setMessage('');
    try {
      const saved = await invoke('saveSotiSettings', { host: form.host, clientId: form.clientId, clientSecret: form.clientSecret, username: form.username, password: form.password, trackedApps: form.trackedAppsText.split('\n'), staleDays: form.staleDays, autoSync: form.autoSync });
      setForm({ ...saved, clientSecret: '', password: '', trackedAppsText: (saved.trackedApps || []).join('\n') });
      setMessage('SOTI settings saved.');
    } catch (e) { setMessage(e.message || 'Could not save SOTI settings.'); } finally { setBusy(''); }
  }

  async function testConnection() {
    setBusy('test'); setMessage(''); setTest(null);
    try { setTest(await invoke('testSotiConnection')); } catch (e) { setMessage(e.message || 'Could not reach SOTI.'); } finally { setBusy(''); }
  }

  async function sync(restart) {
    setBusy('sync'); setMessage(restart ? 'Starting SOTI sync…' : 'Continuing SOTI sync…');
    try {
      let step = await invoke('sotiSyncStep', { restart });
      for (let guard = 0; !step.complete && guard < 500; guard += 1) {
        setMessage(`SOTI sync… ${step.seen} devices read, ${step.matched} matched`);
        step = await invoke('sotiSyncStep', {});
      }
      setMessage(step.complete ? `SOTI sync complete: ${step.seen} devices read, ${step.matched} matched, ${step.filled} filled in, ${step.differences} with differences, ${step.unmatched} not in the register.` : 'SOTI sync paused; press Continue sync.');
      setReport(await invoke('getSotiReport'));
    } catch (e) { setMessage(`SOTI sync stopped: ${e.message || 'request failed'}. Continue sync picks up where it stopped.`); } finally { setBusy(''); }
  }

  async function act(name, payload, done) {
    setBusy(name + JSON.stringify(payload)); setMessage('');
    try { await invoke(name, payload); setMessage(done); setReport(await invoke('getSotiReport')); }
    catch (e) { setMessage(e.message || 'That did not work.'); } finally { setBusy(''); }
  }

  if (!form) return <main className="page"><div className="card">{message || 'Loading SOTI settings…'}</div></main>;
  const working = Boolean(busy);
  const r = report || {};
  return (
    <main className="page">
      <header><div><h1>SOTI Sync</h1><p>Reads devices from SOTI MobiControl (SOTI ONE) and keeps the register up to date. Read-only: nothing is sent to devices.</p></div></header>
      {message && <div className="notice" role="status">{message}</div>}
      {r.error && <div className="warning">The last automatic sync failed at {when(r.error.at)}: {r.error.message}</div>}

      <section className="card">
        <h2>Connection</h2>
        <p>Create an API client in SOTI ONE (SOTI ONE Apps → MobiControl → API Client) and, if it signs in with a user, a read-only API user. Secrets are kept in encrypted app storage and never shown again; leave them blank to keep the saved ones.</p>
        <div className="soti-form">
          <label>Server address<input value={form.host} onChange={set('host')} placeholder="https://a123456.mobicontrol.cloud" /></label>
          <label>Client ID<input value={form.clientId} onChange={set('clientId')} /></label>
          <label>Client secret<input type="password" value={form.clientSecret} onChange={set('clientSecret')} placeholder={form.hasSecret ? 'Saved — leave blank to keep' : ''} /></label>
          <label>API username<input value={form.username} onChange={set('username')} autoComplete="off" /></label>
          <label>API password<input type="password" value={form.password} onChange={set('password')} placeholder={form.hasPassword ? 'Saved — leave blank to keep' : ''} autoComplete="new-password" /></label>
          <label>Apps to track: one per line, as Label = package name<textarea rows={3} value={form.trackedAppsText} onChange={set('trackedAppsText')} placeholder="POS app = com.example.pos" /></label>
          <label>“Not seen” after (days)<input type="number" min="1" max="365" value={form.staleDays} onChange={set('staleDays')} /></label>
          <label className="soti-check"><input type="checkbox" checked={form.autoSync} onChange={set('autoSync')} /> Sync automatically once a day</label>
        </div>
        <div className="toolbar" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          <button className="primary" onClick={save} disabled={working}>{busy === 'save' ? 'Saving…' : 'Save SOTI settings'}</button>
          <button onClick={testConnection} disabled={working || !form.host}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        </div>
        {test && <div className="notice">
          <strong>Connected to SOTI.</strong>{test.sampleDevice ? <> First device: {test.sampleDevice.name || test.sampleDevice.sotiId} · {test.sampleDevice.model || 'no model'} · {test.sampleDevice.os || 'no OS'}.</> : ' No devices returned.'}
          {test.fieldsFound && <p style={{ marginTop: 6 }}>Fields found: {Object.entries(test.fieldsFound).map(([k, v]) => `${k} → ${v || 'not found'}`).join(' · ')}</p>}
          {test.availableFields?.length > 0 && <p style={{ marginTop: 6 }}><small>All SOTI fields on that device: {test.availableFields.join(', ')}</small></p>}
        </div>}
      </section>

      <section className="kpis">
        <div><span>Last sync</span><strong style={{ fontSize: 18 }}>{when(r.last?.finishedAt)}</strong></div>
        <div><span>Devices in SOTI</span><strong>{r.last?.seen ?? '—'}</strong></div>
        <div><span>Matched to the register</span><strong>{r.last?.matched ?? '—'}</strong></div>
        <div><span>Filled in from SOTI</span><strong>{r.last?.filled ?? '—'}</strong></div>
      </section>
      <div className="toolbar" style={{ justifyContent: 'flex-start' }}>
        <button className="primary" onClick={() => sync(true)} disabled={working || !form.host}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
        {r.progress && <button onClick={() => sync(false)} disabled={working}>Continue sync ({r.progress.seen} read)</button>}
        <button onClick={loadAll} disabled={working}>Refresh</button>
      </div>

      <section className="card">
        <h2>Different in SOTI ({(r.differences || []).length})</h2>
        <p>Matched devices where a register field differs from SOTI. Empty fields are filled automatically; filled ones are never overwritten without a decision.</p>
        <div className="tablewrap"><table aria-label="Different in SOTI"><thead><tr><th>Device</th><th>Field</th><th>Register</th><th>SOTI</th><th>Decision</th></tr></thead><tbody>
          {!(r.differences || []).length && <tr><td colSpan="5" className="empty">No differences.</td></tr>}
          {(r.differences || []).map((d) => <tr key={d.assetId} style={{ cursor: 'default' }}>
            <td><strong>{d.deviceName}</strong>{d.sotiName && d.sotiName !== d.deviceName && <small style={{ display: 'block' }}>SOTI: {d.sotiName}</small>}</td>
            <td>{d.differences.map((x) => <div key={x.field}>{x.label}</div>)}</td>
            <td>{d.differences.map((x) => <div key={x.field}>{x.register}</div>)}</td>
            <td>{d.differences.map((x) => <div key={x.field}>{x.soti}</div>)}</td>
            <td><button className="primary" disabled={working} onClick={() => act('resolveSotiDifference', { assetId: d.assetId, action: 'soti' }, `${d.deviceName} updated from SOTI.`)}>Use SOTI</button> <button disabled={working} onClick={() => act('resolveSotiDifference', { assetId: d.assetId, action: 'keep' }, `${d.deviceName} keeps its register values.`)}>Keep register</button></td>
          </tr>)}
        </tbody></table></div>
      </section>

      <section className="card">
        <h2>In SOTI, not in the register ({(r.sotiOnly || []).length})</h2>
        <p>No register device matched by Device ID, name, serial or IMEI.</p>
        <div className="tablewrap"><table aria-label="In SOTI, not in the register"><thead><tr><th>SOTI name</th><th>Serial / IMEI</th><th>Model</th><th>Group</th><th>Last check-in</th><th>Add as type</th><th></th></tr></thead><tbody>
          {!(r.sotiOnly || []).length && <tr><td colSpan="7" className="empty">Every SOTI device is in the register.</td></tr>}
          {(r.sotiOnly || []).map((d) => { const key = d.sotiId || d.name; return <tr key={key} style={{ cursor: 'default' }}>
            <td><strong>{d.name || d.sotiId}</strong></td><td>{d.serial || '—'}{d.imei ? <small style={{ display: 'block' }}>{d.imei}</small> : null}</td><td>{[d.manufacturer, d.model].filter(Boolean).join(' ') || '—'}</td><td>{d.path || '—'}</td><td>{day(d.lastCheckIn)}</td>
            <td><input aria-label={`Type for ${d.name}`} value={types[key] || ''} onChange={(e) => setTypes({ ...types, [key]: e.target.value })} placeholder="Other" style={{ width: 110 }} /></td>
            <td><button className="primary" disabled={working} onClick={() => act('addSotiDevice', { sotiId: key, type: types[key] || '' }, `${d.name || key} added to the register.`)}>Add to register</button></td>
          </tr>; })}
        </tbody></table></div>
      </section>

      <section className="card">
        <h2>In the register, not in SOTI ({(r.registerOnly || []).length})</h2>
        <p>Not found in the last complete sync: possibly retired, lost, not managed by SOTI, or recorded under a different ID.</p>
        <DeviceTable rows={r.registerOnly} empty={r.last ? 'Every register device was found in SOTI.' : 'Run a sync first.'} />
      </section>

      <section className="card">
        <h2>Not seen for {r.staleDays || 30}+ days ({(r.stale || []).length})</h2>
        <p>In SOTI, but no check-in recently: possibly switched off, broken or in a drawer.</p>
        <DeviceTable rows={r.stale} empty="Every SOTI device has checked in recently." />
      </section>
      {r.registerPartial && <div className="warning">The register is larger than 20,000 devices; lists only cover the first 20,000.</div>}
    </main>
  );
}

function DeviceTable({ rows = [], empty }) {
  return <div className="tablewrap"><table><thead><tr><th>Device</th><th>Type</th><th>Status</th><th>Holder</th><th>SOTI group</th><th>Last check-in</th></tr></thead><tbody>
    {!rows.length && <tr><td colSpan="6" className="empty">{empty}</td></tr>}
    {rows.slice(0, 500).map((d) => <tr key={d.assetId} style={{ cursor: 'default' }}><td><strong>{d.name}</strong>{d.deviceId !== d.name && <small style={{ display: 'block' }}>{d.deviceId}</small>}</td><td>{d.type || '—'}</td><td>{d.status || '—'}</td><td>{d.holder || '—'}</td><td>{d.path || '—'}</td><td>{day(d.lastCheckIn)}</td></tr>)}
  </tbody></table>{rows.length > 500 && <p>Showing 500 of {rows.length}.</p>}</div>;
}
