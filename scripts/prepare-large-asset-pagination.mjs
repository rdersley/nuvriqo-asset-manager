import fs from 'node:fs';

// Add a cursor-paged asset listing resolver so the UI can load registers far larger
// than the per-invocation safety cap without asking Forge to read everything at once.
const backendPath = new URL('../src/index.js', import.meta.url);
let backend = fs.readFileSync(backendPath, 'utf8');

if (!backend.includes("resolver.define('listAssetsPage'")) {
  const marker = "resolver.define('listAssets',async({payload})=>";
  const insertAt = backend.indexOf(marker);
  if (insertAt < 0) throw new Error('Could not locate listAssets resolver for large-register pagination.');

  const resolver = `resolver.define('listAssetsPage',async({payload})=>{\n  const query=String(payload?.query||'').toLowerCase(),status=clean(payload?.status||''),type=clean(payload?.type||''),location=clean(payload?.location||'');\n  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));\n  let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(limit);\n  if(payload?.cursor)q=q.cursor(payload.cursor);\n  const page=await q.getMany();\n  let items=page.results.map(e=>e.value);\n  if(query)items=items.filter(a=>[a.id,a.name,a.jiraIdentifier,a.crewCode,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location].some(v=>String(v||'').toLowerCase().includes(query)));\n  if(status)items=items.filter(a=>a.status===status);\n  if(type)items=items.filter(a=>a.type===type);\n  if(location)items=items.filter(a=>a.location===location);\n  return{items,nextCursor:page.nextCursor||null,scanned:page.results.length};\n});\n`;
  backend = backend.slice(0, insertAt) + resolver + backend.slice(insertAt);
  fs.writeFileSync(backendPath, backend);
}

if (!backend.includes("resolver.define('countAssetsPage'")) {
  const marker = "resolver.define('listAssets',async({payload})=>";
  const insertAt = backend.indexOf(marker);
  if (insertAt < 0) throw new Error('Could not locate listAssets resolver for asset counting.');
  const resolver = `resolver.define('countAssetsPage',async({payload})=>{\n  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));\n  let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(limit);\n  if(payload?.cursor)q=q.cursor(payload.cursor);\n  const page=await q.getMany();\n  return{count:page.results.length,nextCursor:page.nextCursor||null};\n});\n`;
  backend = backend.slice(0, insertAt) + resolver + backend.slice(insertAt);
  fs.writeFileSync(backendPath, backend);
}

// Patch the final UI preparation step so the Assets page loads a useful working set
// immediately instead of trying to walk an entire 10k-20k register on every refresh.
// The previous 200-page loop could consume the installation read budget and then clear
// the table, which made a successful large import appear to contain zero records.
const uiPrepPath = new URL('../static/scripts/prepare-nonblocking-load.mjs', import.meta.url);
let uiPrep = fs.readFileSync(uiPrepPath, 'utf8');
const oldLoad = "    try{const assetRows=await invoke('listAssets',{query,status,type,location});setAssets(assetRows||[]);}catch(e){setAssets([]);setMessage((m)=>m||e?.message||'Could not load assets. Configuration is still available.');}";
const newLoad = "    try{let cursor=null,assetRows=[],guard=0,lastError=null;do{try{const page=await invoke('listAssetsPage',{query,status,type,location,cursor,limit:100});assetRows.push(...(page?.items||[]));cursor=page?.nextCursor||null;guard+=1;}catch(e){lastError=e;break;}}while(cursor&&guard<10);assetRows.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));setAssets(assetRows);if(lastError&&assetRows.length)setMessage((m)=>m||'Showing loaded assets; more records are available but the current read window was reached. Refine the filters to narrow the register.');else if(lastError)setMessage((m)=>m||lastError?.message||'Could not load assets. Configuration is still available.');else if(cursor)setMessage((m)=>m||'Showing the first 1,000 matching records. Refine the filters to browse the rest of this large register safely.');}catch(e){setAssets((current)=>current?.length?current:[]);setMessage((m)=>m||e?.message||'Could not load assets. Configuration is still available.');}";
if (!uiPrep.includes(newLoad)) {
  if (!uiPrep.includes(oldLoad)) throw new Error('Could not locate Asset Manager asset load step.');
  uiPrep = uiPrep.replace(oldLoad, newLoad);
  fs.writeFileSync(uiPrepPath, uiPrep);
}

console.log('Prepared bounded cursor pagination for large asset registers.');
