import fs from 'node:fs';

// Add a cursor-paged asset listing resolver so the UI can load registers far larger
// than the per-invocation safety cap without asking Forge to read everything at once.
const backendPath = new URL('../src/index.js', import.meta.url);
let backend = fs.readFileSync(backendPath, 'utf8');

if (!backend.includes("resolver.define('listAssetsPage'")) {
  const marker = "resolver.define('listAssets',async({payload})=>";
  const insertAt = backend.indexOf(marker);
  if (insertAt < 0) throw new Error('Could not locate listAssets resolver for large-register pagination.');

  const resolver = `resolver.define('listAssetsPage',async({payload})=>{\n  const query=String(payload?.query||'').trim().toLowerCase(),status=clean(payload?.status||''),type=clean(payload?.type||''),location=clean(payload?.location||''),client=clean(payload?.client||'');\n  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));\n  const maxScanPages=Math.min(10,Math.max(1,Number(payload?.maxScanPages||1)));\n  let cursor=payload?.cursor||null,items=[],scanned=0,pages=0;\n  do{let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);if(cursor)q=q.cursor(cursor);const page=await q.getMany();scanned+=page.results.length;pages+=1;cursor=page.nextCursor||null;for(const entry of page.results){const a=entry.value;const matchesQuery=!query||[a.id,a.name,a.jiraIdentifier,a.crewCode,a.type,a.manufacturer,a.model,a.serialNumber,a.assigneeName,a.status,a.location,a.client].some(v=>String(v||'').toLowerCase().includes(query));if(!matchesQuery)continue;if(status&&a.status!==status)continue;if(type&&a.type!==type)continue;if(location&&a.location!==location)continue;if(client&&String(a.client||'')!==String(client))continue;items.push(a);if(items.length>=limit)break;}if(items.length>=limit)break;}while(cursor&&pages<maxScanPages);\n  return{items:items.slice(0,limit),nextCursor:cursor,scanned,pages,complete:!cursor};\n});\n`;
  backend = backend.slice(0, insertAt) + resolver + backend.slice(insertAt);
  fs.writeFileSync(backendPath, backend);
}

if (!backend.includes("resolver.define('countAssetsPage'")) {
  const marker = "resolver.define('listAssets',async({payload})=>";
  const insertAt = backend.indexOf(marker);
  if (insertAt < 0) throw new Error('Could not locate listAssets resolver for asset counting.');
  const resolver = `resolver.define('countAssetsPage',async({payload})=>{\n  const limit=Math.min(100,Math.max(1,Number(payload?.limit||100)));\n  let q=kvs.query().where('key',WhereConditions.beginsWith(ASSET_PREFIX)).limit(limit);\n  if(payload?.cursor)q=q.cursor(payload.cursor);\n  const page=await q.getMany();\n  const items=page.results.map(e=>e.value);\n  const byType={};\n  for(const a of items){const key=clean(a?.type||'Other')||'Other';byType[key]=(byType[key]||0)+1;}\n  return{count:items.length,nextCursor:page.nextCursor||null,inUse:items.filter(a=>['In Use','Assigned','Active'].includes(a?.status)).length,available:items.filter(a=>a?.status==='Available').length,repair:items.filter(a=>['Repair','In Repair'].includes(a?.status)).length,byType};\n});\n`;
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
const newLoad = "    try{let cursor=null,assetRows=[],guard=0,lastError=null;const searching=Boolean(String(query||'').trim()||status||type||location);const invocationLimit=searching?25:10;do{try{const page=await invoke('listAssetsPage',{query,status,type,location,cursor,limit:100,maxScanPages:searching?10:1});assetRows.push(...(page?.items||[]));cursor=page?.nextCursor||null;guard+=1;}catch(e){lastError=e;break;}}while(cursor&&guard<invocationLimit&&assetRows.length<1000);assetRows.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),undefined,{sensitivity:'base'}));setAssets(assetRows);if(lastError&&assetRows.length)setMessage((m)=>m||'Showing loaded assets; the full register could not be scanned.');else if(lastError)setMessage((m)=>m||lastError?.message||'Could not load assets. Configuration is still available.');else if(cursor&&!searching)setMessage((m)=>m||'Showing the first 1,000 records. Search and standard filters scan beyond this working view.');else if(cursor&&searching)setMessage((m)=>m||'Showing the first 1,000 matches from the full-register search. Narrow the search for a smaller result set.');}catch(e){setAssets((current)=>current?.length?current:[]);setMessage((m)=>m||e?.message||'Could not load assets. Configuration is still available.');}";
if (!uiPrep.includes(newLoad)) {
  if (!uiPrep.includes(oldLoad)) throw new Error('Could not locate Asset Manager asset load step.');
  uiPrep = uiPrep.replace(oldLoad, newLoad);
  fs.writeFileSync(uiPrepPath, uiPrep);
}

console.log('Prepared bounded cursor pagination for large asset registers.');
