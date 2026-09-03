import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import { readAssetImportFile, validateImportRows } from './importUtils';

export default function ImportDialog({ existingAssets, onImport, onClose }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    try {
      const parsed = await readAssetImportFile(file, customFields);
      const checked = validateImportRows(parsed, existingAssets);
      setFileName(file.name);
      setRows(checked);
      if (!checked.length) setError('No asset rows were found in this file.');
    } catch (e) {
      setRows([]);
      setFileName('');
      setError(e?.message || 'Could not read this file.');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!validRows.length) return;
    setBusy(true);
    setError('');
    try {
      await onImport(validRows.map(({ _row, _error, ...asset }) => asset));
      onClose();
    } catch (e) {
      setError(e?.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(9,30,66,.45)', display: 'grid', placeItems: 'center', zIndex: 1000, padding: 24 }}>
      <div className="card form-card" style={{ width: 'min(980px, 100%)', maxHeight: '88vh', overflow: 'auto' }}>
        <div className="section-head">
          <div><h2>Import assets</h2><p>Upload CSV or Excel (.xlsx), review the rows, then create the valid assets. Configured custom asset fields are matched by field name or key.</p></div>
          <button className="secondary" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <label className="file-button" style={{ display: 'inline-block', marginBottom: 16 }}>
          {busy ? 'Reading file…' : 'Choose CSV or Excel file'}
          <input type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => chooseFile(e.target.files?.[0])} disabled={busy} />
        </label>

        {fileName && <div className="notice">{fileName}: {validRows.length} ready to import{invalidRows.length ? `, ${invalidRows.length} need attention` : ''}.</div>}
        {error && <div className="notice">{error}</div>}

        {rows.length > 0 && <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Row</th><th>Device Name</th><th>Type</th><th>Serial</th><th>Assigned to</th><th>Result</th></tr></thead>
            <tbody>{rows.slice(0, 200).map((row) => <tr key={`${row._row}-${row.name}`}>
              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.type || '—'}</td><td>{row.serialNumber || '—'}</td><td>{row.assigneeName || '—'}</td>
              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : 'Ready'}</td>
            </tr>)}</tbody>
          </table>
          {rows.length > 200 && <p>Showing the first 200 of {rows.length} rows.</p>}
        </div>}

        <div className="actions">
          <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={runImport} disabled={busy || !validRows.length}>{busy ? 'Working…' : `Import ${validRows.length || ''} asset${validRows.length === 1 ? '' : 's'}`}</button>
        </div>
      </div>
    </div>
  );
}
