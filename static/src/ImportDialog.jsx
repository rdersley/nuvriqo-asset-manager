import React, { useEffect, useRef, useState } from 'react';
import { invoke } from './invoke.js';
import { isBusyFailure } from './importRetry.js';
import { duplicateTargets, importTargets, mapImportRows, mappingToRemember, readImportTable, suggestMapping, validateImportRows } from './importUtils';

const MAPPING_KEY = 'nuvriqo.assetImport.mapping';
const loadRemembered = () => { try { const v = JSON.parse(localStorage.getItem(MAPPING_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const saveRemembered = (v) => { try { localStorage.setItem(MAPPING_KEY, JSON.stringify(v)); } catch { /* not available */ } };

export default function ImportDialog({ onImport, onClose }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState([]);
  const [table, setTable] = useState(null);
  const [mapping, setMapping] = useState([]);
  const [mappingChanged, setMappingChanged] = useState(false);
  const [progress, setProgress] = useState('');
  const [outcome, setOutcome] = useState('');
  const targets = importTargets(customFields);
  const duplicates = duplicateTargets(mapping);
  const nameMapped = mapping.includes('name');
  const sample = (i) => table?.rows.slice(0, 3).map((r) => String(r[i] ?? '').trim()).filter(Boolean).join(', ') || '';

  useEffect(() => {
    invoke('getSettings')
      .then((settings) => setCustomFields(Array.isArray(settings?.customFields) ? settings.customFields : []))
      .catch(() => setCustomFields([]));
  }, []);

  const validRows = rows.filter((row) => !row._error);
  const invalidRows = rows.filter((row) => row._error);

  async function chooseFile(file) {
    if (!file) return;
    setBusy(true);
    setError('');
    setOutcome('');
    setProgress(`Reading ${file.name}…`);
    try {
      const read = await readImportTable(file);
      const suggested = suggestMapping(read.headers, customFields, loadRemembered());
      setTable(read);
      setMapping(suggested);
      setFileName(file.name);
      if (!suggested.includes('name')) { setRows([]); setPreview([]); setMappingChanged(true); setError('Choose which column holds the Device Name, then select Check rows.'); return; }
      await checkRows(read, suggested);
    } catch (e) {
      setRows([]);
      setPreview([]);
      setTable(null);
      setMapping([]);
      setFileName('');
      setError(e?.message || 'Could not read this file.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  async function recheck() {
    setBusy(true);
    setError('');
    setOutcome('');
    try {
      const remembered = loadRemembered();
      saveRemembered({ ...remembered, ...mappingToRemember(table.headers, mapping, customFields) });
      await checkRows(table, mapping);
    } catch (e) {
      setRows([]);
      setPreview([]);
      setError(e?.message || 'Could not check the rows.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  }

  function changeMapping(index, target) {
    setMapping(mapping.map((t, i) => (i === index ? target : t)));
    setMappingChanged(true);
  }

  // Rows show straight away. The first 200 are then compared with the register in the
  // background (an informational preview: the import does the same matching itself), so a busy
  // Jira never holds up the window. A newer check or starting the import discards a stale preview.
  const previewRun = useRef(0);
  async function checkRows(read, currentMapping) {
    setMappingChanged(false);
    const checked = validateImportRows(mapImportRows(read, currentMapping));
    const run = ++previewRun.current;
    const previewRows = checked.filter((row) => !row._error).slice(0, 200);
    const previewed = new Set(previewRows.map((row) => row._row));
    setRows(checked.map((row) => (row._error ? row : { ...row, _reconcile: previewed.has(row._row) ? { action: 'checking', message: 'Checking against the register…' } : { action: 'deferred', message: 'Will be reconciled safely during import.' } })));
    setPreview([]);
    if (!checked.length) setError('No asset rows were found in this file.');
    if (previewRows.length) previewInBackground(previewRows, run);
  }

  async function previewInBackground(previewRows, run) {
    const matches = [];
    try {
      for (let i = 0; i < previewRows.length; i += 50) {
        const batch = previewRows.slice(i, i + 50);
        const result = await invoke('previewAssetImportReconciliation', { assets: batch.map(({ _row, _error, _reconcile, ...asset }) => asset) });
        if (previewRun.current !== run) return;
        const byRow = new Map(batch.map((row, j) => [row._row, (result || [])[j]]).filter(([, m]) => m));
        matches.push(...byRow.values());
        setRows((current) => current.map((row) => {
          const match = !row._error && byRow.get(row._row);
          if (!match) return row;
          return match.action === 'review' ? { ...row, _error: match.message, _reconcile: match } : { ...row, _reconcile: match };
        }));
        setPreview([...matches]);
      }
    } catch {
      if (previewRun.current !== run) return;
      setRows((current) => current.map((row) => (row._reconcile?.action === 'checking' ? { ...row, _reconcile: { action: 'deferred', message: 'Will be reconciled safely during import.' } } : row)));
    }
  }

  async function runImport() {
    if (!validRows.length || mappingChanged) return;
    previewRun.current += 1;
    const total = validRows.length;
    setBusy(true);
    setError('');
    setOutcome('');
    setProgress(`Importing 0 / ${total}…`);
    try {
      const result = await onImport(validRows.map(({ _row, _error, _reconcile, ...asset }) => asset), (done, _total, retrying) => setProgress(retrying ? `Imported ${done} / ${total}; Jira is busy, trying ${retrying} rows again shortly…` : `Importing ${done} / ${total}…`));
      const failed = result?.failed || [];
      const done = result?.done ?? total;
      if (!failed.length && !result?.error) { onClose(); return; }
      // Drop the rows that were imported so pressing Import again cannot repeat them. Rows that
      // failed stay listed with their reason; rows not reached yet stay ready to import.
      // Rows Jira was still too busy for stay ready to import, so pressing Import tries them again.
      const busy = failed.filter(isBusyFailure);
      const reasons = new Map(failed.filter((f) => !isBusyFailure(f)).map((f) => [f.index, f.error || 'Could not be imported.']));
      const busyRows = new Set(busy.map((f) => f.index));
      let index = 0;
      setRows(rows.flatMap((row) => {
        if (row._error) return [row];
        const i = index++;
        if (busyRows.has(i)) return [{ ...row, _reconcile: { action: 'deferred', message: 'Jira was busy; press Import to try again.' } }];
        if (reasons.has(i)) return [{ ...row, _error: reasons.get(i), _reconcile: null }];
        return i >= done ? [row] : [];
      }));
      const imported = (result.created || 0) + (result.updated || 0) + (result.merged || 0);
      const parts = [`${imported} imported (${result.created || 0} created, ${result.updated || 0} updated, ${result.merged || 0} merged)${result.unchanged ? `, ${result.unchanged} already up to date` : ''}`];
      if (reasons.size) parts.push(`${reasons.size} could not be imported; the reason is shown in the Result column`);
      if (busy.length) parts.push(`${busy.length} were not imported because Jira was busy; press Import to try them again`);
      if (result.error) parts.push(`the import stopped after ${done} of ${total} rows (${result.error}). Press Import to continue with the remaining ${total - done}`);
      setOutcome(`${parts.join('; ')}.`);
    } catch (e) {
      setOutcome(e?.message || 'Import failed.');
    } finally {
      setProgress('');
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(9,30,66,.45)', display: 'grid', placeItems: 'center', zIndex: 1000, padding: 24 }}>
      <div className="card form-card" style={{ width: 'min(980px, 100%)', maxHeight: '88vh', overflow: 'auto' }}>
        <div className="section-head">
          <div><h2>Import assets</h2><p>Upload CSV or Excel (.xlsx), review the rows, then create the valid assets. Check how each column is mapped; headings that don't match are listed so you can choose the field. Mapping changes are remembered for next time.</p></div>
          <button className="secondary" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <label className="file-button" style={{ display: 'inline-block', marginBottom: 16 }}>
          {busy ? 'Reading file…' : 'Choose CSV or Excel file'}
          <input type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => chooseFile(e.target.files?.[0])} disabled={busy} />
        </label>

        {table && table.headers.length > 0 && <details open={mappingChanged || !nameMapped || mapping.some((t) => !t)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, marginBottom: 8 }}>Column mapping ({mapping.filter(Boolean).length} of {table.headers.length} columns used)</summary>
          <div className="table-wrap"><table aria-label="Column mapping">
            <thead><tr><th>Column in file</th><th>Example values</th><th>Import into</th></tr></thead>
            <tbody>{table.headers.map((header, i) => <tr key={i} style={{ cursor: 'default' }}>
              <td><strong>{header || `Column ${i + 1}`}</strong></td>
              <td><small>{sample(i) || '—'}</small></td>
              <td><select value={mapping[i] || ''} disabled={busy} onChange={(e) => changeMapping(i, e.target.value)}>
                <option value="">Don't import</option>
                {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>{duplicates.includes(mapping[i]) && <small>Used by more than one column</small>}</td>
            </tr>)}</tbody>
          </table></div>
          {mappingChanged && <div className="actions" style={{ justifyContent: 'flex-start', marginTop: 10 }}>
            <button className="primary" onClick={recheck} disabled={busy || !nameMapped || duplicates.length > 0}>{busy ? 'Checking…' : 'Check rows'}</button>
            {!nameMapped && <span className="muted">Map a column to Device Name.</span>}
            {duplicates.length > 0 && <span className="muted">Each field can only come from one column.</span>}
          </div>}
        </details>}

        {fileName && !mappingChanged && !outcome && <div className="notice">{fileName}: {validRows.length} ready to import{invalidRows.length ? `, ${invalidRows.length} need attention` : ''}.{validRows.length>200?' Large-file mode: the first 200 valid rows are previewed now; remaining rows are reconciled in safe batches during import.':''}</div>}
        {error && <div className="notice">{error}</div>}

        {rows.length > 0 && !mappingChanged && <div className="table-wrap" style={{ marginTop: 12 }}>
          <table aria-label="Import preview">
            <thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Serial</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>
            <tbody>{rows.slice(0, 200).map((row) => <tr key={`${row._row}-${row.name}`}>
              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.serialNumber || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>
              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : <span>{row._reconcile?.action==='merge-serial'?'Merge by serial':row._reconcile?.action==='update-device-id'?'Update existing':row._reconcile?.action==='update-name'?'Update by name':row._reconcile?.action==='deferred'?'Reconcile during import':row._reconcile?.action==='checking'?'Checking…':'Create new'}{row._reconcile?.message?<small style={{display:'block'}}>{row._reconcile.message}</small>:null}</span>}</td>
            </tr>)}</tbody>
          </table>
          {rows.length > 200 && <p>Showing the first 200 of {rows.length} rows.</p>}
        </div>}

        {(progress || outcome) && <div className="notice" role="status" style={{ marginTop: 12 }}>{progress || outcome}</div>}
        <div className="actions">
          <button className="secondary" onClick={onClose} disabled={busy}>{outcome ? 'Close' : 'Cancel'}</button>
          <button className="primary" onClick={runImport} disabled={busy || mappingChanged || !validRows.length}>{progress || (busy ? 'Working…' : `Import ${validRows.length || ''} asset${validRows.length === 1 ? '' : 's'}`)}</button>
        </div>
      </div>
    </div>
  );
}
