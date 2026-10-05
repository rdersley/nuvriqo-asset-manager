import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createHash } from 'node:crypto';
import {
  deviceFieldIds, matchStatusRule, normaliseReplacementSettings, normaliseStatusRules, replacementApplies,
  statusChangeFromEvent, STATUS_AUTOMATION_LOG_KEY, STATUS_AUTOMATION_LOG_SIZE
} from './status-automation.js';
import { checkDeviceId, compileDeviceIdPatterns } from './device-id-rule.js';
import { recordTicketRejection } from './device-id-review.js';

// Trigger on avi:jira:created:issue and avi:jira:updated:issue (internal edition).
// When a ticket is created or its Device ID changes, a value that isn't a Device ID goes onto the
// Device ID clean-up list straight away. When a ticket's status changes:
// - status rules set the status of the device on the ticket (main Device ID field, or the
//   "existing" field of a replacement pair on HW tickets);
// - the replacement rule moves the old device's holder, client and location onto the
//   replacement device recorded on the ticket, creating that device if it is not registered.
// Anything ambiguous is skipped and logged rather than guessed.

const SETTINGS_KEY = 'settings:asset-manager';
const ASSET_PREFIX = 'asset:';
const ASSET_NAME_PREFIX = 'asset-name:';
const HISTORY_PREFIX = 'asset-history:';

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const normaliseName = (value) => clean(String(value ?? '')).toLocaleLowerCase('en').replace(/\s+/g, ' ');
// Keys must match src/index.js (makeJiraAssetId, nameIndexKey).
const jiraAssetId = (fieldId, identifier) => `AST-JIRA-${createHash('sha256').update(`${fieldId}:${normaliseName(identifier)}`).digest('hex').slice(0, 24).toUpperCase()}`;
const nameIndexKey = (name) => `${ASSET_NAME_PREFIX}${Buffer.from(normaliseName(name), 'utf8').toString('base64url')}`;
const now = () => new Date().toISOString();

function fieldValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') { const v = value.value ?? value.name ?? value.label ?? value.displayName ?? value.key; return v ? [String(v).trim()] : []; }
  return [];
}
// Same placeholder rules as Jira discovery: no "N/A", "0000", numbers-only or 3-character values.
const validIdentifier = (raw) => raw.length >= 4 && raw.length <= 100 && /[a-z]/i.test(raw) && !['n/a', 'none', 'null', 'unknown'].includes(raw.toLowerCase());
// Device IDs in a field, as typed ("RYRS506641"); "A | B" counts as two.
const identifiersIn = (value) => {
  const seen = new Map();
  for (const id of fieldValues(value).flatMap((v) => v.split(/\s*[|,;]\s*/)).map((v) => v.trim()).filter(validIdentifier)) if (!seen.has(normaliseName(id))) seen.set(normaliseName(id), id);
  return [...seen.values()];
};
const firstValue = (value) => fieldValues(value)[0] || '';

async function findDevice(fieldId, identifier) {
  if (fieldId) { const byJiraId = await kvs.get(`${ASSET_PREFIX}${jiraAssetId(fieldId, identifier)}`); if (byJiraId) return byJiraId; }
  const indexed = await kvs.get(nameIndexKey(identifier));
  return indexed?.assetId ? (await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`)) || null : null;
}

async function addHistory(assetId, event) {
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${assetId}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, { assetId, timestamp, ...event });
}

async function log(entry) {
  const previous = (await kvs.get(STATUS_AUTOMATION_LOG_KEY)) || [];
  await kvs.set(STATUS_AUTOMATION_LOG_KEY, [{ at: now(), ...entry }, ...previous].slice(0, STATUS_AUTOMATION_LOG_SIZE));
}

async function applyStatusRule(settings, fields, issueKey, change, rule) {
  const identifiers = [...new Map(deviceFieldIds(settings).flatMap((id) => identifiersIn(fields[id])).map((id) => [normaliseName(id), id])).values()];
  const base = { issueKey, ticketStatus: change.to, deviceStatus: rule.deviceStatus };
  if (!identifiers.length) { await log({ ...base, result: 'no-device-on-ticket' }); return { skipped: 'no-device-on-ticket' }; }
  if (identifiers.length > 1) { await log({ ...base, result: 'multiple-devices', detail: identifiers.join(', ') }); return { skipped: 'multiple-devices' }; }
  const device = await findDevice(settings.jiraAssetField?.id, identifiers[0]);
  if (!device) { await log({ ...base, result: 'device-not-in-register', detail: identifiers[0] }); return { skipped: 'device-not-in-register' }; }
  if (device.status === rule.deviceStatus) { await log({ ...base, device: device.name, result: 'already-set' }); return { skipped: 'already-set' }; }
  await kvs.set(`${ASSET_PREFIX}${device.id}`, { ...device, status: rule.deviceStatus, updatedAt: now() });
  await addHistory(device.id, { type: 'updated', source: 'ticket-status', issueKey, message: `Status set to ${rule.deviceStatus} by ${issueKey} (ticket moved to ${change.to})`, changes: [{ field: 'status', from: device.status || '', to: rule.deviceStatus }] });
  await log({ ...base, device: device.name, from: device.status || '', result: 'updated' });
  return { updated: device.id };
}

// The Asset types list's spelling of a type from a ticket, so "tablet" is saved as "Tablet".
function configuredType(settings, type) {
  const key = normaliseName(type);
  return (settings.assetTypes || []).find((t) => normaliseName(t) === key) || type;
}

// Holder, client and location for the replacement: from the old device when it is registered,
// otherwise from the ticket's mapped fields.
function takeOver(settings, fields, oldDevice) {
  if (oldDevice) return { crewCode: oldDevice.crewCode || '', assigneeName: oldDevice.assigneeName || '', assigneeAccountId: oldDevice.assigneeAccountId || '', client: oldDevice.client || '', location: oldDevice.location || '' };
  const crewCode = firstValue(fields[settings.jiraCrewCodeField?.id]);
  const mapped = (settings.crewMappings || []).find((m) => normaliseName(m.crewCode) === normaliseName(crewCode));
  return { crewCode, assigneeName: mapped?.displayName || crewCode, assigneeAccountId: mapped?.accountId || '', client: firstValue(fields[settings.jiraClientField?.id]), location: firstValue(fields[settings.jiraLocationField?.id]) };
}

async function applyReplacement(settings, fields, issueKey, change, replacement) {
  const mainFieldId = clean(settings.jiraAssetField?.id);
  const results = [];
  for (const pair of replacement.pairs) {
    const replacementIds = identifiersIn(fields[pair.replacementField.id]);
    if (!replacementIds.length) continue;
    const base = { issueKey, ticketStatus: change.to, deviceStatus: replacement.deviceStatus, kind: 'replacement', field: pair.replacementField.name };
    if (replacementIds.length > 1) { await log({ ...base, result: 'multiple-devices', detail: replacementIds.join(', ') }); results.push({ skipped: 'multiple-devices' }); continue; }
    const existingIds = identifiersIn(fields[pair.existingField.id]);
    const oldDevice = existingIds.length === 1 ? await findDevice(mainFieldId, existingIds[0]) : null;
    const newId = replacementIds[0];
    let device = await findDevice(mainFieldId, newId);
    const created = !device;
    if (created) {
      // Same id scheme as Jira discovery, so a later scan matches this record.
      const id = mainFieldId ? jiraAssetId(mainFieldId, newId) : `AST-REPL-${createHash('sha256').update(normaliseName(newId)).digest('hex').slice(0, 24).toUpperCase()}`;
      device = { id, name: newId, jiraIdentifier: newId, type: oldDevice?.type || configuredType(settings, firstValue(fields[settings.jiraTypeField?.id])) || 'Other', notes: `Created from ${issueKey} as the replacement for ${existingIds[0] || 'an unrecorded device'}.`, createdAt: now(), curatedAt: now() };
      await kvs.set(nameIndexKey(newId), { assetId: id, name: newId, updatedAt: now() });
    }
    const values = { ...takeOver(settings, fields, oldDevice), status: replacement.deviceStatus };
    const changes = Object.entries(values).filter(([k, v]) => v && (device[k] || '') !== v).map(([field, to]) => ({ field, from: device[field] || '', to }));
    await kvs.set(`${ASSET_PREFIX}${device.id}`, { ...device, ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)), updatedAt: now() });
    await addHistory(device.id, { type: created ? 'created' : 'updated', source: 'ticket-replacement', issueKey, message: `${created ? 'Created as' : 'Set as'} the replacement for ${existingIds[0] || 'an unrecorded device'} on ${issueKey}`, changes });
    if (oldDevice) await addHistory(oldDevice.id, { type: 'replaced', source: 'ticket-replacement', issueKey, message: `Replaced by ${newId} on ${issueKey}` });
    await log({ ...base, device: newId, from: existingIds[0] || '', result: created ? 'replacement-created' : 'replacement-applied' });
    results.push({ replaced: existingIds[0] || '', by: device.id, created });
  }
  return results;
}

// The Device ID field of a ticket being created or edited, checked against the configured format.
// Updates that change no custom field leave before any storage or Jira call.
async function checkDeviceIdOnSave(event, issueKey) {
  const items = Array.isArray(event?.changelog?.items) ? event.changelog.items : [];
  const created = /created/.test(String(event?.eventType || '')) || !event?.changelog;
  if (!issueKey || (!created && !items.some((i) => String(i?.fieldId || '').startsWith('customfield_')))) return null;
  const stored = (await kvs.get(SETTINGS_KEY)) || {};
  const fieldId = clean(stored.jiraAssetField?.id);
  if (!fieldId || (!created && !items.some((i) => i?.fieldId === fieldId))) return null;
  const typeFieldId = clean(stored.jiraTypeField?.id);
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${['project', fieldId, typeFieldId].filter(Boolean).join(',')}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return { deviceId: 'jira-read-failed' };
  const fields = (await response.json()).fields || {};
  // Only the project Asset Manager scans, like the Jira scan itself.
  const projectKey = clean(stored.jiraProjectKey).toUpperCase();
  if (projectKey && clean(fields.project?.key).toUpperCase() !== projectKey) return null;
  const compiled = compileDeviceIdPatterns(stored.deviceIdPatterns, stored.assetTypes);
  const ticketType = typeFieldId ? firstValue(fields[typeFieldId]) : '';
  const rejected = [];
  for (const value of fieldValues(fields[fieldId])) {
    const check = checkDeviceId(value, compiled, ticketType);
    if (check && !check.ok) { await recordTicketRejection(value, check.reason, issueKey); rejected.push(value); }
  }
  return { deviceIdRejected: rejected };
}

export async function handler(event) {
  const issueKey = clean(event?.issue?.key);
  const deviceIdCheck = await checkDeviceIdOnSave(event, issueKey).catch(() => ({ deviceId: 'check-failed' }));
  // Most issue updates are not status changes; leave before any further storage or Jira call.
  const change = statusChangeFromEvent(event);
  if (!change || !issueKey) return { skipped: 'not-a-status-change', ...(deviceIdCheck || {}) };

  const stored = (await kvs.get(SETTINGS_KEY)) || {};
  const rules = stored.statusAutomationEnabled ? normaliseStatusRules(stored.statusRules, stored.statuses || []) : [];
  const replacement = normaliseReplacementSettings(stored.replacement, stored.statuses || []);
  const settings = { ...stored, replacement };
  if (!rules.length && !replacement.enabled) return { skipped: 'automation-off' };

  const wanted = [...new Set(['project', ...deviceFieldIds(settings), ...replacement.pairs.map((p) => p.replacementField.id),
    settings.jiraCrewCodeField?.id, settings.jiraClientField?.id, settings.jiraLocationField?.id, settings.jiraTypeField?.id].filter(Boolean))];
  if (wanted.length === 1) return { skipped: 'no-device-field' };
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${wanted.join(',')}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) { await log({ issueKey, ticketStatus: change.to, result: 'jira-read-failed', detail: `Jira returned ${response.status}` }); return { skipped: 'jira-read-failed' }; }
  const fields = (await response.json()).fields || {};
  const projectKey = clean(fields.project?.key) || clean(event?.issue?.fields?.project?.key);

  const rule = matchStatusRule(rules, projectKey, change.to);
  const doReplacement = replacementApplies(replacement, projectKey, change.to);
  if (!rule && !doReplacement) return { skipped: 'no-matching-rule' };
  const statusResult = rule ? await applyStatusRule(settings, fields, issueKey, change, rule) : {};
  const replacements = doReplacement ? await applyReplacement(settings, fields, issueKey, change, replacement) : [];
  return { ...statusResult, replacements };
}
