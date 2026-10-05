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
