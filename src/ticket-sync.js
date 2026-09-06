import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const SETTINGS_KEY = 'settings:asset-manager';
const HISTORY_PREFIX = 'asset-history:';
const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const now = () => new Date().toISOString();
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');

async function allAssets() {
  const values = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    values.push(...page.results.map((entry) => entry.value));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function settings() { return (await kvs.get(SETTINGS_KEY)) || {}; }

async function fieldDefinitions() {
  const response = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not load Jira fields (${response.status}).`);
  return response.json();
}

function jiraValue(field, value) {
  if (value === null || value === undefined || value === '') return null;
  const type = field?.schema?.type || '';
  const custom = field?.schema?.custom || '';
  if (type === 'option' || /select/i.test(custom)) return { value: String(value) };
  if (type === 'array') return [{ value: String(value) }];
  if (type === 'number') return Number(value);
  return String(value);
}

async function updateIssue(issueKey, asset, choices = {}) {
  if (!issueKey) return { updated: [], skipped: true, reason: 'This ticket has not been created yet.' };
  const cfg = await settings();
  const defs = await fieldDefinitions();
  const byId = new Map(defs.map((field) => [field.id, field]));
  const fields = {};
  const updated = [];
  if (cfg.jiraAssetField?.id && clean(asset.jiraIdentifier || asset.name)) {
    fields[cfg.jiraAssetField.id] = jiraValue(byId.get(cfg.jiraAssetField.id), asset.jiraIdentifier || asset.name);
    updated.push(cfg.jiraAssetField.name || 'Device ID');
  }
  if (choices.deviceType !== false && cfg.jiraTypeField?.id && clean(asset.type)) {
    fields[cfg.jiraTypeField.id] = jiraValue(byId.get(cfg.jiraTypeField.id), asset.type);
    updated.push(cfg.jiraTypeField.name || 'Device type');
  }
  if (choices.location === true && cfg.jiraLocationField?.id && clean(asset.location)) {
    fields[cfg.jiraLocationField.id] = jiraValue(byId.get(cfg.jiraLocationField.id), asset.location);
    updated.push(cfg.jiraLocationField.name || 'Base / location');
  }
  if (choices.owner === true && cfg.jiraCrewCodeField?.id && clean(asset.crewCode)) {
    fields[cfg.jiraCrewCodeField.id] = jiraValue(byId.get(cfg.jiraCrewCodeField.id), asset.crewCode);
    updated.push(cfg.jiraCrewCodeField.name || 'Assignment reference');
  }
  if (!Object.keys(fields).length) return { updated: [], skipped: true, reason: 'No mapped asset fields were selected.' };
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
  if (!response.ok) { let detail=''; try{detail=JSON.stringify(await response.json());}catch{} throw new Error(`Could not update Jira ticket fields (${response.status}).${detail ? ` ${detail.slice(0,300)}` : ''}`); }
  await kvs.set(`${HISTORY_PREFIX}${asset.id}:${now()}:ticket-sync`, { assetId:asset.id,timestamp:now(),type:'ticket-field-sync',source:'jira',issueKey,message:`${issueKey} updated from Asset Manager`,fields:updated });
  return { updated, skipped:false };
}

resolver.define('searchDevices', async ({ payload }) => {
  const query = normalise(payload?.query || '');
  const assets = await allAssets();
  return assets
    .filter((asset) => {
      if (!query) return true;
      return [asset.name, asset.jiraIdentifier, asset.type, asset.manufacturer, asset.model, asset.location, asset.assigneeName, asset.crewCode, asset.serialNumber]
        .some((value) => normalise(value).includes(query));
    })
    .sort((a,b)=>String(a.name).localeCompare(String(b.name),undefined,{sensitivity:'base'}))
    .slice(0,50)
    .map((asset)=>({ id:asset.id,name:asset.name,identifier:asset.jiraIdentifier||asset.name,type:asset.type||'',manufacturer:asset.manufacturer||'',model:asset.model||'',location:asset.location||'',assignmentReference:asset.crewCode||'',holder:asset.assigneeName||asset.crewCode||'',status:asset.status||'',serialNumber:asset.serialNumber||'' }));
});

resolver.define('applyAssetToIssue', async ({ payload, context }) => {
  const assetId=clean(payload?.assetId||'');
  if(!assetId) throw new Error('Asset is required.');
  const asset=await kvs.get(`${ASSET_PREFIX}${assetId}`);
  if(!asset) throw new Error('Asset not found.');
  const issueKey=clean(payload?.issueKey||context?.extension?.issue?.key||'');
  return updateIssue(issueKey,asset,payload?.choices||{});
});

export const handler = resolver.getDefinitions();
