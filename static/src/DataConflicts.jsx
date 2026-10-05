import React, { useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { invoke } from './invoke.js';
import { downloadCsv } from '../../shared/csv.js';
import DeviceIdCleanup from './DeviceIdCleanup';

const formatDate = (v) => (v ? new Date(v).toLocaleDateString() : '—');

// Devices whose latest Jira ticket names a different holder than Asset Manager. The Jira scan
// records these instead of reassigning the device; someone decides here which holder is right.
export default function DataConflicts({ onBack, onOpenAsset, onChanged }) {
  const [conflicts, setConflicts] = useState([]);
  const [kept, setKept] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    try {
      const result = await invoke('getDataConflicts');
      setConflicts(result?.conflicts || []);
      setKept(result?.kept || 0);
      setTruncated(Boolean(result?.truncated));
    } catch (e) {
      setMessage(e?.message || 'Could not load data conflicts.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function resolve(conflict, action) {
    setWorking(conflict.assetId);
    setMessage('');
    try {
      await invoke('resolveDataConflict', { assetId: conflict.assetId, action });
      setConflicts((list) => list.filter((c) => c.assetId !== conflict.assetId));
      if (action === 'keep') setKept((n) => n + 1);
      setMessage(action === 'accept'
        ? `${conflict.deviceName} is now assigned to ${conflict.ticketHolder}.`
        : `${conflict.deviceName} stays with ${conflict.currentHolder || 'its current holder'}. ${conflict.issueKey || 'This ticket'} won't raise it again.`);
      onChanged?.();
    } catch (e) {
      setMessage(e?.message || 'Could not resolve this conflict.');
      await load();
    } finally {
      setWorking('');
    }
  }

  function exportCsv() {
    downloadCsv(`nuvriqo-data-conflicts-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Device', 'Device ID', 'Holder in Asset Manager', 'Assignment reference', 'Holder on ticket', 'Ticket assignment reference', 'Ticket', 'Ticket summary', 'Ticket created', 'Detected'],
      conflicts.map((c) => [c.deviceName, c.deviceId, c.currentHolder, c.currentCrewCode, c.ticketHolder, c.ticketCrewCode, c.issueKey, c.issueSummary, c.issueCreated, c.detectedAt]));
  }

  return (
    <main className="reports-workspace">
      <div className="toolbar">
        <button className="secondary" onClick={onBack}>← Overview</button>
        <button className="secondary" onClick={load} disabled={loading}>Refresh</button>
        <button className="primary" onClick={exportCsv} disabled={!conflicts.length}>Export holder conflicts</button>
      </div>
      <div className="page-title">
        <span className="brand">NUVRIQO</span>
        <h1>Data conflicts</h1>
        <p>Where Jira tickets and Asset Manager disagree. <strong>Holder conflicts</strong>: the latest ticket names a different holder; it may be a handover, someone reporting for a colleague, or a mistyped Device ID, so choose which holder is right. <strong>Device ID clean-up</strong>: values in the Device ID field that aren't Device IDs.</p>
      </div>
      {message && <div className="notice" role="status">{message}</div>}
      <BulkHolderReview onOpenAsset={onOpenAsset} onDone={() => { load(); onChanged?.(); }} />
      {truncated && <div className="card report-warning">Showing the first 1,000 conflicts. Resolve some and refresh to see the rest.</div>}
      <div className="card fault-card">
        <div className="section-head">
          <div><h2>Holder conflicts</h2><p>{kept ? `${kept} earlier conflict${kept === 1 ? '' : 's'} kept as ${kept === 1 ? 'it is' : 'they are'}; a newer ticket or a different person will raise ${kept === 1 ? 'it' : 'them'} again.` : 'Found by the Jira scan.'}</p></div>
          <span>{loading ? 'Loading…' : `${conflicts.length} to review`}</span>
        </div>
        <div className="table-wrap">
          <table aria-label="Holder conflicts">
            <thead><tr><th>Device</th><th>Holder in Asset Manager</th><th>Holder on ticket</th><th>Ticket</th><th>Detected</th><th>Decision</th></tr></thead>
            <tbody>
              {!loading && !conflicts.length && <tr><td colSpan="6">No holder conflicts. Run the Jira scan from Configuration to check for new ones.</td></tr>}
              {conflicts.map((c) => (
                <tr key={c.assetId} style={{ cursor: 'default' }}>
                  <td><button className="issue-link" onClick={() => onOpenAsset?.(c.assetId)}><strong>{c.deviceName}</strong></button>{c.deviceId && c.deviceId !== c.deviceName && <small style={{ display: 'block' }}>{c.deviceId}</small>}</td>
                  <td>{c.currentHolder || 'Unassigned'}{c.currentCrewCode && c.currentCrewCode !== c.currentHolder && <small style={{ display: 'block' }}>{c.currentCrewCode}</small>}</td>
                  <td>{c.ticketHolder}{c.ticketCrewCode && c.ticketCrewCode !== c.ticketHolder && <small style={{ display: 'block' }}>{c.ticketCrewCode}</small>}</td>
                  <td>{c.issueKey ? <button className="issue-link" onClick={() => router.open(`/browse/${c.issueKey}`)}>{c.issueKey}</button> : '—'}{c.issueSummary && <small style={{ display: 'block' }}>{c.issueSummary}</small>}{c.issueCreated && <small style={{ display: 'block' }}>Raised {formatDate(c.issueCreated)}</small>}</td>
                  <td>{formatDate(c.detectedAt)}</td>
                  <td>
                    <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                      <button className="primary" disabled={Boolean(working)} onClick={() => resolve(c, 'accept')}>{working === c.assetId ? 'Saving…' : `Use ${c.ticketHolder}`}</button>
                      <button className="secondary" disabled={Boolean(working)} onClick={() => resolve(c, 'keep')}>Keep {c.currentHolder || 'current'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <DeviceIdCleanup />
    </main>
  );
}

// Bulk holder review: moves devices whose recent tickets all came from one other person, so only
// the unclear conflicts are left to decide one by one. Preview first; nothing changes until Apply.
function BulkHolderReview({ onOpenAsset, onDone }) {
  const [minTickets, setMinTickets] = useState(2);
  const [since, setSince] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  async function run(apply) {
    setBusy(apply ? 'apply' : 'preview'); setMessage('');
    let cursor = null, guard = 0, checked = 0, applied = 0;
    const candidates = [];
    try {
      do {
        const page = await invoke('bulkHolderConflicts', { minTickets, since, cursor, apply });
        checked += page.checked || 0; applied += page.applied || 0; candidates.push(...(page.candidates || []));
        cursor = page.nextCursor; guard += 1;
        setMessage(`${apply ? 'Moving devices' : 'Checking conflicts'}… ${checked} checked, ${apply ? applied : candidates.length} ${apply ? 'moved' : 'would move'}`);
      } while (cursor && guard < 500);
      if (apply) { setPreview(null); setMessage(`${applied} device${applied === 1 ? '' : 's'} moved to the person on their recent tickets. Each has a history entry and an assigned-since date.`); onDone?.(); }
      else { setPreview({ checked, candidates }); setMessage(''); }
    } catch (e) {
      setMessage(`${apply ? 'Stopped' : 'Preview stopped'}: ${e?.message || 'request failed'}.${apply ? ` ${applied} moved so far; preview again to see what is left.` : ''}`);
    } finally { setBusy(''); }
  }

  function exportCsv() {
    downloadCsv(`nuvriqo-bulk-holder-review-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Device', 'Device ID', 'Holder now', 'Assignment reference now', 'Would move to', 'Assignment reference', 'Tickets in a row', 'First of those', 'Latest', 'Tickets'],
      preview.candidates.map((c) => [c.deviceName, c.deviceId, c.currentHolder, c.currentCrewCode, c.proposedHolder, c.proposedCrewCode, c.tickets, c.since, c.until, c.issueKeys.join(' ')]));
  }

  const working = Boolean(busy);
  return (
    <div className="card fault-card">
      <div className="section-head"><div>
        <h2>Bulk holder review</h2>
        <p>Moves a device to the person on its tickets when its newest tickets in a row were all raised by that person, not its holder. Uses the tickets recorded by the last Jira scan; run the scan first. Conflicts someone chose to keep are left alone.</p>
      </div></div>
      <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <label>Newest tickets in a row, at least<input type="number" min="1" max="20" value={minTickets} disabled={working} onChange={(e) => { setMinTickets(Number(e.target.value) || 1); setPreview(null); }} style={{ width: 80 }} /></label>
        <label>Latest ticket on or after (optional)<input type="date" value={since} disabled={working} onChange={(e) => { setSince(e.target.value); setPreview(null); }} /></label>
        <button className="secondary" disabled={working} onClick={() => run(false)}>{busy === 'preview' ? 'Checking…' : 'Preview'}</button>
        {preview && preview.candidates.length > 0 && <button className="primary" disabled={working} onClick={() => { if (window.confirm(`Move ${preview.candidates.length} device${preview.candidates.length === 1 ? '' : 's'} to the person on their recent tickets?`)) run(true); }}>{busy === 'apply' ? 'Moving…' : `Apply to ${preview.candidates.length}`}</button>}
        {preview && preview.candidates.length > 0 && <button className="secondary" disabled={working} onClick={exportCsv}>Export preview</button>}
      </div>
      {message && <div className="notice" role="status" style={{ marginTop: 10 }}>{message}</div>}
      {preview && <p style={{ marginTop: 10 }}>{preview.checked} open conflicts checked; <strong>{preview.candidates.length}</strong> would move. The rest stay in the list below to decide one by one.</p>}
      {preview && preview.candidates.length > 0 && <div className="table-wrap"><table aria-label="Bulk holder review preview">
        <thead><tr><th>Device</th><th>Holder now</th><th>Would move to</th><th>Evidence</th></tr></thead>
        <tbody>{preview.candidates.slice(0, 100).map((c) => <tr key={c.assetId} style={{ cursor: 'default' }}>
          <td><button className="issue-link" onClick={() => onOpenAsset?.(c.assetId)}><strong>{c.deviceName}</strong></button>{c.deviceId !== c.deviceName && <small style={{ display: 'block' }}>{c.deviceId}</small>}</td>
          <td>{c.currentHolder || 'Unassigned'}</td>
          <td>{c.proposedHolder}{c.proposedCrewCode !== c.proposedHolder && <small style={{ display: 'block' }}>{c.proposedCrewCode}</small>}</td>
          <td>{c.tickets} tickets in a row, {formatDate(c.since)} – {formatDate(c.until)}<small style={{ display: 'block' }}>{c.issueKeys.join(', ')}</small></td>
        </tr>)}</tbody>
      </table>{preview.candidates.length > 100 && <small>Showing 100 of {preview.candidates.length}; export the preview for the full list.</small>}</div>}
    </div>
  );
}
