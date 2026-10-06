import React, { useEffect, useState } from 'react';
import { router } from '@forge/bridge';
import { invoke } from './invoke.js';
import { downloadCsv } from '../../shared/csv.js';

// Values in the Jira Device ID field that are not Device IDs (serial numbers, notes, placeholders),
// found by the Jira scan or its preview. Each can be fixed (the right Device ID written into its
// tickets), cleared from its tickets, or ignored.
export default function DeviceIdCleanup() {
  const [values, setValues] = useState([]);
  const [counts, setCounts] = useState({ ignored: 0, fixed: 0 });
  const [notes, setNotes] = useState({ partial: false, truncated: false });
  const [chosen, setChosen] = useState({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    try {
      const r = await invoke('getDeviceIdReview');
      setValues(r?.values || []);
      setCounts({ ignored: r?.ignored || 0, fixed: r?.fixed || 0 });
      setNotes({ partial: Boolean(r?.suggestionsPartial), truncated: Boolean(r?.truncated) });
      if (r?.nowValid) setMessage(`${r.nowValid} value${r.nowValid === 1 ? '' : 's'} now match${r.nowValid === 1 ? 'es' : ''} the Device ID format and ${r.nowValid === 1 ? 'was' : 'were'} removed from the list. Run the Jira scan to add them as devices.`);
      setChosen(Object.fromEntries((r?.values || []).map((v) => [v.value, v.suggestion?.deviceId || ''])));
    } catch (e) {
      setMessage(e?.message || 'Could not load the Device ID clean-up list.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function act(row, action) {
    const deviceId = (chosen[row.value] || '').trim();
    if (action === 'fix' && !deviceId) { setMessage(`Enter the Device ID that should replace “${row.value}”.`); return; }
    const confirmText = action === 'fix'
      ? `Write ${deviceId} into the Device ID field of the ${row.ticketCount} ticket${row.ticketCount === 1 ? '' : 's'} that say “${row.value}”?`
      : action === 'clear' ? `Empty the Device ID field on the ${row.ticketCount} ticket${row.ticketCount === 1 ? '' : 's'} that say “${row.value}”?` : null;
    if (confirmText && !window.confirm(confirmText)) return;
    setWorking(row.value);
    setMessage('');
    try {
      if (action === 'ignore') {
        await invoke('resolveDeviceIdValue', { value: row.value, action });
        setValues((list) => list.filter((v) => v.value !== row.value));
        setCounts((c) => ({ ...c, ignored: c.ignored + 1 }));
        setMessage(`“${row.value}” is ignored and won't be listed again.`);
        return;
      }
      // Up to 50 tickets per call; keep going while tickets remain and progress is made.
      let updated = [], failed = [], result;
      for (let guard = 0; guard < 100; guard += 1) {
        result = await invoke('resolveDeviceIdValue', { value: row.value, action, deviceId });
        updated = updated.concat(result.updated || []);
        failed = result.failed || [];
        if (!result.remaining || !(result.updated || []).length) break;
      }
      if (result.notFound) {
        setMessage(`Jira's search couldn't find tickets with “${row.value}” (it skips some short words). Fix these in Jira: ${(result.issueKeys || []).join(', ')}.`);
      } else if (result.done) {
        setValues((list) => list.filter((v) => v.value !== row.value));
        setCounts((c) => ({ ...c, fixed: c.fixed + 1 }));
        setMessage(`${action === 'fix' ? `${deviceId} written to` : 'Device ID cleared on'} ${updated.length} ticket${updated.length === 1 ? '' : 's'}: ${updated.join(', ')}.`);
      } else {
        setMessage(`${updated.length} ticket${updated.length === 1 ? '' : 's'} updated.${failed.length ? ` ${failed.length} could not be changed: ${failed.map((f) => `${f.key} (${f.error})`).join('; ')}.` : ''} The value stays on the list.`);
        await load();
      }
    } catch (e) {
      setMessage(e?.message || 'Could not update the tickets.');
    } finally {
      setWorking('');
    }
  }

  function exportCsv() {
    downloadCsv(`nuvriqo-device-id-cleanup-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Value in Device ID field', 'Tickets', 'Example tickets', 'Why it was rejected', 'Suggested Device ID', 'Matched by'],
      values.map((v) => [v.value, v.ticketCount, (v.issueKeys || []).join(' '), v.reason, v.suggestion?.deviceId || '', v.suggestion?.matchedBy || '']));
  }

  const busy = Boolean(working);
  return (
    <div className="card fault-card" style={{ marginTop: 16 }}>
      <div className="section-head">
        <div>
          <h2>Device ID clean-up</h2>
          <p>Values in the Jira Device ID field that aren't Device IDs, so the scan didn't create devices from them. Found by the Jira scan or <strong>Preview Jira scan</strong> in Configuration; counts are from the latest one.{counts.fixed ? ` ${counts.fixed} fixed or cleared so far.` : ''}{counts.ignored ? ` ${counts.ignored} ignored.` : ''}</p>
        </div>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{loading ? 'Loading…' : `${values.length} to review`}<button className="secondary" onClick={exportCsv} disabled={!values.length}>Export CSV</button></span>
      </div>
      {message && <div className="notice" role="status">{message}</div>}
      {notes.partial && <div className="card report-warning">Suggestions only checked the first 10,000 devices.</div>}
      {notes.truncated && <div className="card report-warning">Showing the first 1,000 values. Fix or ignore some and refresh to see the rest.</div>}
      <div className="table-wrap">
        <table aria-label="Device ID clean-up">
          <thead><tr><th>Value in the Device ID field</th><th>Tickets</th><th>Why</th><th>Correct Device ID</th><th>Action</th></tr></thead>
          <tbody>
            {!loading && !values.length && <tr><td colSpan="5">Nothing to clean up. Run <strong>Preview Jira scan</strong> in Configuration to check the Device ID field.</td></tr>}
            {values.map((v) => (
              <tr key={v.value} style={{ cursor: 'default' }}>
                <td><strong>{v.value}</strong></td>
                <td>{v.ticketCount}<small style={{ display: 'block' }}>{(v.issueKeys || []).slice(0, 5).map((k, i) => <React.Fragment key={k}>{i ? ', ' : ''}<button className="issue-link" onClick={() => router.open(`/browse/${k}`)}>{k}</button></React.Fragment>)}{v.ticketCount > 5 ? ', …' : ''}</small></td>
                <td>{v.reason}</td>
                <td>
                  <input aria-label={`Correct Device ID for ${v.value}`} value={chosen[v.value] || ''} placeholder="Device ID" disabled={busy} onChange={(e) => setChosen({ ...chosen, [v.value]: e.target.value })} style={{ width: 130 }} />
                  {v.suggestion && <small style={{ display: 'block' }}>Suggested: {v.suggestion.deviceId} ({v.suggestion.matchedBy})</small>}
                </td>
                <td>
                  <div className="actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap', gap: 6 }}>
                    <button className="primary" disabled={busy || !(chosen[v.value] || '').trim()} onClick={() => act(v, 'fix')}>{working === v.value ? 'Working…' : 'Fix tickets'}</button>
                    <button className="secondary" disabled={busy} onClick={() => act(v, 'clear')}>Clear field</button>
                    <button className="secondary" disabled={busy} onClick={() => act(v, 'ignore')}>Ignore</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
