import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const marker = "resolver.define('deleteAsset',async({payload})=>{if(!payload?.id)throw new Error('Asset id is required.');";
if (!src.includes(marker)) throw new Error('Could not locate deleteAsset resolver.');

if (!src.includes("resolver.define('bulkRemoveAssets'")) {
  const insertAt = src.indexOf("resolver.define('getAssetHistory'", src.indexOf(marker));
  if (insertAt < 0) throw new Error('Could not locate bulk cleanup insertion point.');
  const block = [
    "resolver.define('bulkRemoveAssets',async({payload})=>{",
    "  const ids=[...new Set(safeArray(payload?.ids).map(clean).filter(Boolean))];",
    "  const discoveredOnly=payload?.discoveredOnly===true;",
    "  const removeAllDiscovered=payload?.removeAllDiscovered===true;",
    "  let targets=[];",
    "  if(removeAllDiscovered){",
    "    const all=await queryAllByPrefix(ASSET_PREFIX);",
    "    targets=all.filter(a=>String(a?.notes||'').startsWith('Discovered automatically from Jira field'));",
    "  }else{",
    "    for(const id of ids){const asset=await kvs.get(`${ASSET_PREFIX}${id}`);if(asset)targets.push(asset);}",
    "  }",
    "  if(discoveredOnly)targets=targets.filter(a=>String(a?.notes||'').startsWith('Discovered automatically from Jira field'));",
    "  let removed=0;",
    "  for(const asset of targets){",
    "    await kvs.delete(`${ASSET_PREFIX}${asset.id}`);",
    "    if(asset.name){const indexed=await kvs.get(nameIndexKey(asset.name));if(indexed?.assetId===asset.id)await kvs.delete(nameIndexKey(asset.name));}",
    "    removed+=1;",
    "  }",
    "  if(removeAllDiscovered){const cfg=await getSettingsValue();await kvs.set(SETTINGS_KEY,{...cfg,jiraDiscoveryEnabled:false});}",
    "  await kvs.delete(SYNC_KEY);",
    "  await kvs.delete(SYNC_PROGRESS_KEY);",
    "  return{ok:true,removed,jiraDiscoveryPaused:removeAllDiscovered};",
    "});",
    ""
  ].join('\n');
  src = src.slice(0, insertAt) + block + src.slice(insertAt);
}

fs.writeFileSync(path, src);
