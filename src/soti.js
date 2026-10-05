import api from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { actorFields } from './actor.js';

// SOTI MobiControl (SOTI ONE, SOTI-hosted) read-only sync. Internal edition only: the manifest
// allows egress to *.mobicontrol.cloud and *.mobicontrolcloud.com, and the Marketplace build
// removes this module. Nothing is ever sent to devices.
//
// A sync pages through SOTI's device list, matches each device to the register (earlier link,
// Device ID / name, then serial or IMEI), stores SOTI's details on the device (online, last
// check-in, OS, tracked app versions), fills empty serial / model / manufacturer, and records
// differences and devices found on only one side for review.

const CONFIG_KEY = 'soti:config';
const CREDENTIALS_KEY = 'soti:credentials';   // secret: clientId, clientSecret, username, password
const TOKEN_KEY = 'soti:token';               // secret: accessToken, expiresAt
const PROGRESS_KEY = 'soti:sync-progress';
const LAST_KEY = 'soti:last-sync';
const UNMATCHED_PREFIX = 'soti-unmatched:';   // in SOTI, not in the register
const DIFFERENCE_PREFIX = 'soti-difference:'; // register field differs from SOTI
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const HISTORY_PREFIX = 'asset-history:';
export const SOTI_PAGE_SIZE = 100;
const APP_CONCURRENCY = 8;
const REGISTER_PAGES = 200;
// Register fields SOTI fills when empty; a different non-empty value is a difference to review.
export const SOTI_FIELDS = [
  { field: 'serialNumber', soti: 'serial', label: 'Serial number' },
  { field: 'model', soti: 'model', label: 'Model' },
  { field: 'manufacturer', soti: 'manufacturer', label: 'Manufacturer' },
];

const clean = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const safeArray = (v) => (Array.isArray(v) ? v : []);
const normalise = (v) => clean(v).toLocaleLowerCase('en').replace(/\s+/g, ' ');
const encoded = (v) => Buffer.from(normalise(v), 'utf8').toString('base64url');
const nameIndexKey = (v) => `${ASSET_NAME_PREFIX}${encoded(v)}`;
const now = () => new Date().toISOString();

// SOTI-hosted servers only (the manifest's egress list). Accepts the console address too.
const HOST_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(mobicontrol\.cloud|mobicontrolcloud\.com)$/i;
export function normaliseHost(value) {
  let host = clean(value).replace(/\/+$/, '');
  host = host.replace(/\/mobicontrol(\/.*)?$/i, '');
  if (host && !/^https?:\/\//i.test(host)) host = `https://${host}`;
  return host.toLowerCase();
}
export const validHost = (host) => HOST_RE.test(host);

// Field names differ by platform and version, so each value is read from the first name present.
const pick = (d, keys) => { for (const k of keys) { const v = d?.[k]; if (v !== undefined && v !== null && clean(String(v)) !== '') return { key: k, value: clean(String(v)) }; } return { key: '', value: '' }; };
const FIELD_NAMES = {
  sotiId: ['DeviceId'],
  name: ['DeviceName', 'Name'],
  serial: ['HardwareSerialNumber', 'SerialNumber', 'DeviceSerialNumber', 'Serial'],
  imei: ['IMEI_MEID_ESN', 'IMEI', 'Imei', 'MEID'],
  model: ['Model', 'DeviceModel', 'ModelName'],
  manufacturer: ['Manufacturer', 'DeviceManufacturer', 'OEM'],
  platform: ['Platform', 'Family', 'OSType', 'Kind'],
  osVersion: ['OSVersion', 'OsVersion', 'AndroidVersion', 'OperatingSystemVersion'],
  path: ['Path'],
  lastCheckIn: ['LastCheckInTime', 'LastAgentConnectTime'],
};
export function mapSotiDevice(raw) {
  const out = {};
  for (const [field, names] of Object.entries(FIELD_NAMES)) out[field] = pick(raw, names).value;
  out.online = raw?.IsAgentOnline === true || String(raw?.IsAgentOnline).toLowerCase() === 'true';
  out.os = [out.platform, out.osVersion].filter(Boolean).join(' ');
  return out;
}
// Which SOTI field supplied each value, for the connection test.
export function fieldsFound(raw) {
  return Object.fromEntries(Object.entries(FIELD_NAMES).map(([field, names]) => [field, pick(raw, names).key || null]));
}

// Tracked apps, one per line: "com.example.pos" or "POS app = com.example.pos".
export function parseTrackedApps(lines) {
  return safeArray(lines).map(clean).filter(Boolean).slice(0, 20).map((line) => {
    const at = line.indexOf('=');
    const id = clean(at >= 0 ? line.slice(at + 1) : line);
    return id ? { id, label: clean(at >= 0 ? line.slice(0, at) : '') || id } : null;
  }).filter(Boolean);
}
export function trackedVersions(installed, tracked) {
  const list = safeArray(installed);
  return Object.fromEntries(tracked.map((app) => {
    const hit = list.find((a) => normalise(a?.ApplicationId || a?.PackageName || a?.Identifier) === normalise(app.id));
    return [app.label, hit ? clean(hit.Version || hit.ShortVersion || '') || 'Installed' : 'Not installed'];
  }));
}

// ---- Storage -------------------------------------------------------------------------------

export async function getConfig() { return (await kvs.get(CONFIG_KEY)) || {}; }
async function credentials() { return (await kvs.getSecret(CREDENTIALS_KEY)) || {}; }

async function queryAll(prefix, limitPages = REGISTER_PAGES) {
  const out = []; let cursor; let pages = 0;
  do {
    let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) q = q.cursor(cursor);
    const page = await q.getMany(); pages += 1;
    out.push(...page.results);
    cursor = page.nextCursor;
  } while (cursor && pages < limitPages);
  return { entries: out, partial: Boolean(cursor) };
}

async function addHistory(assetId, event) {
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, source: 'soti', ...actorFields(), ...event });
}

// ---- SOTI API ------------------------------------------------------------------------------

async function accessToken(force = false) {
  if (!force) {
    const cached = await kvs.getSecret(TOKEN_KEY);
    if (cached?.accessToken && Number(cached.expiresAt) > Date.now() + 60000) return cached.accessToken;
  }
  const config = await getConfig();
  const creds = await credentials();
  if (!validHost(config.host || '') || !creds.clientId || !creds.clientSecret) throw new Error('Enter the SOTI server address, client ID and client secret first.');
  // An API user signs in with the password grant; without one, the client signs in on its own.
  const form = new URLSearchParams(creds.username ? { grant_type: 'password', username: creds.username, password: creds.password || '' } : { grant_type: 'client_credentials' });
  const response = await api.fetch(`${config.host}/MobiControl/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  if (!response.ok) throw new Error(`SOTI sign-in failed (${response.status}). Check the client ID, secret, username and password.`);
  const body = await response.json();
  if (!body?.access_token) throw new Error('SOTI sign-in returned no access token.');
  await kvs.setSecret(TOKEN_KEY, { accessToken: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 });
  return body.access_token;
}

async function sotiGet(path) {
  const { host } = await getConfig();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await accessToken(attempt > 0);
    const response = await api.fetch(`${host}/MobiControl/api${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (response.status === 401 && attempt === 0) continue;
    if (!response.ok) throw new Error(`SOTI returned ${response.status} for ${path.split('?')[0]}.`);
    return response.json();
  }
  throw new Error('SOTI sign-in expired and could not be renewed.');
}

// ---- Matching ------------------------------------------------------------------------------

export async function registerLookup() {
  const { entries, partial } = await queryAll(ASSET_PREFIX);
  const bySotiId = new Map(), byIdent = new Map(), bySerial = new Map();
  const set = (map, key, asset) => { const k = normalise(key); if (k && !map.has(k)) map.set(k, asset); };
  for (const { value: asset } of entries) {
    if (!asset?.id) continue;
    set(bySotiId, asset.soti?.deviceId, asset);
    for (const v of [asset.jiraIdentifier, asset.name, ...safeArray(asset.jiraAliases)]) set(byIdent, v, asset);
    set(bySerial, asset.serialNumber, asset);
  }
  return { bySotiId, byIdent, bySerial, partial };
}

export function matchDevice(device, lookup) {
  const get = (map, v) => (normalise(v) ? map.get(normalise(v)) : null);
  return get(lookup.bySotiId, device.sotiId) || get(lookup.byIdent, device.name)
    || get(lookup.bySerial, device.serial) || get(lookup.bySerial, device.imei) || null;
}

// What a sync does to one matched device: fields to fill, and differences to review.
export function planDevice(asset, device) {
  const fill = {}, differences = [];
  for (const f of SOTI_FIELDS) {
    const theirs = clean(device[f.soti]);
    if (!theirs) continue;
    const ours = clean(asset[f.field]);
    if (!ours) fill[f.field] = theirs;
    else if (normalise(ours) !== normalise(theirs)) differences.push({ field: f.field, label: f.label, register: ours, soti: theirs });
  }
  return { fill, differences };
}

// ---- Sync ----------------------------------------------------------------------------------

async function processDevice(raw, lookup, progress, tracked) {
  const device = mapSotiDevice(raw);
  if (!device.sotiId && !device.name) return;
  progress.seen += 1;
  const asset = matchDevice(device, lookup);
  if (!asset) {
    progress.unmatched += 1;
    await kvs.set(`${UNMATCHED_PREFIX}${encoded(device.sotiId || device.name)}`, { ...device, runId: progress.runId, seenAt: now() });
    return;
  }
  progress.matched += 1;
  const current = (await kvs.get(`${ASSET_PREFIX}${asset.id}`)) || asset;
  let apps = current.soti?.apps || {};
  let appsError = '';
  if (tracked.length && device.sotiId) {
    try { apps = trackedVersions(await sotiGet(`/devices/${encodeURIComponent(device.sotiId)}/installedApplications`), tracked); }
    catch (e) { appsError = e?.message || 'Could not read installed apps.'; }
  }
  const { fill, differences } = planDevice(current, device);
  const soti = { deviceId: device.sotiId, name: device.name, serial: device.serial, imei: device.imei, model: device.model, manufacturer: device.manufacturer, os: device.os, path: device.path, online: device.online, lastCheckIn: device.lastCheckIn, apps, appsError, runId: progress.runId, syncedAt: now() };
  await kvs.set(`${ASSET_PREFIX}${current.id}`, { ...current, ...fill, soti });
  if (Object.keys(fill).length) {
    progress.filled += 1;
    await addHistory(current.id, { type: 'updated', message: `Filled from SOTI: ${Object.keys(fill).map((k) => SOTI_FIELDS.find((f) => f.field === k).label.toLowerCase()).join(', ')}`, changes: Object.entries(fill).map(([field, to]) => ({ field, from: '', to })) });
  }
  const key = `${DIFFERENCE_PREFIX}${current.id}`;
  if (!differences.length) { await kvs.delete(key); return; }
  const existing = await kvs.get(key);
  // Kept differences stay quiet until SOTI reports something new.
  const sameAsKept = existing?.status === 'kept' && differences.every((d) => normalise(existing.keptSoti?.[d.field]) === normalise(d.soti));
  if (sameAsKept) return;
  progress.differences += 1;
  await kvs.set(key, { assetId: current.id, deviceName: current.name, sotiName: device.name, differences, status: 'open', runId: progress.runId, detectedAt: now() });
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

// One step of a sync, resumable: pages through SOTI until the time budget is used or the list ends.
export async function syncStep({ restart = false, timeBudgetMs = 18000 } = {}) {
  const started = Date.now();
  const config = await getConfig();
  const tracked = parseTrackedApps(config.trackedApps);
  let progress = restart ? null : await kvs.get(PROGRESS_KEY);
  if (!progress) progress = { runId: `soti-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, skip: 0, startedAt: now(), seen: 0, matched: 0, filled: 0, differences: 0, unmatched: 0 };
  const lookup = await registerLookup();
  let complete = false;
  // At least one page per step, so every call makes progress.
  do {
    const page = safeArray(await sotiGet(`/devices?skip=${progress.skip}&take=${SOTI_PAGE_SIZE}`));
    await inBatches(page, APP_CONCURRENCY, (raw) => processDevice(raw, lookup, progress, tracked));
    progress.skip += page.length;
    await kvs.set(PROGRESS_KEY, progress);
    if (page.length < SOTI_PAGE_SIZE) { complete = true; break; }
  } while (Date.now() - started < timeBudgetMs);
  if (!complete) return { ...progress, complete: false };
  // Devices not seen in this run are no longer in SOTI.
  const { entries } = await queryAll(UNMATCHED_PREFIX, 100);
  await inBatches(entries.filter((e) => e.value?.runId !== progress.runId), 10, (e) => kvs.delete(e.key));
  const last = { ...progress, finishedAt: now(), registerPartial: lookup.partial };
  await kvs.set(LAST_KEY, last);
  await kvs.delete(PROGRESS_KEY);
  return { ...last, complete: true };
}

// Hourly: carries on a sync in progress, or starts one when the last finished over 20 hours ago.
export async function scheduled() {
  const config = await getConfig();
  if (!config.host || config.autoSync === false) return { skipped: 'not-configured' };
  const progress = await kvs.get(PROGRESS_KEY);
  const last = await kvs.get(LAST_KEY);
  if (!progress && last?.finishedAt && Date.now() - Date.parse(last.finishedAt) < 20 * 3600 * 1000) return { skipped: 'recent' };
  try { return await syncStep({ restart: !progress, timeBudgetMs: 20000 }); }
  catch (e) { await kvs.set(`${LAST_KEY}:error`, { at: now(), message: e?.message || 'SOTI sync failed' }); return { error: e?.message }; }
}

// ---- Report and decisions ------------------------------------------------------------------

export async function sotiReport() {
  const config = await getConfig();
  const staleDays = Number(config.staleDays) || 30;
  const last = await kvs.get(LAST_KEY);
  const [assets, unmatched, differences] = await Promise.all([queryAll(ASSET_PREFIX), queryAll(UNMATCHED_PREFIX, 20), queryAll(DIFFERENCE_PREFIX, 20)]);
  const cutoff = Date.now() - staleDays * 86400000;
  const registerOnly = [], stale = [];
  for (const { value: a } of assets.entries) {
    if (!a?.id) continue;
    const row = { assetId: a.id, name: a.name, deviceId: a.jiraIdentifier || a.name, type: a.type || '', status: a.status || '', holder: a.assigneeName || a.crewCode || '', lastCheckIn: a.soti?.lastCheckIn || '', path: a.soti?.path || '' };
    if (last?.runId && a.soti?.runId !== last.runId) registerOnly.push(row);
    else if (a.soti?.lastCheckIn && Date.parse(a.soti.lastCheckIn) < cutoff) stale.push(row);
  }
  stale.sort((x, y) => String(x.lastCheckIn).localeCompare(String(y.lastCheckIn)));
  return {
    last, staleDays, registerPartial: assets.partial,
    progress: await kvs.get(PROGRESS_KEY),
    error: await kvs.get(`${LAST_KEY}:error`),
    differences: differences.entries.map((e) => e.value).filter((d) => d?.status === 'open'),
    sotiOnly: unmatched.entries.map((e) => e.value).filter(Boolean),
    registerOnly, stale,
  };
}

export async function resolveDifference(assetId, action) {
  const key = `${DIFFERENCE_PREFIX}${clean(assetId)}`;
  const record = await kvs.get(key);
  if (!record || record.status !== 'open') throw new Error('This difference has already been resolved. Refresh the list.');
  const asset = await kvs.get(`${ASSET_PREFIX}${record.assetId}`);
  if (!asset) { await kvs.delete(key); throw new Error('This device no longer exists.'); }
  if (action === 'soti') {
    const changes = record.differences.map((d) => ({ field: d.field, from: asset[d.field] || '', to: d.soti }));
    await kvs.set(`${ASSET_PREFIX}${asset.id}`, { ...asset, ...Object.fromEntries(record.differences.map((d) => [d.field, d.soti])), updatedAt: now() });
    await addHistory(asset.id, { type: 'updated', message: `Updated from SOTI: ${record.differences.map((d) => d.label.toLowerCase()).join(', ')}`, changes });
    await kvs.delete(key);
    return { ok: true };
  }
  if (action !== 'keep') throw new Error('Choose whether to use the SOTI values or keep the register values.');
  await kvs.set(key, { ...record, status: 'kept', keptSoti: Object.fromEntries(record.differences.map((d) => [d.field, d.soti])), resolvedAt: now(), ...actorFields() });
  await addHistory(asset.id, { type: 'soti-difference-kept', message: `Kept register values for ${record.differences.map((d) => d.label.toLowerCase()).join(', ')}; SOTI says ${record.differences.map((d) => d.soti).join(', ')}` });
  return { ok: true };
}

// Adds a device found only in SOTI to the register, named by its SOTI device name.
export async function addSotiDevice(sotiKeyValue, type) {
  const key = `${UNMATCHED_PREFIX}${encoded(sotiKeyValue)}`;
  const device = await kvs.get(key);
  if (!device) throw new Error('This SOTI device is no longer on the list. Refresh it.');
  const name = clean(device.name || device.sotiId);
  const indexed = await kvs.get(nameIndexKey(name));
  if (indexed?.assetId && (await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`))) throw new Error(`A device named “${name}” is already in the register.`);
  const id = `AST-SOTI-${encoded(device.sotiId || name).slice(0, 40).toUpperCase()}`;
  const timestamp = now();
  const asset = { id, name, jiraIdentifier: name, type: clean(type) || 'Other', status: 'In Use', serialNumber: device.serial, model: device.model, manufacturer: device.manufacturer, notes: `Added from SOTI (${device.path || 'no group'}).`, createdAt: timestamp, updatedAt: timestamp, curatedAt: timestamp,
    soti: { deviceId: device.sotiId, name: device.name, serial: device.serial, imei: device.imei, model: device.model, manufacturer: device.manufacturer, os: device.os, path: device.path, online: device.online, lastCheckIn: device.lastCheckIn, apps: {}, runId: device.runId, syncedAt: device.seenAt } };
  await kvs.set(`${ASSET_PREFIX}${id}`, asset);
  await kvs.set(nameIndexKey(name), { assetId: id, name, updatedAt: timestamp });
  await addHistory(id, { type: 'created', message: 'Added to the register from SOTI' });
  await kvs.delete(key);
  return asset;
}

// ---- Settings ------------------------------------------------------------------------------

export async function sotiSettings() {
  const config = await getConfig();
  const creds = await credentials();
  return {
    host: config.host || '', trackedApps: safeArray(config.trackedApps), staleDays: Number(config.staleDays) || 30, autoSync: config.autoSync !== false,
    clientId: creds.clientId || '', username: creds.username || '', hasSecret: Boolean(creds.clientSecret), hasPassword: Boolean(creds.password),
  };
}

// Blank secret or password keeps the saved one; clearCredentials removes them all.
export async function saveSotiSettings(input = {}) {
  const host = normaliseHost(input.host);
  if (host && !validHost(host)) throw new Error('Use your SOTI-hosted address, for example https://a123456.mobicontrol.cloud.');
  const config = await getConfig();
  await kvs.set(CONFIG_KEY, { ...config, host, trackedApps: safeArray(input.trackedApps).map(clean).filter(Boolean).slice(0, 20), staleDays: Math.max(1, Math.min(365, Number(input.staleDays) || 30)), autoSync: input.autoSync !== false });
  if (input.clearCredentials) { await kvs.deleteSecret(CREDENTIALS_KEY); await kvs.deleteSecret(TOKEN_KEY); return sotiSettings(); }
  const creds = await credentials();
  const next = { clientId: clean(input.clientId) || creds.clientId || '', clientSecret: clean(input.clientSecret) || creds.clientSecret || '', username: clean(input.username), password: clean(input.password) || (clean(input.username) ? creds.password || '' : '') };
  await kvs.setSecret(CREDENTIALS_KEY, next);
  await kvs.deleteSecret(TOKEN_KEY);
  return sotiSettings();
}

export async function testConnection() {
  await accessToken(true);
  const page = safeArray(await sotiGet('/devices?skip=0&take=1'));
  const raw = page[0];
  return { ok: true, sampleDevice: raw ? mapSotiDevice(raw) : null, fieldsFound: raw ? fieldsFound(raw) : null, availableFields: raw ? Object.keys(raw).sort() : [] };
}

// Admin page actions. crew.js passes its admin-only resolver.
export function registerSotiResolvers(resolver) {
  resolver.define('getSotiSettings', async () => sotiSettings());
  resolver.define('saveSotiSettings', async ({ payload }) => saveSotiSettings(payload || {}));
  resolver.define('testSotiConnection', async () => testConnection());
  resolver.define('sotiSyncStep', async ({ payload }) => syncStep({ restart: Boolean(payload?.restart) }));
  resolver.define('getSotiReport', async () => sotiReport());
  resolver.define('resolveSotiDifference', async ({ payload }) => resolveDifference(payload?.assetId, payload?.action));
  resolver.define('addSotiDevice', async ({ payload }) => addSotiDevice(payload?.sotiId || payload?.name, payload?.type));
}
