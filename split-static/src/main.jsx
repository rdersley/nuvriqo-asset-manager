import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import { errorMessage } from '../../shared/licence.js';
import './styles.css';

const FILL_ACTION_TEXT = {
  fill: 'will be filled',
  filled: 'filled',
  'already-set': 'already set',
  'kept-existing': 'already has a different value, left as it is',
  'no-value-in-register': 'nothing in the crew file',
  'not-on-edit-screen': 'not on the ticket\'s edit screen',
  'not-an-option': 'not one of the field\'s options'
};
const MATCH_TEXT = {
  'no-reporter': 'This ticket has no reporter.',
  'not-found': 'The reporter was not found in the crew file.',
  multiple: 'More than one crew member uses this reporter\'s email, so nothing is filled.'
};

function ReporterFill({ fill, enabled, setEnabled, busy, onFillNow }) {
  if (!fill) return null;
  const canFill = fill.rows.some((row) => row.action === 'fill');
  return (
    <section className="reporter-fill">
      <div className="device-title"><strong>Crew details from reporter</strong>{fill.reporter && <span className="badge neutral">{fill.reporter}</span>}</div>
      {fill.status === 'found' ? (
        <>
          <div className="fault">{fill.crew.name || fill.crew.crewCode} · crew code <strong>{fill.crew.crewCode}</strong>{fill.crew.base && <> · base <strong>{fill.crew.base}</strong></>}</div>
          {fill.rows.map((row) => <small key={row.fieldId}>{row.fieldName}: {row.action === 'kept-existing' ? `${row.current} — ` : ''}{FILL_ACTION_TEXT[row.action] || row.action}</small>)}
          {canFill && (
            <div className="fill-actions">
              <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} /> Fill these before creating sub-tasks, so the sub-tasks copy them</label>
              <button className="secondary" disabled={busy} onClick={onFillNow}>Fill now</button>
            </div>
          )}
        </>
      ) : <div className="fault">{MATCH_TEXT[fill.status] || 'Could not match the reporter to the crew file.'}{fill.reporterEmail ? ` (${fill.reporterEmail})` : ''}</div>}
    </section>
  );
}

function App() {
  const [issueKey, setIssueKey] = useState('');
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [fillEnabled, setFillEnabled] = useState(true);
  const [fillMessage, setFillMessage] = useState('');

  async function load(key) {
    const preview = await invoke('previewDeviceSplit', { issueKey: key });
    setData(preview);
    const next = {};
    for (const item of preview.items || []) next[item.identifier] = !item.alreadySplit;
    setSelected(next);
  }

  useEffect(() => {
    view.getContext()
      .then(async (context) => {
        const key = context?.extension?.issue?.key || '';
        setIssueKey(key);
        if (!key) throw new Error('This action needs a Jira issue.');
        await load(key);
      })
      .catch((e) => setError(errorMessage(e, 'Could not inspect this ticket.')))
      .finally(() => setLoading(false));
  }, []);

  const activeItems = useMemo(() => (data?.items || []).filter((item) => selected[item.identifier] && !item.alreadySplit), [data, selected]);

  function toggle(identifier) {
    setSelected((current) => ({ ...current, [identifier]: !current[identifier] }));
  }

  const fillPending = Boolean(data?.reporterFill?.rows?.some((row) => row.action === 'fill'));

  async function fillReporter() {
    const response = await invoke('fillReporterFields', { issueKey });
    setData((current) => ({ ...current, reporterFill: response.reporterFill || current.reporterFill }));
    setFillMessage(response.result === 'filled' ? `Crew details filled on ${issueKey}.` : '');
  }

  async function fillNow() {
    setBusy(true);
    setError('');
    try { await fillReporter(); } catch (e) { setError(errorMessage(e, 'Could not fill the crew details.')); } finally { setBusy(false); }
  }

  async function createSubtasks() {
    if (!activeItems.length || !data?.canCreateSubtasks) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      if (fillEnabled && fillPending) await fillReporter();
      const response = await invoke('createDeviceSubtasks', {
        issueKey,
        items: activeItems.map(({ identifier, fault, assetId }) => ({ identifier, fault, assetId }))
      });
      setResult(response);
      await load(issueKey);
    } catch (e) {
      setError(errorMessage(e, 'Could not create device sub-tasks.'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="shell"><div className="loading">Detecting devices…</div></main>;

  return (
    <main className="shell">
      <header>
        <span className="eyebrow">Nuvriqo Asset Manager</span>
        <h1>Split into device tickets</h1>
        <p>Review the devices detected in <strong>{issueKey}</strong>. Each selected device will get its own Jira sub-task.</p>
      </header>

      <ReporterFill fill={data?.reporterFill} enabled={fillEnabled} setEnabled={setFillEnabled} busy={busy} onFillNow={fillNow} />
      {fillMessage && <div className="note">{fillMessage}</div>}

      {data?.items?.length > 0 ? (
        <section className="device-list">
          {data.items.map((item) => (
            <label className={`device-row ${item.alreadySplit ? 'done' : ''}`} key={item.identifier}>
              <input
                type="checkbox"
                checked={Boolean(selected[item.identifier]) && !item.alreadySplit}
                disabled={busy || item.alreadySplit}
                onChange={() => toggle(item.identifier)}
              />
              <div className="device-copy">
                <div className="device-title">
                  <strong>{item.identifier}</strong>
                  <span className={item.recognised ? 'badge success' : 'badge warning'}>{item.recognised ? 'Asset found' : 'Not in Asset Manager'}</span>
                  {item.alreadySplit && <span className="badge neutral">Already split · {item.childKey}</span>}
                </div>
                <div className="fault">{item.fault || 'No individual fault text detected — see parent request.'}</div>
                <small>Detected from {item.source || 'ticket text'}</small>
                {item.recognised && item.assetName !== item.identifier && <small>{item.assetName}</small>}
              </div>
            </label>
          ))}
        </section>
      ) : (
        <div className="empty">No device identifiers were detected in the ticket summary or description. Add or correct the device IDs, then reopen this action.</div>
      )}

      {data?.subtaskType && <div className="note">Sub-task type: <strong>{data.subtaskType.name}</strong>. Priority is copied from the parent ticket. Recognised assets are linked to the new child ticket when the mapped device field allows it.</div>}
      {data?.subtaskWarning && <div className="error">{data.subtaskWarning}</div>}

      {result && (
        <div className="result-box">
          <strong>{result.created?.length || 0} device ticket{result.created?.length === 1 ? '' : 's'} created.</strong>
          {(result.created || []).map((item) => <div key={item.childKey}>{item.identifier} → {item.childKey}</div>)}
          {(result.skipped || []).length > 0 && <small>{result.skipped.length} already-created device ticket{result.skipped.length === 1 ? ' was' : 's were'} skipped.</small>}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <footer>
        <button className="secondary" disabled={busy} onClick={() => view.close()}>Close</button>
        <button disabled={busy || activeItems.length === 0 || !data?.canCreateSubtasks} onClick={createSubtasks}>
          {busy ? 'Creating…' : `Create ${activeItems.length || 0} sub-task${activeItems.length === 1 ? '' : 's'}`}
        </button>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
