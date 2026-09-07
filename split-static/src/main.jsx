import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import './styles.css';

function App() {
  const [issueKey, setIssueKey] = useState('');
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

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
      .catch((e) => setError(e?.message || 'Could not inspect this ticket.'))
      .finally(() => setLoading(false));
  }, []);

  const activeItems = useMemo(() => (data?.items || []).filter((item) => selected[item.identifier] && !item.alreadySplit), [data, selected]);

  function toggle(identifier) {
    setSelected((current) => ({ ...current, [identifier]: !current[identifier] }));
  }

  async function createSubtasks() {
    if (!activeItems.length || !data?.canCreateSubtasks) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await invoke('createDeviceSubtasks', {
        issueKey,
        items: activeItems.map(({ identifier, fault, assetId }) => ({ identifier, fault, assetId }))
      });
      setResult(response);
      await load(issueKey);
    } catch (e) {
      setError(e?.message || 'Could not create device sub-tasks.');
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
