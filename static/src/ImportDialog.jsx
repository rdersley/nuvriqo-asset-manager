import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import { readAssetImportFile, validateImportRows } from './importUtils';

export default function ImportDialog({ existingAssets, onImport, onClose }) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState([]);

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
      let reconciled=checked;
      const valid=checked.filter((row)=>!row._error);
      if(valid.length){
        const previewLimit=Math.min(valid.length,200);
        const previewRows=valid.slice(0,previewLimit);
        const matches=[];
        const previewBatchSize=20;
        for(let i=0;i<previewRows.length;i+=previewBatchSize){
          const batch=previewRows.slice(i,i+previewBatchSize).map(({_row,_error,...asset})=>asset);
          const result=await invoke('previewAssetImportReconciliation',{assets:batch});
          matches.push(...(result||[]));
        }
        let matchIndex=0;
        let validIndex=0;
        reconciled=checked.map((row)=>{
          if(row._error)return row;
          const isPreviewed=validIndex<previewLimit;
          validIndex+=1;
          if(!isPreviewed)return {...row,_reconcile:{action:'deferred',message:'Will be reconciled safely during import.'}};
          const match=matches?.[matchIndex++]||null;
          return match?.action==='review'?{...row,_error:match.message,_reconcile:match}:{...row,_reconcile:match};
        });
        setPreview(matches||[]);
      }else setPreview([]);
      setRows(reconciled);
      if (!checked.length) setError('No asset rows were found in this file.');
    } catch (e) {
      setRows([]);
      setPreview([]);
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
          <div><h2>Import assets</h2><p>Upload CSV or Excel (.xlsx), review the rows, then create the valid assets. Device ID, Assignment Reference and Assigned Person / Holder headers are supported, and Jira account identity remains optional.</p></div>
          <button className="secondary" onClick={onClose} disabled={busy}>Close</button>
        </div>

        <label className="file-button" style={{ display: 'inline-block', marginBottom: 16 }}>
          {busy ? 'Reading file…' : 'Choose CSV or Excel file'}
          <input type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => chooseFile(e.target.files?.[0])} disabled={busy} />
        </label>

        {fileName && <div className="notice">{fileName}: {validRows.length} ready to import{invalidRows.length ? `, ${invalidRows.length} need attention` : ''}.{validRows.length>200?' Large-file mode: the first 200 valid rows are previewed now; remaining rows are reconciled in safe batches during import.':''}</div>}
        {error && <div className="notice">{error}</div>}

        {rows.length > 0 && <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Serial</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>
            <tbody>{rows.slice(0, 200).map((row) => <tr key={`${row._row}-${row.name}`}>
              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.serialNumber || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>
              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : <span>{row._reconcile?.action==='merge-serial'?'Merge by serial':row._reconcile?.action==='update-device-id'?'Update existing':row._reconcile?.action==='update-name'?'Update by name':row._reconcile?.action==='deferred'?'Reconcile during import':'Create new'}{row._reconcile?.message?<small style={{display:'block'}}>{row._reconcile.message}</small>:null}</span>}</td>
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
