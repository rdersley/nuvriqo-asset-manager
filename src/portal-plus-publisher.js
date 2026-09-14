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
