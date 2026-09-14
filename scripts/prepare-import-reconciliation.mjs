import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

if (!src.includes("resolver.define('previewAssetImportReconciliation'")) {
  const insertAt = src.indexOf("resolver.define('getAssetHistory'");
  if (insertAt < 0) throw new Error('Could not locate reconciliation insertion point.');

  const block = String.raw`
function reconciliationValue(value){
  const raw=String(clean(value)||'').trim();
  const normal=normaliseName(raw);
  if(!normal||['.','-','n/a','na','none','null','unknown'].includes(normal))return'';
  if(/^[?._\-\s]+$/.test(raw)||/^0+$/.test(raw))return'';
  return raw;
}
function isJiraDiscoveredAsset(asset){return String(asset?.notes||'').startsWith('Discovered automatically from Jira field');}
async function reconciliationCandidateByName(name){
  const value=reconciliationValue(name);if(!value)return null;
  const indexed=await kvs.get(nameIndexKey(value));
  return indexed?.assetId?await kvs.get(ASSET_PREFIX+indexed.assetId):null;
}
async function reconciliationCandidateByIdentifier(fieldId,value){
  const match=reconciliationValue(value);if(!fieldId||!match)return null;
  return await findAssetForJiraIdentifier(fieldId,match);
}
async function classifyImportRow(row,settings){
  const fieldId=settings.jiraAssetField?.id||'';
  const byName=await reconciliationCandidateByName(row?.name);
  const byDevice=await reconciliationCandidateByIdentifier(fieldId,row?.jiraIdentifier);
  const bySerial=await reconciliationCandidateByIdentifier(fieldId,row?.serialNumber);
  const candidates=[byDevice,bySerial,byName].filter(Boolean);
  const unique=[...new Map(candidates.map(asset=>[asset.id,asset])).values()];
  if(unique.length>1){return{action:'review',message:'Multiple existing assets match this row. Review before importing.',candidateIds:unique.map(a=>a.id),existing:unique.map(a=>({id:a.id,name:a.name,jiraIdentifier:a.jiraIdentifier,serialNumber:a.serialNumber}))};}
  const existing=unique[0]||null;
  if(!existing)return{action:'create',message:'Create new asset.',existing:null};
  if(bySerial?.id===existing.id&&normaliseName(row?.serialNumber)!==normaliseName(row?.jiraIdentifier||''))return{action:'merge-serial',message:'Merge Jira-discovered record “'+existing.name+'” using matching serial number.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  if(byDevice?.id===existing.id)return{action:'update-device-id',message:'Update existing asset “'+existing.name+'” by Device ID.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
  return{action:'update-name',message:'Update existing asset “'+existing.name+'” by device name.',existing:{id:existing.id,name:existing.name,jiraIdentifier:existing.jiraIdentifier,serialNumber:existing.serialNumber},autoDiscovered:isJiraDiscoveredAsset(existing)};
}
resolver.define('previewAssetImportReconciliation',async({payload})=>{
  const rows=safeArray(payload?.assets).slice(0,500);
  const settings=await getSettingsValue();
  const results=[];
  for(let i=0;i<rows.length;i+=1){const match=await classifyImportRow(rows[i],settings);results.push({index:i,...match});}
  return results;
});
resolver.define('reconcileAssetImport',async({payload})=>{
  const rows=safeArray(payload?.assets).slice(0,100);
  const settings=await getSettingsValue();
  let created=0,updated=0,merged=0;const failed=[];
  for(let i=0;i<rows.length;i+=1){
    const row=rows[i]||{};
    try{
      if(!clean(row.name))throw new Error('Device Name is required.');
      const match=await classifyImportRow(row,settings);
      if(match.action==='review')throw new Error(match.message);
      let existing=match.existing?.id?await kvs.get(ASSET_PREFIX+match.existing.id):null;
      if(!existing){await saveOneAsset(row,'import');created+=1;continue;}
      const oldName=existing.name||'';const oldIdentifier=existing.jiraIdentifier||existing.name||'';
      const aliases=[...new Set([...safeArray(existing.jiraAliases),oldIdentifier].map(reconciliationValue).filter(Boolean).filter(v=>normaliseName(v)!==normaliseName(row.jiraIdentifier||row.name||'')))];
      const saved=await saveOneAsset({...row,id:existing.id},'import-reconcile');
      const reconciled={...saved,jiraAliases:aliases,notes:clean(row.notes)||saved.notes||''};
      await kvs.set(ASSET_PREFIX+saved.id,reconciled);
      if(match.action==='merge-serial'){
        merged+=1;
        await addHistory(saved.id,{type:'merged',source:'import-reconcile',message:'Merged Jira-discovered record '+(oldIdentifier||oldName)+' into '+saved.name+' during CSV reconciliation',fromDevice:oldName,fromIdentifier:oldIdentifier,matchedBy:'serial-number'});
      }else{
        updated+=1;
        await addHistory(saved.id,{type:'import-update',source:'import-reconcile',message:'Updated '+saved.name+' from CSV import',matchedBy:match.action==='update-device-id'?'device-id':'device-name'});
      }
    }catch(error){failed.push({index:i,name:row?.name||'',error:error?.message||'Import reconciliation failed.'});}
  }
  return{processed:rows.length,created,updated,merged,failed};
});
`;
  src = src.slice(0, insertAt) + block + '\n' + src.slice(insertAt);
}

// Preserve old Jira identifiers as aliases after a CSV merge so historic tickets
// remain attached to the canonical asset even when the imported Device ID changes.
const oldSearch = "async function searchAssetTickets(assetId,legacyKeys=[]){\n  const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);const matched=new Map();const targetIdentifier=asset?.jiraIdentifier||asset?.name||'';\n  if(validIdentifier(targetIdentifier)){\n    const{field,issues,settings}=await searchIssuesWithConfiguredAssetField();\n    if(field){for(const issue of issues){if(issueMatchesIdentifier(issue,field.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'primary'));else if(issueMatchesRelatedIdentifier(issue,settings.jiraRelatedAssetField?.id,targetIdentifier))matched.set(issue.key,ticketFields(issue,'related'));}}\n  }";
const newSearch = "async function searchAssetTickets(assetId,legacyKeys=[]){\n  const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);const matched=new Map();const identifiers=[asset?.jiraIdentifier||asset?.name||'',...safeArray(asset?.jiraAliases)].map(reconciliationValue).filter(Boolean);\n  if(identifiers.length){\n    const{field,issues,settings}=await searchIssuesWithConfiguredAssetField();\n    if(field){for(const issue of issues){const primary=fieldValues(issue.fields?.[field.id]).some(v=>identifiers.some(id=>normaliseName(v)===normaliseName(id)));const related=settings.jiraRelatedAssetField?.id&&relatedIdentifiers(issue.fields?.[settings.jiraRelatedAssetField.id]).some(v=>identifiers.some(id=>normaliseName(v)===normaliseName(id)));if(primary)matched.set(issue.key,ticketFields(issue,'primary'));else if(related)matched.set(issue.key,ticketFields(issue,'related'));}}\n  }";
if(src.includes(oldSearch)) src=src.replace(oldSearch,newSearch);
else if(!src.includes('asset?.jiraAliases')) throw new Error('Could not update ticket-history alias matching.');

const oldReport = "for(const asset of assets){const key=normaliseName(asset.jiraIdentifier||asset.name);const tickets=[...(ticketsByIdentifier.get(key)?.values()||[])].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));";
const newReport = "for(const asset of assets){const identifiers=[asset.jiraIdentifier||asset.name,...safeArray(asset.jiraAliases)].map(reconciliationValue).filter(Boolean);const mergedTickets=new Map();for(const identifier of identifiers){for(const ticket of ticketsByIdentifier.get(normaliseName(identifier))?.values()||[]){const current=mergedTickets.get(ticket.key);if(!current||ticket.relation==='primary')mergedTickets.set(ticket.key,ticket);}}const tickets=[...mergedTickets.values()].sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));";
if(src.includes(oldReport)) src=src.replace(oldReport,newReport);
else if(!src.includes('mergedTickets=new Map()')) throw new Error('Could not update report alias matching.');

fs.writeFileSync(path, src);
console.log('CSV import reconciliation prepared.');
