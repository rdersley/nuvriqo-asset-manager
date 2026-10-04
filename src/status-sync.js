import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { createHash } from 'node:crypto';
import { matchStatusRule, normaliseStatusRules, statusChangeFromEvent, STATUS_AUTOMATION_LOG_KEY, STATUS_AUTOMATION_LOG_SIZE } from './status-automation.js';

// Trigger on avi:jira:updated:issue (internal edition). When a ticket's status changes and a
// configured rule matches, the device named in the ticket's Device ID field gets the rule's
// device status. Anything ambiguous is skipped and logged rather than guessed.

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

async function findDevice(fieldId, identifier) {
  const byJiraId = await kvs.get(`${ASSET_PREFIX}${jiraAssetId(fieldId, identifier)}`);
  if (byJiraId) return byJiraId;
  const indexed = await kvs.get(nameIndexKey(identifier));
  return indexed?.assetId ? (await kvs.get(`${ASSET_PREFIX}${indexed.assetId}`)) || null : null;
}

async function log(entry) {
  const previous = (await kvs.get(STATUS_AUTOMATION_LOG_KEY)) || [];
  await kvs.set(STATUS_AUTOMATION_LOG_KEY, [{ at: now(), ...entry }, ...previous].slice(0, STATUS_AUTOMATION_LOG_SIZE));
}

export async function handler(event) {
  // Most issue updates are not status changes; leave before any storage or Jira call.
  const change = statusChangeFromEvent(event);
  const issueKey = clean(event?.issue?.key);
  if (!change || !issueKey) return { skipped: 'not-a-status-change' };

  const settings = (await kvs.get(SETTINGS_KEY)) || {};
  const rules = normaliseStatusRules(settings.statusRules, settings.statuses || []);
  if (!settings.statusAutomationEnabled || !rules.length) return { skipped: 'automation-off' };
  const fieldId = clean(settings.jiraAssetField?.id);
  if (!fieldId) return { skipped: 'no-device-field' };

  let projectKey = clean(event?.issue?.fields?.project?.key);
  let deviceValue = event?.issue?.fields?.[fieldId];
  if (!projectKey || deviceValue === undefined) {
    const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=project,${fieldId}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) { await log({ issueKey, ticketStatus: change.to, result: 'jira-read-failed', detail: `Jira returned ${response.status}` }); return { skipped: 'jira-read-failed' }; }
    const issue = await response.json();
    projectKey = clean(issue.fields?.project?.key);
    deviceValue = issue.fields?.[fieldId];
  }

  const rule = matchStatusRule(rules, projectKey, change.to);
  if (!rule) return { skipped: 'no-matching-rule' };

  const identifiers = [...new Set(fieldValues(deviceValue).flatMap((v) => v.split(/\s*[|,;]\s*/)).map((v) => v.trim()).filter(validIdentifier).map(normaliseName))];
  const base = { issueKey, ticketStatus: change.to, deviceStatus: rule.deviceStatus };
  if (!identifiers.length) { await log({ ...base, result: 'no-device-on-ticket' }); return { skipped: 'no-device-on-ticket' }; }
  if (identifiers.length > 1) { await log({ ...base, result: 'multiple-devices', detail: identifiers.join(', ') }); return { skipped: 'multiple-devices' }; }

  const device = await findDevice(fieldId, identifiers[0]);
  if (!device) { await log({ ...base, result: 'device-not-in-register', detail: identifiers[0] }); return { skipped: 'device-not-in-register' }; }
  if (device.status === rule.deviceStatus) { await log({ ...base, device: device.name, result: 'already-set' }); return { skipped: 'already-set' }; }

  await kvs.set(`${ASSET_PREFIX}${device.id}`, { ...device, status: rule.deviceStatus, updatedAt: now() });
  const timestamp = now();
  await kvs.set(`${HISTORY_PREFIX}${device.id}:${timestamp}:${Math.random().toString(36).slice(2, 7)}`, {
    assetId: device.id, timestamp, type: 'updated', source: 'ticket-status', issueKey,
    message: `Status set to ${rule.deviceStatus} by ${issueKey} (ticket moved to ${change.to})`,
    changes: [{ field: 'status', from: device.status || '', to: rule.deviceStatus }]
  });
  await log({ ...base, device: device.name, from: device.status || '', result: 'updated' });
  return { updated: device.id };
}
