import Resolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';

const resolver = new Resolver();
const ASSET_PREFIX = 'asset:';
const SETTINGS_KEY = 'settings:asset-manager';
const REPORT_ASSET_LIMIT = 500;
const REPORT_ISSUE_LIMIT = 500;
const clean = (v) => typeof v === 'string' ? v.trim() : v;
const normalise = (v) => String(clean(v) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
const safeArray = (v) => Array.isArray(v) ? v : [];

async function reportAssets() {
  const values = [];
  let cursor;
  let truncated = false;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(ASSET_PREFIX)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany();
    values.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
    if (values.length >= REPORT_ASSET_LIMIT && cursor) { truncated = true; break; }
  } while (cursor);
  return { assets: values.slice(0, REPORT_ASSET_LIMIT), truncated };
}

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

async function jiraFields() {
  const r = await api.asUser().requestJira(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } });
  if (!r.ok) return [];
  return safeArray(await r.json());
}

function organizationField(fields) {
  return fields.find((f) => normalise(f.name) === 'organizations' || normalise(f.name) === 'organisation' || normalise(f.name) === 'organization') || null;
}

async function issueData(settings) {
  const assetField = settings.jiraAssetField?.id;
  if (!assetField) return { issues: [], organizationField: null, truncated: false };
  const fields = await jiraFields();
  const orgField = organizationField(fields);
  const numeric = String(assetField).replace('customfield_', '');
  const wanted = [assetField, orgField?.id, 'summary', 'status', 'created', 'resolutiondate'].filter(Boolean);
  const issues = [];
  let nextPageToken;
  let truncated = false;
  do {
    const body = { jql: `cf[${numeric}] is not EMPTY ORDER BY created DESC`, fields: wanted, maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const r = await api.asUser().requestJira(route`/rest/api/3/search/jql`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) break;
    const data = await r.json();
    issues.push(...safeArray(data.issues));
    nextPageToken = data.nextPageToken || null;
    if (issues.length >= REPORT_ISSUE_LIMIT && nextPageToken) { truncated = true; break; }
  } while (nextPageToken);
  return { issues: issues.slice(0, REPORT_ISSUE_LIMIT), organizationField: orgField, truncated };
}

function groupCount(items, getter, fallback = 'Unspecified') {
  const map = new Map();
  for (const item of items) {
    const key = clean(getter(item)) || fallback;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
}

resolver.define('getReportingData', async () => {
  const { assets, truncated: assetsTruncated } = await reportAssets();
  const settings = { ...((await kvs.get(SETTINGS_KEY)) || {}) };
  const { issues, organizationField: orgField, truncated: issuesTruncated } = await issueData(settings);
  const byIdentifier = new Map();
  for (const asset of assets) byIdentifier.set(normalise(asset.jiraIdentifier || asset.name), asset);

  const faults = new Map();
  const orgsByAsset = new Map();
  for (const issue of issues) {
    const identifiers = fieldValues(issue.fields?.[settings.jiraAssetField?.id]);
    const orgs = orgField ? fieldValues(issue.fields?.[orgField.id]) : [];
    for (const identifier of identifiers) {
      const asset = byIdentifier.get(normalise(identifier));
      if (!asset) continue;
      const current = faults.get(asset.id) || { total: 0, open: 0, resolved: 0, lastFault: '', latestKey: '' };
      current.total += 1;
      const resolved = Boolean(issue.fields?.resolutiondate) || issue.fields?.status?.statusCategory?.key === 'done';
      if (resolved) current.resolved += 1; else current.open += 1;
      const created = issue.fields?.created || '';
      if (!current.lastFault || created > current.lastFault) { current.lastFault = created; current.latestKey = issue.key; }
      faults.set(asset.id, current);
      if (orgs.length) {
        const set = orgsByAsset.get(asset.id) || new Set();
        orgs.forEach((o) => set.add(o));
        orgsByAsset.set(asset.id, set);
      }
    }
  }

  const today = new Date();
  const in90 = new Date(today.getTime() + 90 * 86400000);
  const rows = assets.map((a) => {
    const f = faults.get(a.id) || { total: 0, open: 0, resolved: 0, lastFault: '', latestKey: '' };
    const organisations = [...(orgsByAsset.get(a.id) || new Set())];
    const expiry = a.warrantyExpiry ? new Date(a.warrantyExpiry) : null;
    const warrantyState = !expiry || Number.isNaN(expiry.getTime()) ? 'Unknown' : expiry < today ? 'Expired' : expiry <= in90 ? 'Expiring soon' : 'In warranty';
    const missing = [];
    if (!clean(a.serialNumber)) missing.push('Serial number');
    if (!clean(a.type) || normalise(a.type) === 'other') missing.push('Device type');
    if (!clean(a.location)) missing.push('Location');
    if (!clean(a.assigneeName) && !clean(a.crewCode)) missing.push('Holder');
    if (!organisations.length) missing.push('Organisation');
    return {
      id: a.id, name: a.name, deviceId: a.jiraIdentifier || '', type: a.type || 'Other', manufacturer: a.manufacturer || '', model: a.model || '', serialNumber: a.serialNumber || '',
      holder: a.assigneeName || a.crewCode || '', assignmentReference: a.crewCode || '', status: a.status || '', location: a.location || '', purchaseDate: a.purchaseDate || '', warrantyExpiry: a.warrantyExpiry || '', warrantyState,
      organisations, faults: f.total, openFaults: f.open, resolvedFaults: f.resolved, lastFault: f.lastFault, latestFaultKey: f.latestKey, missing, qualityIssues: missing.length
    };
  });

  const unassigned = rows.filter((r) => !r.holder).length;
  const inRepair = rows.filter((r) => /repair/i.test(r.status)).length;
  const expired = rows.filter((r) => r.warrantyState === 'Expired').length;
  const expiringSoon = rows.filter((r) => r.warrantyState === 'Expiring soon').length;
  const openFaults = rows.reduce((s, r) => s + r.openFaults, 0);
  const orgCounts = new Map();
  for (const row of rows) for (const org of row.organisations) orgCounts.set(org, (orgCounts.get(org) || 0) + 1);

  return {
    generatedAt: new Date().toISOString(),
    partial: assetsTruncated || issuesTruncated,
    limits: { assets: REPORT_ASSET_LIMIT, issues: REPORT_ISSUE_LIMIT, assetsTruncated, issuesTruncated },
    summary: { totalAssets: rows.length, inRepair, unassigned, openFaults, expiredWarranty: expired, expiringWarranty: expiringSoon, qualityIssues: rows.filter((r) => r.qualityIssues > 0).length },
    byType: groupCount(rows, (r) => r.type),
    byStatus: groupCount(rows, (r) => r.status),
    byLocation: groupCount(rows, (r) => r.location),
    byHolder: groupCount(rows, (r) => r.holder, 'Unassigned'),
    byOrganisation: [...orgCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    rows
  };
});

export const handler = resolver.getDefinitions();
