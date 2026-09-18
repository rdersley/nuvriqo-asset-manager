import api,{route} from '@forge/api';
import {buildPortalPlusProjectSnapshot,PORTAL_PLUS_ASSET_PROPERTY_KEY} from './portal-plus-provider.js';

export async function publishPortalPlusProjectSnapshot({projectId='',organisations=[],assets=[],portalUrl='',updatedAt=new Date().toISOString()}={}){
  const id=String(projectId||'').trim();
  if(!id)throw new Error('Project id is required to publish the Portal+ asset snapshot.');
  const snapshot=buildPortalPlusProjectSnapshot({projectId:id,organisations,assets,portalUrl,updatedAt});
  const response=await api.asApp().requestJira(route`/rest/api/3/project/${id}/properties/${PORTAL_PLUS_ASSET_PROPERTY_KEY}`,{
    method:'PUT',
    headers:{Accept:'application/json','Content-Type':'application/json'},
    body:JSON.stringify(snapshot)
  });
  if(!response.ok){
    const text=await response.text();
    throw new Error(`Unable to publish Portal+ asset snapshot (${response.status}): ${text}`);
  }
  return{ok:true,projectId:id,propertyKey:PORTAL_PLUS_ASSET_PROPERTY_KEY,organisationCount:snapshot.organisations.length,assetCount:snapshot.organisations.reduce((sum,org)=>sum+org.assets.length,0),updatedAt:snapshot.updatedAt};
}

const values=(value)=>value==null?[]:Array.isArray(value)?value.flatMap(values):[value];
const clean=(value)=>String(value??'').trim();
const normal=(value)=>clean(value).toLocaleLowerCase('en').replace(/\s+/g,' ');

/**
 * Rebuild project-scoped Portal+ snapshots from authoritative Jira issue mappings.
 * The caller supplies already-visible Jira issues and Asset Manager assets, so this
 * helper never performs customer-context reads and never broadens Portal+ visibility.
 */
export async function publishPortalPlusSnapshotsForMappings({issues=[],assets=[],deviceFieldId='',organisationFieldId='',portalUrl=''}={}){
  if(!deviceFieldId||!organisationFieldId)return{ok:true,published:0,skipped:true,reason:'mapping-not-configured'};
  const byIdentifier=new Map();
  for(const asset of Array.isArray(assets)?assets:[]){
    const identifier=normal(asset?.jiraIdentifier||asset?.name);
    if(identifier&&!byIdentifier.has(identifier))byIdentifier.set(identifier,asset);
  }
  const projects=new Map();
  for(const issue of Array.isArray(issues)?issues:[]){
    const projectId=clean(issue?.fields?.project?.id);
    if(!projectId)continue;
    if(!projects.has(projectId))projects.set(projectId,{organisations:new Map(),assets:new Map()});
    const bucket=projects.get(projectId);
    const orgs=values(issue?.fields?.[organisationFieldId]).map((org)=>({
      id:clean(org?.id||org?.value?.id),
      name:clean(org?.name||org?.value?.name||org?.value)
    })).filter((org)=>org.id&&org.name);
    for(const org of orgs)bucket.organisations.set(org.id,org);
    for(const raw of values(issue?.fields?.[deviceFieldId])){
      const identifier=normal(typeof raw==='object'?(raw?.value??raw?.name??raw?.label??raw?.key):raw);
      const asset=byIdentifier.get(identifier);
      if(!asset)continue;
      const key=clean(asset.id);
      const current=bucket.assets.get(key)||{
        id:key,deviceId:clean(asset.jiraIdentifier||asset.name),name:clean(asset.name),
        type:clean(asset.type),manufacturer:clean(asset.manufacturer),model:clean(asset.model),
        holder:clean(asset.assigneeName||asset.crewCode),status:clean(asset.status),location:clean(asset.location),
        organisationNames:[]
      };
      current.organisationNames=[...new Set([...current.organisationNames,...orgs.map((org)=>org.name)])];
      bucket.assets.set(key,current);
    }
  }
  const results=[];
  for(const [projectId,bucket] of projects){
    try{
      results.push(await publishPortalPlusProjectSnapshot({
        projectId,
        organisations:[...bucket.organisations.values()],
        assets:[...bucket.assets.values()],
        portalUrl
      }));
    }catch(error){
      console.warn('Unable to publish Portal+ asset snapshot',projectId,error?.message||error);
      results.push({ok:false,projectId,error:clean(error?.message||error)});
    }
  }
  return{ok:results.every((result)=>result.ok),published:results.filter((result)=>result.ok).length,projects:results};
}
