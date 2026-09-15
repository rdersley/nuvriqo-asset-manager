import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const signature = "function ConfigurableAssetsTable({assets,settings,reportByAsset,query,setQuery,status,setStatus,type,setType,location,setLocation,onImport,onExport,onCreate,onOpenAsset}){";
const patchedSignature = "function ConfigurableAssetsTable({assets,settings,reportByAsset,query,setQuery,status,setStatus,type,setType,location,setLocation,onImport,onExport,onCreate,onOpenAsset,onBulkDeleted}){";
if (src.includes(signature)) src = src.replace(signature, patchedSignature);
else if (!src.includes(patchedSignature)) throw new Error('Could not locate ConfigurableAssetsTable signature.');

const stateNeedle = "  const [showOptions,setShowOptions]=useState(false);";
const statePatch = "  const [showOptions,setShowOptions]=useState(false);\n  const [selectedAssetIds,setSelectedAssetIds]=useState(()=>new Set());\n  const [bulkDeleting,setBulkDeleting]=useState(false);";
if (src.includes(stateNeedle)) src = src.replace(stateNeedle, statePatch);
else if (!src.includes('selectedAssetIds')) throw new Error('Could not add bulk-selection state.');

const removeFilterNeedle = "  const removeFilter=(key)=>{setActiveFilters(activeFilters.filter(x=>x!==key));setFilterValues(v=>{const next={...v};delete next[key];return next;});};";
const bulkHelpers = removeFilterNeedle + "\n  const shownIds=shownAssets.map(a=>a.id).filter(Boolean);\n  const allShownSelected=shownIds.length>0&&shownIds.every(id=>selectedAssetIds.has(id));\n  const toggleAssetSelection=(id)=>setSelectedAssetIds(current=>{const next=new Set(current);if(next.has(id))next.delete(id);else next.add(id);return next;});\n  const toggleAllShown=()=>setSelectedAssetIds(current=>{const next=new Set(current);if(allShownSelected)shownIds.forEach(id=>next.delete(id));else shownIds.forEach(id=>next.add(id));return next;});\n  const deleteSelectedAssets=async()=>{const ids=[...selectedAssetIds];if(!ids.length)return;if(!window.confirm('Delete '+ids.length+' selected asset'+(ids.length===1?'':'s')+' from Asset Manager? This does not delete the Jira tickets.'))return;setBulkDeleting(true);try{let removed=0;for(let i=0;i<ids.length;i+=100){const result=await invoke('bulkRemoveAssets',{ids:ids.slice(i,i+100)});removed+=result?.removed||0;}setSelectedAssetIds(new Set());await onBulkDeleted?.(removed);}finally{setBulkDeleting(false);}};";
if (src.includes(removeFilterNeedle)) src = src.replace(removeFilterNeedle, bulkHelpers);
else if (!src.includes('deleteSelectedAssets')) throw new Error('Could not add bulk-delete helpers.');

const actionsNeedle = '<div className="top-actions"><button className="secondary" onClick={()=>setShowOptions(!showOptions)}>Columns & filters</button><button className="secondary" onClick={onImport}>Import</button>';
const actionsPatch = '<div className="top-actions">{selectedAssetIds.size>0&&<button className="secondary" onClick={deleteSelectedAssets} disabled={bulkDeleting}>{bulkDeleting?\'Deleting…\':\'Delete selected (\'+selectedAssetIds.size+\')\'}</button>}<button className="secondary" onClick={()=>setShowOptions(!showOptions)}>Columns & filters</button><button className="secondary" onClick={onImport}>Import</button>';
if (src.includes(actionsNeedle)) src = src.replace(actionsNeedle, actionsPatch);
else if (!src.includes('Delete selected (')) throw new Error('Could not add Delete selected action.');

const tableNeedle = `{shownAssets.length?<div className="table-wrap"><table><thead><tr>{selectedColumns.map(key=><th key={key}>{columns.find(c=>c.key===key)?.label||key}</th>)}</tr></thead><tbody>{shownAssets.map(asset=><tr key={asset.id} onClick={()=>onOpenAsset(asset)}>{selectedColumns.map(key=><td key={key}>{renderCell(asset,key)}</td>)}</tr>)}</tbody></table></div>`;
const tablePatch = `{shownAssets.length?<div className="table-wrap"><table><thead><tr><th style={{width:'42px'}}><input type="checkbox" aria-label="Select all visible assets" checked={allShownSelected} onChange={toggleAllShown}/></th>{selectedColumns.map(key=><th key={key}>{columns.find(c=>c.key===key)?.label||key}</th>)}</tr></thead><tbody>{shownAssets.map(asset=><tr key={asset.id} onClick={()=>onOpenAsset(asset)}><td onClick={e=>e.stopPropagation()}><input type="checkbox" aria-label={'Select '+(asset.name||asset.id)} checked={selectedAssetIds.has(asset.id)} onChange={()=>toggleAssetSelection(asset.id)}/></td>{selectedColumns.map(key=><td key={key}>{renderCell(asset,key)}</td>)}</tr>)}</tbody></table></div>`;
if (src.includes(tableNeedle)) src = src.replace(tableNeedle, tablePatch);
else if (!src.includes('Select all visible assets')) throw new Error('Could not add row-selection checkboxes.');

const listNeedle = `onOpenAsset={(asset)=>{setSelected(asset);setMode('detail');}}/>;`;
const listPatch = `onOpenAsset={(asset)=>{setSelected(asset);setMode('detail');}} onBulkDeleted={async(removed)=>{setMessage('Deleted '+removed+' selected asset'+(removed===1?'':'s')+'.');await load();}}/>;`;
if (src.includes(listNeedle)) src = src.replace(listNeedle, listPatch);
else if (!src.includes('onBulkDeleted=')) throw new Error('Could not wire bulk-delete refresh callback.');

fs.writeFileSync(path, src);
console.log('Prepared multi-select bulk delete for Asset register.');
