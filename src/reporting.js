import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const SETTINGS_KEY = 'settings:asset-manager';

const clean = (value) => (typeof value === 'string' ? value.trim() : value);
const safeArray = (value) => Array.isArray(value) ? value : [];
const normalise = (value) => String(clean(value) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');

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

async function queryAllByPrefix(prefix) {
  const values = [];
  let cursor;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany();
    values.push(...page.results.map((entry) => entry.value));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function getFields() {
  const response = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return [];
  return response.json();
}

function findOrganizationsField(fields) {
  return safeArray(fields).find((field) => {
    const name = normalise(field?.name);
    const custom = normalise(field?.schema?.custom);
    return name === 'organizations' || name === 'organisations' || custom.includes('organization');
  }) || null;
}

async function searchDeviceIssues(deviceFieldId, organisationFieldId) {
  if (!deviceFieldId) return [];
  const numericId = String(deviceFieldId).replace('customfield_', '');
  const jql = `cf[${numericId}] is not EMPTY ORDER BY created DESC`;
  const fields = [deviceFieldId, organisationFieldId, 'summary', 'status', 'priority', 'created', 'resolutiondate'].filter(Boolean);
  const issues = [];
  let nextPageToken;
  for (let guard = 0; guard < 250; guard += 1) {
    const body = { jql, fields, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Could not load Jira fault data (${response.status}).`);
    const data = await response.json();
    issues.push(...safeArray(data.issues));
    nextPageToken = data.nextPageToken || null;
    if (!nextPageToken) break;
  }
  return issues;
}

function countBy(rows, getter, blankLabel = 'Unspecified') {
  const map = new Map();
  for (const row of rows) {
    const value = clean(getter(row)) || blankLabel;
    map.set(value, (map.get(value) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function warrantyState(asset) {
  if (!asset.warrantyExpiry) return 'No warranty date';
  const expiry = new Date(asset.warrantyExpiry);
  if (Number.isNaN(expiry.getTime())) return 'Invalid warranty date';
  const days = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
  if (days < 0) return 'Expired';
  if (days <= 90) return 'Expiring within 90 days';
  return 'Current';
}

function dataQualityFlags(asset) {
  const flags = [];
  if (!clean(asset.serialNumber)) flags.push('Missing serial number');
  if (!clean(asset.type) || normalise(asset.type) === 'other') flags.push('Missing/specific device type');
  if (!clean(asset.location)) flags.push('Missing location');
  if (!clean(asset.assigneeName) && !clean(asset.crewCode)) flags.push('Unassigned');
  if (!clean(asset.jiraIdentifier)) flags.push('No Jira Device ID');
  return flags;
}

resolver.define('getOperationalReports', async () => {
  const [assets, settings, jiraFields] = await Promise.all([
    queryAllByPrefix(ASSET_PREFIX),
    kvs.get(SETTINGS_KEY),
    getFields()
  ]);

  const deviceFieldId = settings?.jiraAssetField?.id || null;
  const organisationField = findOrganizationsField(jiraFields);
  let issues = [];
  let jiraWarning = '';
  try {
    issues = await searchDeviceIssues(deviceFieldId, organisationField?.id);
  } catch (error) {
    jiraWarning = error?.message || 'Jira fault data could not be loaded.';
  }

  const byIdentifier = new Map();
  for (const asset of assets) {
    const key = normalise(asset.jiraIdentifier || asset.name);
    if (key) byIdentifier.set(key, asset.id);
  }

  const ticketStats = new Map();
  const organisationsByAsset = new Map();
  for (const issue of issues) {
    const organisations = organisationField ? fieldValues(issue.fields?.[organisationField.id]) : [];
    for (const identifier of fieldValues(issue.fields?.[deviceFieldId])) {
      const assetId = byIdentifier.get(normalise(identifier));
      if (!assetId) continue;
      if (!ticketStats.has(assetId)) ticketStats.set(assetId, { total: 0, open: 0, resolved: 0, latest: null, latestKey: '' });
      const stat = ticketStats.get(assetId);
      stat.total += 1;
      const isResolved = Boolean(issue.fields?.resolutiondate) || issue.fields?.status?.statusCategory?.key === 'done';
      if (isResolved) stat.resolved += 1; else stat.open += 1;
      const created = issue.fields?.created || '';
      if (!stat.latest || created > stat.latest) { stat.latest = created; stat.latestKey = issue.key; }
      if (!organisationsByAsset.has(assetId)) organisationsByAsset.set(assetId, new Set());
      for (const organisation of organisations) if (clean(organisation)) organisationsByAsset.get(assetId).add(clean(organisation));
    }
  }

  const rows = assets.map((asset) => {
    const ticket = ticketStats.get(asset.id) || { total: 0, open: 0, resolved: 0, latest: null, latestKey: '' };
    const organisations = [...(organisationsByAsset.get(asset.id) || new Set())].sort();
    const qualityFlags = dataQualityFlags(asset);
    return {
      id: asset.id,
      name: asset.name || '',
      deviceId: asset.jiraIdentifier || asset.name || '',
      type: asset.type || '',
      manufacturer: asset.manufacturer || '',
      model: asset.model || '',
      serialNumber: asset.serialNumber || '',
      holder: asset.assigneeName || asset.crewCode || '',
      assignmentReference: asset.crewCode || '',
      status: asset.status || '',
      location: asset.location || '',
      purchaseDate: asset.purchaseDate || '',
      warrantyExpiry: asset.warrantyExpiry || '',
      warrantyState: warrantyState(asset),
      organisations,
      primaryFaults: ticket.total,
      openFaults: ticket.open,
      resolvedFaults: ticket.resolved,
      latestFaultDate: ticket.latest,
      latestFaultKey: ticket.latestKey,
      qualityFlags
    };
  });

  const organisationRows = [];
  const organisationMap = new Map();
  for (const row of rows) {
    for (const org of row.organisations) {
      if (!organisationMap.has(org)) organisationMap.set(org, { name: org, assets: 0, faults: 0, openFaults: 0 });
      const current = organisationMap.get(org);
      current.assets += 1;
      current.faults += row.primaryFaults;
      current.openFaults += row.openFaults;
    }
  }
  organisationRows.push(...[...organisationMap.values()].sort((a, b) => b.assets - a.assets || a.name.localeCompare(b.name)));

  const summary = {
    totalAssets: rows.length,
    inUse: rows.filter((r) => ['in use', 'assigned', 'active'].includes(normalise(r.status))).length,
    available: rows.filter((r) => normalise(r.status) === 'available').length,
    inRepair: rows.filter((r) => ['repair', 'in repair'].includes(normalise(r.status))).length,
    openFaults: rows.reduce((sum, r) => sum + r.openFaults, 0),
    unassigned: rows.filter((r) => !r.holder).length,
    warrantyExpiring: rows.filter((r) => r.warrantyState === 'Expiring within 90 days').length,
    warrantyExpired: rows.filter((r) => r.warrantyState === 'Expired').length,
    dataQualityIssues: rows.filter((r) => r.qualityFlags.length > 0).length
  };

  return {
    generatedAt: new Date().toISOString(),
    summary,
    groups: {
      byType: countBy(rows, (r) => r.type),
      byStatus: countBy(rows, (r) => r.status),
      byLocation: countBy(rows, (r) => r.location),
      byHolder: countBy(rows, (r) => r.holder, 'Unassigned'),
      byWarranty: countBy(rows, (r) => r.warrantyState)
    },
    organisations: organisationRows,
    rows: rows.sort((a, b) => b.primaryFaults - a.primaryFaults || b.openFaults - a.openFaults || a.name.localeCompare(b.name)),
    organisationField: organisationField ? { id: organisationField.id, name: organisationField.name } : null,
    jiraWarning
  };
});

export const handler = resolver.getDefinitions();
