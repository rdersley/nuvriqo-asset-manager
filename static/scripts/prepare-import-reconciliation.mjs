import fs from 'node:fs';

const mainPath = new URL('../src/main.jsx', import.meta.url);
let main = fs.readFileSync(mainPath, 'utf8');
const newImport = "  async function importAssets(rows){let created=0,updated=0,merged=0,failed=[];for(let i=0;i<rows.length;i+=50){const result=await invoke('reconcileAssetImport',{assets:rows.slice(i,i+50)});created+=result.created||0;updated+=result.updated||0;merged+=result.merged||0;failed.push(...(result.failed||[]));setMessage(`Reconciling import… ${Math.min(i+50,rows.length)} / ${rows.length}`);}setMessage(`Import complete: ${created} created, ${updated} updated, ${merged} merged${failed.length?`, ${failed.length} need review`:''}.`);await load();if(failed.length)throw new Error(`${failed.length} row${failed.length===1?'':'s'} could not be reconciled automatically.`);}";

if (!main.includes("invoke('reconcileAssetImport'")) {
  const match = main.match(/  async function importAssets\(rows\)\{[\s\S]*?\}\n(?=  async function )/);
  if (!match) throw new Error('Could not locate Asset Manager import handler.');
  main = main.replace(match[0], `${newImport}\n`);
}
fs.writeFileSync(mainPath, main);

const dialogPath = new URL('../src/ImportDialog.jsx', import.meta.url);
let dialog = fs.readFileSync(dialogPath, 'utf8');
if(!dialog.includes('const [preview, setPreview]')){
  dialog=dialog.replace("  const [busy, setBusy] = useState(false);", "  const [busy, setBusy] = useState(false);\n  const [preview, setPreview] = useState([]);");
  dialog=dialog.replace("      setRows(checked);\n      if (!checked.length) setError('No asset rows were found in this file.');", "      let reconciled=checked;\n      const valid=checked.filter((row)=>!row._error);\n      if(valid.length){\n        const matches=await invoke('previewAssetImportReconciliation',{assets:valid.map(({_row,_error,...asset})=>asset)});\n        let matchIndex=0;\n        reconciled=checked.map((row)=>{if(row._error)return row;const match=matches?.[matchIndex++]||null;return match?.action==='review'?{...row,_error:match.message,_reconcile:match}:{...row,_reconcile:match};});\n        setPreview(matches||[]);\n      }else setPreview([]);\n      setRows(reconciled);\n      if (!checked.length) setError('No asset rows were found in this file.');");
  dialog=dialog.replace("      setRows([]);\n      setFileName('');", "      setRows([]);\n      setPreview([]);\n      setFileName('');");
  dialog=dialog.replace("<thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>", "<thead><tr><th>Row</th><th>Device Name</th><th>Device ID</th><th>Serial</th><th>Type</th><th>Assignment Reference</th><th>Holder</th><th>Result</th></tr></thead>");
  dialog=dialog.replace("              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>\n              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : 'Ready'}</td>", "              <td>{row._row}</td><td><strong>{row.name || '—'}</strong></td><td>{row.jiraIdentifier || '—'}</td><td>{row.serialNumber || '—'}</td><td>{row.type || '—'}</td><td>{row.crewCode || '—'}</td><td>{row.assigneeName || '—'}</td>\n              <td>{row._error ? <span style={{ fontWeight: 600 }}>{row._error}</span> : <span>{row._reconcile?.action==='merge-serial'?'Merge by serial':row._reconcile?.action==='update-device-id'?'Update existing':row._reconcile?.action==='update-name'?'Update by name':'Create new'}{row._reconcile?.message?<small style={{display:'block'}}>{row._reconcile.message}</small>:null}</span>}</td>");
}
fs.writeFileSync(dialogPath, dialog);
console.log('CSV reconciliation UI prepared.');
