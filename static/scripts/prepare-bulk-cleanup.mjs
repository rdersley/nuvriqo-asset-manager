import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

if (!src.includes('async function removeJiraImports()')) {
  const marker = "  async function deleteSelected(){if(!selected||!window.confirm(`Delete ${selected.name}?`))return;await invoke('deleteAsset',{id:selected.id});setSelected(null);setMode('overview');await load();}\n";
  if (!src.includes(marker)) throw new Error('Could not locate deleteSelected handler.');
  const addition = marker + "  async function removeJiraImports(){if(!window.confirm('Remove all assets that were automatically discovered from Jira? Manually created/imported assets will be kept. Automatic Jira discovery will also be paused so the incorrect devices are not immediately added again.'))return;try{setMessage('Removing Jira-imported assets…');const result=await invoke('bulkRemoveAssets',{removeAllDiscovered:true,discoveredOnly:true});setSettings(prev=>({...prev,jiraDiscoveryEnabled:false}));setMessage(`Removed ${result.removed||0} Jira-imported asset${result.removed===1?'':'s'}. Automatic Jira discovery is paused until you re-enable it in Configuration.`);const [assetRows,reports]=await Promise.all([invoke('listAssets',{query,status,type,location}),invoke('getAssetReport').catch(()=>[])]);setAssets(assetRows);setReportRows(reports);}catch(e){setMessage(e.message||'Could not remove Jira-imported assets.');}}\n";
  src = src.replace(marker, addition);
}

if (!src.includes('Remove Jira imports')) {
  const marker = "<div className=\"top-actions\"><button className=\"secondary\" onClick={()=>setShowImport(true)}>Import</button>";
  if (!src.includes(marker)) throw new Error('Could not locate Assets toolbar.');
  src = src.replace(marker, "<div className=\"top-actions\"><button className=\"secondary\" onClick={removeJiraImports}>Remove Jira imports</button><button className=\"secondary\" onClick={()=>setShowImport(true)}>Import</button>");
}

fs.writeFileSync(path, src);
