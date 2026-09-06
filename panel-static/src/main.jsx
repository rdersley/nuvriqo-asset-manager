import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, view } from '@forge/bridge';
import './styles.css';

function App() {
  const [issueKey, setIssueKey] = useState('');
  const [ctx, setCtx] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh(key = issueKey) {
    if (!key) return;
    const data = await invoke('getIssueAssetContext', { issueKey: key });
    setCtx(data);
  }

  useEffect(() => {
    view.getContext()
      .then(async (context) => {
        const key = context?.extension?.issue?.key || '';
        setIssueKey(key);
        if (key) await refresh(key);
      })
      .catch((e) => setError(e?.message || 'Could not load asset information.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!query.trim()) return setResults([]);
      try {
        const rows = await invoke('searchPanelAssets', { query });
        setResults(Array.isArray(rows) ? rows : []);
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  async function run(action, payload, success) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await invoke(action, { issueKey, ...payload });
      setCtx(data);
      setQuery('');
      setResults([]);
      setMessage(success);
    } catch (e) {
      setError(e?.message || 'Could not update asset links.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="shell muted">Loading assets…</div>;
  if (!issueKey) return <div className="shell error">This panel needs a Jira issue.</div>;

  return (
    <div className="shell">
      <section>
        <div className="heading">
          <div><span className="eyebrow">Primary asset</span><h3>{ctx?.configured?.primaryFieldName || 'Device ID'}</h3></div>
          {ctx?.primaryAsset && <button disabled={busy} className="link-button danger" onClick={() => run('clearPrimaryAsset', {}, 'Primary asset removed.')}>Remove</button>}
        </div>
        {ctx?.primaryAsset ? (
          <div className="asset-card primary"><strong>{ctx.primaryAsset.name}</strong><small>{[ctx.primaryAsset.type, ctx.primaryAsset.status, ctx.primaryAsset.assigneeName || ctx.primaryAsset.crewCode].filter(Boolean).join(' · ')}</small></div>
        ) : <p className="muted">No primary asset linked.</p>}
      </section>

      <section>
        <div className="heading"><div><span className="eyebrow">Related assets</span><h3>{ctx?.configured?.relatedFieldName || 'Related Device ID'}</h3></div></div>
        {!ctx?.configured?.related && <div className="warning">Map the Jira related asset field in Asset Manager Configuration before adding related devices.</div>}
        {ctx?.relatedAssets?.length ? (
          <div className="related-list">
            {ctx.relatedAssets.map((item) => (
              <div className="related-row" key={item.identifier}>
                <div><strong>{item.asset?.name || item.identifier}</strong><small>{item.asset ? [item.asset.type, item.asset.status].filter(Boolean).join(' · ') : 'Identifier not found in Asset Manager'}</small></div>
                <button disabled={busy} className="link-button danger" onClick={() => run('removeRelatedAsset', { assetId: item.asset?.id || '', identifier: item.identifier }, 'Related asset removed.')}>Remove</button>
              </div>
            ))}
          </div>
        ) : <p className="muted">No related assets linked.</p>}
      </section>

      <section>
        <label className="search-label">Find an asset<input value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)} placeholder="Search device name, ID, serial or model…" /></label>
        {results.length > 0 && <div className="results">{results.map((asset) => <div className="result" key={asset.id}><div><strong>{asset.name}</strong><small>{[asset.jiraIdentifier, asset.type, asset.holder].filter(Boolean).join(' · ')}</small></div><div className="actions"><button disabled={busy || !ctx?.configured?.primary} onClick={() => run('setPrimaryAsset', { assetId: asset.id }, 'Primary asset updated.')}>Primary</button><button disabled={busy || !ctx?.configured?.related || ctx?.primaryAsset?.id === asset.id} onClick={() => run('addRelatedAsset', { assetId: asset.id }, 'Related asset added.')}>Related</button></div></div>)}</div>}
      </section>

      <div className="help">Use <strong>Primary</strong> for the device the ticket is mainly about. Use <strong>Related</strong> for additional devices involved in the same issue.</div>
      {message && <div className="success">{message}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
