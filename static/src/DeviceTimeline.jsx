import React, { useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { invoke } from './invoke.js';

const day = (v) => (v ? new Date(v).toLocaleDateString() : '—');

// Who has had this device: every ticket with the crew code it was raised under, and every holder
// change, newest first. Tickets raised by someone other than the current holder are marked, so a
// swap or mix-up shows as a run of tickets under another code.
export default function DeviceTimeline({ assetId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    setData(null); setError('');
    invoke('getDeviceTimeline', { assetId }).then(setData).catch((e) => setError(e?.message || 'Could not load the timeline.'));
  }, [assetId]);

  if (error) return <div className="card fault-card"><h2>Holder timeline</h2><div className="empty-small">{error}</div></div>;
  if (!data) return <div className="card fault-card"><h2>Holder timeline</h2><div className="empty-small">Loading timeline…</div></div>;
  const events = all ? data.events : data.events.slice(0, 25);
  const run = data.latestRun;
  return (
    <div className="card fault-card">
      <div className="section-head">
        <div>
          <h2>Holder timeline</h2>
          <p>Tickets raised with this device, with the assignment reference each was raised under, and changes of holder. <strong>Other holder</strong> marks a ticket raised by someone other than the current holder.</p>
        </div>
        <span>{data.events.length} events</span>
      </div>
      <dl className="timeline-summary">
        <dt>Current holder</dt><dd>{data.holder || 'Unassigned'}{data.crewCode && data.crewCode !== data.holder ? ` (${data.crewCode})` : ''}</dd>
        <dt>Assigned since</dt><dd>{day(data.assignedAt)}</dd>
        <dt>Latest tickets</dt><dd>{run ? `${run.count} in a row by ${run.crewCode} (${day(run.since)} – ${day(run.until)})${data.latestMatchesHolder === false ? ' — not the current holder' : ''}` : 'No tickets with an assignment reference'}</dd>
        {data.otherReportsSinceAssigned > 0 && <><dt>Since assigned</dt><dd>{data.otherReportsSinceAssigned} ticket{data.otherReportsSinceAssigned === 1 ? '' : 's'} raised by someone else</dd></>}
      </dl>
      {data.reporters.length > 0 && <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table aria-label="Who has reported with this device"><thead><tr><th>Assignment reference</th><th>Tickets</th><th>First</th><th>Last</th></tr></thead><tbody>
          {data.reporters.map((r) => <tr key={r.crewCode} style={{ cursor: 'default' }}><td><strong>{r.crewCode}</strong>{data.crewCode && r.crewCode.toLowerCase() === data.crewCode.toLowerCase() ? ' (current holder)' : ''}</td><td>{r.count}</td><td>{day(r.first)}</td><td>{day(r.last)}</td></tr>)}
        </tbody></table>
      </div>}
      {data.truncated && <div className="notice">This device has more tickets than one search returns; the oldest may be missing.</div>}
      {!data.live && <div className="notice">Jira couldn't be searched just now{data.searchError ? ` (${data.searchError})` : ''}; showing the tickets recorded by the last Jira scan, which only include the assignment reference and base once the scan has run since this update.</div>}
      {events.length ? <div className="table-wrap"><table className="fault-table" aria-label="Holder timeline"><thead><tr><th>Date</th><th>Event</th><th>Assignment reference</th><th>Base</th><th>Details</th></tr></thead><tbody>
        {events.map((e, i) => e.kind === 'ticket'
          ? <tr key={`t-${e.key}-${i}`} style={{ cursor: 'default' }}><td>{day(e.at)}</td><td><button className="issue-link" onClick={() => router.open(`/browse/${e.key}`)}>{e.key}</button>{e.relation === 'related' ? <small style={{ display: 'block' }}>Related device</small> : null}</td><td>{e.crewCode || '—'}{e.otherHolder ? <span className="status-pill" style={{ marginLeft: 6 }}>Other holder</span> : null}</td><td>{e.base || '—'}</td><td>{e.summary || 'Ticket'}{e.status ? <small style={{ display: 'block' }}>{[e.issueType, e.status].filter(Boolean).join(' · ')}</small> : null}</td></tr>
          : <tr key={`h-${e.at}-${i}`} style={{ cursor: 'default' }}><td>{day(e.at)}</td><td><strong>Holder</strong></td><td>{e.changes.map((c) => c.to).filter(Boolean).join(' · ') || '—'}</td><td>—</td><td>{e.message}{e.by ? <small style={{ display: 'block' }}>by {e.by}</small> : null}</td></tr>)}
      </tbody></table>{data.events.length > events.length && <button className="secondary" style={{ marginTop: 8 }} onClick={() => setAll(true)}>Show all {data.events.length}</button>}</div>
        : <div className="empty-small">No tickets or holder changes yet.</div>}
    </div>
  );
}
