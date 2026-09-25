import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { buildPortalPlusProjectSnapshot, PORTAL_PLUS_ASSET_PROPERTY_KEY } from './portal-plus-provider.js';

// Publishes the organisation-scoped asset snapshot that Nuvriqo Portal+ reads from the
// configured service desk project's `nuvriqo.asset-manager.portal` property. Portal+
// filters it to the signed-in customer's organisations. Everything here runs as the app
// so it also works from the scheduled trigger.

const SETTINGS_KEY = 'settings:asset-manager';
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
export const PORTAL_PLUS_STATUS_KEY = 'portal-plus:last-publish';
// Jira entity properties are capped at 32 KB; leave headroom for encoding.
const MAX_SNAPSHOT_BYTES = 30000;
// Portal+ renders at most 50 assets per customer.
const MAX_ASSETS_PER_ORGANISATION = 50;
const ISSUE_PAGE_SIZE = 100;
const MAX_ISSUE_PAGES = 20;
const TIME_BUDGET_MS = 15000;

const clean = (value) => String(value ?? '').trim();
const normalise = (value) => clean(value).toLocaleLowerCase('en').replace(/\s+/g, ' ');
// Keys must match src/index.js (nameIndexKey, makeJiraAssetId).
const nameIndexKey = (name) => `${ASSET_NAME_PREFIX}${Buffer.from(normalise(name), 'utf8').toString('base64url')}`;
const jiraAssetId = (fieldId, identifier) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${normalise(identifier)}`).digest('hex').slice(0, 24).toUpperCase()}`;
const asList = (value) => (value == null ? [] : Array.isArray(value) ? value.flatMap(asList) : [value]);
const fieldValues = (value) => asList(value).map((v) => clean(typeof v === 'object' ? v?.value ?? v?.name ?? v?.label ?? v?.key : v)).filter(Boolean);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

async function jira(path, options = {}) {
  const response = await api.asApp().requestJira(path, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Jira request failed (${response.status}): ${text.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json();
}

// Largest per-organisation cap (<= 50) whose snapshot fits the property size limit.
export function fitSnapshot(snapshot) {
  for (let cap = MAX_ASSETS_PER_ORGANISATION; cap >= 0; cap = cap > 10 ? cap - 10 : cap - 1) {
    const candidate = { ...snapshot, organisations: snapshot.organisations.map((org) => ({ ...org, assets: org.assets.slice(0, cap) })) };
    const trimmed = snapshot.organisations.some((org) => org.assets.length > cap);
    if (bytes(candidate) <= MAX_SNAPSHOT_BYTES) return { snapshot: candidate, trimmed };
  }
  throw new Error('Too many organisations to fit a Portal+ snapshot in one Jira project property.');
}

export async function publishPortalPlusProjectSnapshot({ projectId = '', organisations = [], assets = [], portalUrl = '', updatedAt = new Date().toISOString() } = {}) {
  const id = clean(projectId);
  if (!id) throw new Error('Project id is required to publish the Portal+ asset snapshot.');
  const { snapshot, trimmed } = fitSnapshot(buildPortalPlusProjectSnapshot({ projectId: id, organisations, assets, portalUrl, updatedAt }));
  const response = await api.asApp().requestJira(route`/rest/api/3/project/${id}/properties/${PORTAL_PLUS_ASSET_PROPERTY_KEY}`, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Unable to publish Portal+ asset snapshot (${response.status}): ${text.slice(0, 200)}`);
  }
  return { projectId: id, organisationCount: snapshot.organisations.length, assetCount: snapshot.organisations.reduce((sum, org) => sum + org.assets.length, 0), trimmed, bytes: bytes(snapshot) };
}

async function resolveAssets(deviceFieldId, identifiers) {
  const found = new Map();
  const list = [...identifiers];
  for (let i = 0; i < list.length; i += 50) {
    await Promise.all(list.slice(i, i + 50).map(async (identifier) => {
      let asset = await kvs.get(`${ASSET_PREFIX}${jiraAssetId(deviceFieldId, identifier)}`);
      if (!asset) { const indexed = await kvs.get(nameIndexKey(identifier)); if (indexed?.assetId) asset = await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`); }
      if (asset) found.set(identifier, asset);
    }));
  }
  return found;
}

// Rebuild and publish the snapshot for the configured project. Reads the most recently
// updated tickets that carry both a device and an organisation (bounded by page count
// and time), so the snapshot favours current relationships. Never throws.
export async function refreshPortalPlusSnapshot() {
  const startedAt = Date.now();
  const status = { at: new Date().toISOString(), ok: false };
  try {
    const settings = (await kvs.get(SETTINGS_KEY)) || {};
    const deviceFieldId = clean(settings.jiraAssetField?.id);
    const projectKey = clean(settings.jiraProjectKey).replace(/[^A-Za-z0-9_-]/g, '');
    if (!deviceFieldId || !projectKey) return { ok: true, skipped: true, reason: 'Map the Jira Device ID field and project first.' };

    const project = await jira(route`/rest/api/3/project/${projectKey}`);
    const fields = await jira(route`/rest/api/3/field`);
    const orgField = (Array.isArray(fields) ? fields : []).find((f) => ['organizations', 'organisations'].includes(normalise(f?.name)) || normalise(f?.schema?.custom).includes('sd-customer-organizations'));
    if (!orgField) return { ok: true, skipped: true, reason: 'The Jira Service Management Organizations field was not found.' };

    const numeric = (id) => String(id).replace('customfield_', '');
    const jql = `project = "${projectKey}" AND cf[${numeric(deviceFieldId)}] is not EMPTY AND cf[${numeric(orgField.id)}] is not EMPTY ORDER BY updated DESC`;
    const organisations = new Map();
    const devicesByOrg = new Map();
    let nextPageToken = null;
    let pages = 0;
    do {
      const data = await jira(route`/rest/api/3/search/jql`, { method: 'POST', body: JSON.stringify({ jql, fields: [deviceFieldId, orgField.id], maxResults: ISSUE_PAGE_SIZE, ...(nextPageToken ? { nextPageToken } : {}) }) });
      for (const issue of Array.isArray(data?.issues) ? data.issues : []) {
        const orgs = asList(issue.fields?.[orgField.id]).map((o) => ({ id: clean(o?.id), name: clean(o?.name) })).filter((o) => o.id && o.name);
        const devices = fieldValues(issue.fields?.[deviceFieldId]);
        for (const org of orgs) {
          organisations.set(org.id, org);
          if (!devicesByOrg.has(org.id)) devicesByOrg.set(org.id, new Set());
          for (const device of devices) devicesByOrg.get(org.id).add(device);
        }
      }
      nextPageToken = data?.nextPageToken || null;
      pages += 1;
    } while (nextPageToken && pages < MAX_ISSUE_PAGES && Date.now() - startedAt < TIME_BUDGET_MS);

    const allIdentifiers = new Set([...devicesByOrg.values()].flatMap((set) => [...set]));
    const resolved = await resolveAssets(deviceFieldId, allIdentifiers);
    const assets = new Map();
    for (const [orgId, identifiers] of devicesByOrg) {
      const orgName = organisations.get(orgId).name;
      for (const identifier of identifiers) {
        const asset = resolved.get(identifier);
        if (!asset) continue;
        const current = assets.get(asset.id) || { id: asset.id, deviceId: asset.jiraIdentifier || asset.name, name: asset.name, type: asset.type, manufacturer: asset.manufacturer, model: asset.model, holder: asset.assigneeName || asset.crewCode, status: asset.status, location: asset.location, organisationNames: [] };
        if (!current.organisationNames.includes(orgName)) current.organisationNames.push(orgName);
        assets.set(asset.id, current);
      }
    }

    const published = await publishPortalPlusProjectSnapshot({ projectId: project?.id, organisations: [...organisations.values()], assets: [...assets.values()] });
    Object.assign(status, { ok: true, projectKey, ...published, partial: Boolean(nextPageToken), ticketPages: pages });
    return status;
  } catch (error) {
    status.error = clean(error?.message || error);
    console.warn('Portal+ asset snapshot refresh failed', status.error);
    return status;
  } finally {
    if (status.ok || status.error) await kvs.set(PORTAL_PLUS_STATUS_KEY, status).catch(() => {});
  }
}
