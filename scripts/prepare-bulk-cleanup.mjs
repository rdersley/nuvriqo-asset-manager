import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const marker = "resolver.define('deleteAsset',async({payload})=>{if(!payload?.id)throw new Error('Asset id is required.');";
if (!src.includes(marker)) throw new Error('Could not locate deleteAsset resolver.');

if (!src.includes("resolver.define('bulkRemoveAssets'")) {
  const insertAt = src.indexOf("resolver.define('getAssetHistory'", src.indexOf(marker));
  if (insertAt < 0) throw new Error('Could not locate bulk cleanup insertion point.');
  const block = `resolver.define('bulkRemoveAssets',async({payload})=>{\n  const ids=[...new Set(safeArray(payload?.ids).map(clean).filter(Boolean))];\n  const discoveredOnly=payload?.discoveredOnly===true;\n  const removeAllDiscovered=payload?.removeAllDiscovered===true;\n  let targets=[];\n  if(removeAllDiscovered){\n    const all=await queryAllByPrefix(ASSET_PREFIX);\n    targets=all.filter(a=>String(a?.notes||'').startsWith('Discovered automatically from Jira field'));\n  }else{\n    for(const id of ids){const asset=await kvs.get(\`${ASSET_PREFIX}\${id}\`);if(asset)targets.push(asset);}\n  }\n  if(discoveredOnly)targets=targets.filter(a=>String(a?.notes||'').startsWith('Discovered automatically from Jira field'));\n  let removed=0;\n  for(const asset of targets){\n    await kvs.delete(\`${ASSET_PREFIX}\${asset.id}\`);\n    if(asset.name){const indexed=await kvs.get(nameIndexKey(asset.name));if(indexed?.assetId===asset.id)await kvs.delete(nameIndexKey(asset.name));}\n    removed+=1;\n  }\n  await kvs.delete(SYNC_KEY);\n  await kvs.delete(SYNC_PROGRESS_KEY);\n  return{ok:true,removed};\n});\n`;
  src = src.slice(0, insertAt) + block + src.slice(insertAt);
}

fs.writeFileSync(path, src);
