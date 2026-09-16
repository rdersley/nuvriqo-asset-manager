import fs from 'node:fs';

const mainPath = new URL('../src/main.jsx', import.meta.url);
let main = fs.readFileSync(mainPath, 'utf8');
const newImport = "  async function importAssets(rows){let created=0,updated=0,merged=0,failed=[];const batchSize=25;for(let i=0;i<rows.length;i+=batchSize){const result=await invoke('reconcileAssetImport',{assets:rows.slice(i,i+batchSize)});created+=result.created||0;updated+=result.updated||0;merged+=result.merged||0;failed.push(...(result.failed||[]));setMessage(`Reconciling import… ${Math.min(i+batchSize,rows.length)} / ${rows.length}`);if(i+batchSize<rows.length)await new Promise(resolve=>setTimeout(resolve,100));}setMessage(`Import complete: ${created} created, ${updated} updated, ${merged} merged${failed.length?`, ${failed.length} need review`:''}.`);await load();if(failed.length)throw new Error(`${failed.length} row${failed.length===1?'':'s'} could not be reconciled automatically.`);}";

if (!main.includes("invoke('reconcileAssetImport'")) {
  const match = main.match(/  async function importAssets\(rows\)\{[\s\S]*?\}\n(?=  async function )/);
  if (!match) throw new Error('Could not locate Asset Manager import handler.');
  main = main.replace(match[0], `${newImport}\n`);
} else {
  main = main.replace(/  async function importAssets\(rows\)\{[\s\S]*?\}\n(?=  async function )/, `${newImport}\n`);
}
fs.writeFileSync(mainPath, main);

const dialogPath = new URL('../src/ImportDialog.jsx', import.meta.url);
let dialog = fs.readFileSync(dialogPath, 'utf8');
if(!dialog.includes('const [preview, setPreview]')){
  dialog=dialog.replace("  const [busy, setBusy] = useState(false);", "  const [busy, setBusy] = useState(false);\n  const [preview, setPreview] = useState([]);");
  dialog=dialog.replace("      setRows(checked);\n      if (!checked.length) setError('No asset rows were found in this file.');", "      let reconciled=checked;\n      const valid=checked.filter((row)=>!row._error);\n      if(valid.length){\n        const previewLimit=Math.min(valid.length,200);\n        const previewRows=valid.slice(0,previewLimit);\n        const matches=[];\n        const previewBatchSize=20;\n        for(let i=0;i<previewRows.length;i+=previewBatchSize){\n          const batch=previewRows.slice(i,i+previewBatchSize).map(({_row,_error,...asset})=>asset);\n          const result=await invoke('previewAssetImportReconciliation',{assets:batch});\n          matches.push(...(result||[]));\n        }\n        let matchIndex=0;\n        let validIndex=0;\n        reconciled=checked.map((row)=>{\n          if(row._error)return row;\n          const isPreviewed=validIndex<previewLimit;\n          validIndex+=1;\n          if(!isPreviewed)return {...row,_reconcile:{action:'deferred',message:'Will be reconciled safely during import.'}};\n          const match=matches?.[matchIndex++]||null;\n          return match?.action==='review'?{...row,_error:match.message,_reconcile:match}:{...row,_reconcile:match};\n        });\n        setPreview(matches||[]);\n      }else setPreview([]);\n      setRows(reconciled);\n      if (!checked.length) setError('No asset rows were found in this file.');");
  dialog=dialog.replace("      setRows([]);\n      setFileName('');", "      setRows([]);\n      setPreview([]);\n      setFileName('');");
  dialog=dialog.replace("<thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>", "<thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Serial</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>");
  dialog=dialog.replace("              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>\n              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : 'Ready'}</td>", "              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.serialNumber || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>\n              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : <span>{row._reconcile?.action==='merge-serial'?'Merge by serial':row._reconcile?.action==='update-device-id'?'Update existing':row._reconcile?.action==='update-name'?'Update by name':row._reconcile?.action==='deferred'?'Reconcile during import':'Create new'}{row._reconcile?.message?<small style={{display:'block'}}>{row._reconcile.message}</small>:null}</span>}</td>");
  dialog=dialog.replace("{fileName && <div className=\"notice\">{fileName}: {validRows.length} ready to import{invalidRows.length ? `, ${invalidRows.length} need attention` : ''}.</div>}", "{fileName && <div className=\"notice\">{fileName}: {validRows.length} ready to import{invalidRows.length ? `, ${invalidRows.length} need attention` : ''}.{validRows.length>200?' Large-file mode: the first 200 valid rows are previewed now; remaining rows are reconciled in safe batches during import.':''}</div>}");
}
fs.writeFileSync(dialogPath, dialog);
console.log('CSV reconciliation UI prepared with bounded large-file preview.');
