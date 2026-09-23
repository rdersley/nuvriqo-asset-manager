import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { buildPortalPlusAssetModule } from './portal-plus-provider.js';

const resolver = new Resolver();
const SETTINGS_KEY = 'settings:asset-manager';
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const safeArray = (value) => Array.isArray(value) ? value : [];
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const validIdentifier = (value) => {
  const v = normalise(value);
  return Boolean(v && !['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v));
};
const nameIndexKey = (name) => `${ASSET_NAME_PREFIX}${Buffer.from(normalise(name), 'utf8').toString('base64url')}`;
const jiraAssetId = (fieldId, identifier) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${normalise(identifier)}`).digest('hex').slice(0, 24).toUpperCase()}`;

function fieldValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate ? [String(candidate).trim()] : [];
  }
  return [];
}

async function getSettings() {
  return (await kvs.get(SETTINGS_KEY)) || {};
}

async function getFields() {
  const response = await api.asApp().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Could not load Jira fields (${response.status}).`);
  return response.json();
}

function findOrganizationsField(fields) {
  return safeArray(fields).find((field) => {
    const name = normalise(field?.name);
    const custom = normalise(field?.schema?.custom);
    return name === 'organizations' || name === 'organisations' || custom.includes('organization');
  }) || null;
}

async function currentCustomerOrganizations(context) {
  const accountId = String(context?.accountId || '');
  if (!accountId) return [];
  const params = new URLSearchParams();
  params.set('limit', '100');
  params.set('accountId', accountId);
  const response = await api.asApp().requestJira(route`/rest/servicedeskapi/organization?${params}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return [];
    throw new Error(`Could not load your Jira Service Management organisations (${response.status}).`);
  }
  const data = await response.json();
  return safeArray(data.values).map((org) => ({ id: String(org.id || ''), name: clean(org.name || '') })).filter((org) => org.id && org.name);
}

function escapeJql(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function identifiersForOrganisation(deviceFieldId, organisationName) {
  const numericId = String(deviceFieldId).replace('customfield_', '');
  const jql = `cf[${numericId}] is not EMPTY AND organizations = "${escapeJql(organisationName)}" ORDER BY created DESC`;
  const identifiers = new Map();
  let nextPageToken;
  for (let guard = 0; guard < 100; guard += 1) {
    const body = { jql, fields: [deviceFieldId], maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Could not load organisation devices (${response.status}).`);
    const data = await response.json();
    for (const issue of safeArray(data.issues)) {
      for (const identifier of fieldValues(issue.fields?.[deviceFieldId])) {
        if (!validIdentifier(identifier)) continue;
        const key = normalise(identifier);
        if (!identifiers.has(key)) identifiers.set(key, identifier);
      }
    }
    nextPageToken = data.nextPageToken || null;
    if (!nextPageToken) break;
  }
  return [...identifiers.values()];
}

async function assetForIdentifier(deviceFieldId, identifier) {
  const deterministic = await kvs.get(`${ASSET_PREFIX}${jiraAssetId(deviceFieldId, identifier)}`);
  if (deterministic) return deterministic;
  const indexed = await kvs.get(nameIndexKey(identifier));
  if (indexed?.assetId) return kvs.get(`${ASSET_PREFIX}${indexed.assetId}`);
  return null;
}

async function portalAssetsForContext(context) {
  const settings = await getSettings();
  if (!settings.jiraAssetField?.id) return { organisations: [], assets: [], configured: false, reason: 'Asset Manager has not been mapped to a Jira Device ID field yet.' };

  const organisations = await currentCustomerOrganizations(context);
  if (!organisations.length) return { organisations: [], assets: [], configured: true, reason: 'Your portal account is not a member of a Jira Service Management organisation.' };

  const fields = await getFields();
  const organisationField = findOrganizationsField(fields);
  if (!organisationField) return { organisations, assets: [], configured: true, reason: 'The Jira Service Management Organizations field could not be found.' };

  const visible = new Map();
  for (const organisation of organisations) {
    const identifiers = await identifiersForOrganisation(settings.jiraAssetField.id, organisation.name);
    for (const identifier of identifiers) {
      const asset = await assetForIdentifier(settings.jiraAssetField.id, identifier);
      if (!asset) continue;
      const existing = visible.get(asset.id);
      const organisationNames = new Set([...(existing?.organisationNames || []), organisation.name]);
      visible.set(asset.id, {
        id: asset.id,
        deviceId: asset.jiraIdentifier || asset.name || identifier,
        name: asset.name || identifier,
        type: asset.type || '',
        manufacturer: asset.manufacturer || '',
        model: asset.model || '',
        serialNumber: asset.serialNumber || '',
        holder: asset.assigneeName || asset.crewCode || '',
        status: asset.status || '',
        location: asset.location || '',
        organisationNames: [...organisationNames]
      });
    }
  }

  const assets = [...visible.values()].sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId), undefined, { sensitivity: 'base' }));
  return { organisations, assets, configured: true, organisationField: { id: organisationField.id, name: organisationField.name } };
}

resolver.define('getPortalAssets', async ({ context }) => portalAssetsForContext(context));
resolver.define('getPortalPlusModule', async ({ context }) => {
  const result = await portalAssetsForContext(context);
  return buildPortalPlusAssetModule(result);
});

export const handler = resolver.getDefinitions();
