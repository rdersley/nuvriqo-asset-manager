import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const startNeedle = "  const load=async()=>{const cfg=await invoke('getSettings');";
const start = src.indexOf(startNeedle);
if (start < 0) {
  if (src.includes('Asset Manager startup is intentionally non-blocking')) process.exit(0);
  throw new Error('Could not locate Asset Manager load function.');
}
const end = src.indexOf('\n  useEffect(', start);
if (end < 0) throw new Error('Could not locate Asset Manager load function end.');

const replacement = `  // Asset Manager startup is intentionally non-blocking. A Jira sync or large asset\n  // register must never prevent Configuration from opening. Jira discovery is run\n  // explicitly from Configuration instead of blocking every page load.\n  const load=async()=>{\n    let cfg=settings;\n    try{cfg=await invoke('getSettings');setSettings(cfg);}catch(e){setMessage(e?.message||'Could not load configuration.');}\n    try{const assetRows=await invoke('listAssets',{query,status,type,location});setAssets(assetRows||[]);}catch(e){setAssets([]);setMessage((m)=>m||e?.message||'Could not load assets. Configuration is still available.');}\n    try{const reports=await invoke('getAssetReport');setReportRows(reports||[]);}catch{setReportRows([]);}\n  };`;

src = src.slice(0, start) + replacement + src.slice(end);
fs.writeFileSync(path, src);
