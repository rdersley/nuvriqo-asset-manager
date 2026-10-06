import React, { useMemo, useState } from 'react';
import { downloadCsv } from '../../shared/csv.js';
import { repeatFaultRows } from './reportData';

const day = (v) => (v ? new Date(v).toLocaleDateString() : '—');
const SHOWN = 200;

// Devices with the same Device Fault on several tickets: a sign of a device that keeps failing
// the same way (worth replacing) or a repair that didn't fix it.
export default function RepeatFaults({ assets, query = '', openIssue }) {
  const [min, setMin] = useState(2);
  const [openOnly, setOpenOnly] = useState(false);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return repeatFaultRows(assets, min).filter((r) => (!openOnly || r.open > 0) && (!q || [r.name, r.deviceId, r.type, r.holder, r.location, r.fault].some((v) => String(v).toLowerCase().includes(q))));
  }, [assets, min, openOnly, query]);
  const devices = new Set(rows.map((r) => r.assetId)).size;
  const exportCsv = () => downloadCsv(`nuvriqo-repeat-faults-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Device', 'Device ID', 'Type', 'Holder', 'Location', 'Fault', 'Times', 'Open', 'First', 'Last', 'Latest tickets'],
    rows.map((r) => [r.name, r.deviceId, r.type, r.holder, r.location, r.fault, r.count, r.open, r.first, r.last, r.keys.join(' ')]));
  return (
    <div className="card fault-card">
      <div className="section-head">
        <div>
          <h2>Repeat faults</h2>
          <p>Devices with the same Device Fault on more than one ticket, most repeats first. A device that keeps failing the same way may need replacing, or a repair didn't fix it.</p>
        </div>
        <span>{devices.toLocaleString()} device{devices === 1 ? '' : 's'}</span>
      </div>
      <div className="filters" style={{ alignItems: 'center' }}>
        <label>Same fault at least <select value={min} onChange={(e) => setMin(Number(e.target.value))}>{[2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} times</option>)}</select></label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> Only with an open ticket</label>
        <button className="secondary" onClick={exportCsv} disabled={!rows.length}>Export repeat faults</button>
      </div>
      <div className="table-wrap"><table aria-label="Repeat faults">
        <thead><tr><th>Device</th><th>Fault</th><th>Times</th><th>Open</th><th>First</th><th>Last</th><th>Latest tickets</th><th>Holder</th></tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan="8">No device has the same fault {min} or more times{openOnly ? ' with an open ticket' : ''}.</td></tr>}
          {rows.slice(0, SHOWN).map((r) => <tr key={`${r.assetId}-${r.fault}`} style={{ cursor: 'default' }}>
            <td><strong>{r.name}</strong>{r.type && <small>{r.type}</small>}</td>
            <td style={{ whiteSpace: 'normal' }}>{r.fault}</td>
            <td><strong>{r.count}</strong></td>
            <td>{r.open || '—'}</td>
            <td>{day(r.first)}</td>
            <td>{day(r.last)}</td>
            <td>{r.keys.map((k, i) => <React.Fragment key={k}>{i ? ', ' : ''}{openIssue ? <button className="issue-link" onClick={() => openIssue(k)}>{k}</button> : k}</React.Fragment>)}</td>
            <td>{r.holder || '—'}</td>
          </tr>)}
        </tbody>
      </table>{rows.length > SHOWN && <p className="muted" style={{ padding: '8px 12px' }}>Showing the first {SHOWN} of {rows.length.toLocaleString()}. Export for all of them.</p>}</div>
    </div>
  );
}
