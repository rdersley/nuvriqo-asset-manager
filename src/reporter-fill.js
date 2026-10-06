import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

// Fills a ticket's crew code and base from the imported crew register, matched on the ticket's
// reporter. Used by the ticket-created trigger (src/status-sync.js) and by Split Devices
// (src/device-split.js). The register and these lookups are written by Crew Tracking
// (src/crew.js), which is internal-only; in the Marketplace edition nothing is stored under
// these keys, so every lookup finds nothing and the fill never shows or runs.
// Fields that already have a value are never changed, and an ambiguous match fills nothing.

export const CREW_PREFIX = 'internal-crew:';
export const CREW_EMAIL_PREFIX = 'internal-crew-email:';
export const CREW_ACCOUNT_PREFIX = 'internal-crew-account:';
export const FILL_SETTINGS_KEY = 'internal-crew-ticket-fill:settings';
export const FILL_LOG_KEY = 'internal-crew-ticket-fill:log';
const SETTINGS_KEY = 'settings:asset-manager';
const LOG_SIZE = 50;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const normalise = (value) => String(value ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
const encoded = (value) => Buffer.from(normalise(value), 'utf8').toString('base64url');
const now = () => new Date().toISOString();

export const crewKey = (crewCode) => `${CREW_PREFIX}${encoded(crewCode)}`;
export const crewEmailKey = (email) => `${CREW_EMAIL_PREFIX}${encoded(email)}`;
export const crewAccountKey = (accountId) => `${CREW_ACCOUNT_PREFIX}${encoded(accountId)}`;

// Lookups hold every crew code that uses the email/account, so a shared email is seen as ambiguous.
export async function addLookup(key, crewCode) {
  const codes = (await kvs.get(key))?.crewCodes || [];
  if (codes.some((c) => normalise(c) === normalise(crewCode))) return;
  await kvs.set(key, { crewCodes: [...codes, crewCode] });
}
export async function removeLookup(key, crewCode) {
  const existing = await kvs.get(key);
  if (!existing) return;
  const codes = (existing.crewCodes || []).filter((c) => normalise(c) !== normalise(crewCode));
  if (codes.length) await kvs.set(key, { crewCodes: codes }); else await kvs.delete(key);
}

export async function getFillSettings() {
  const raw = await kvs.get(FILL_SETTINGS_KEY);
  const stored = raw || {};
  const main = (await kvs.get(SETTINGS_KEY)) || {};
  return {
    // Only set once someone has used the fill settings in Crew Tracking.
    inUse: Boolean(raw),
    crewCodeField: main.jiraCrewCodeField?.id ? main.jiraCrewCodeField : null,
    baseField: stored.baseField?.id ? stored.baseField : null,
    fillOnCreate: stored.fillOnCreate === true,
    projects: Array.isArray(stored.projects) ? stored.projects : []
  };
}
export const fillConfigured = (settings) => settings.inUse && Boolean(settings.crewCodeField || settings.baseField);
export const projectInScope = (settings, projectKey) => !settings.projects.length || settings.projects.some((p) => p.toUpperCase() === clean(projectKey).toUpperCase());

// The crew record for a Jira user: by email when Jira shows it, else by the Jira account that
// Crew Tracking linked to the crew member.
export async function findCrewForUser(user) {
  if (!user) return { status: 'no-reporter' };
  const email = clean(user.emailAddress);
  const accountId = clean(user.accountId);
  let codes = [];
  let matchedBy = '';
  if (email) { codes = (await kvs.get(crewEmailKey(email)))?.crewCodes || []; matchedBy = 'email'; }
  if (!codes.length && accountId) { codes = (await kvs.get(crewAccountKey(accountId)))?.crewCodes || []; matchedBy = 'account'; }
  if (codes.length > 1) return { status: 'multiple', crewCodes: codes };
  const crew = codes.length ? await kvs.get(crewKey(codes[0])) : null;
  if (!crew) return { status: 'not-found', email };
  return { status: 'found', matchedBy, crew: { crewCode: clean(crew.crewCode), name: clean(crew.name), base: clean(crew.location), email: clean(crew.email) } };
}

function firstValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(firstValue).find(Boolean) || '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (typeof value === 'object') return clean(String(value.value ?? value.name ?? value.label ?? value.displayName ?? ''));
  return '';
}

// The Jira value for text in a field: the matching option on a select field, the text on a text
// field, or null when the field cannot take it.
export function jiraFieldValue(def, text) {
  const key = normalise(text);
  if (Array.isArray(def?.allowedValues) && def.allowedValues.length) {
    const option = def.allowedValues.find((o) => normalise(o?.value ?? o?.name) === key);
    if (!option) return null;
    const ref = option.id ? { id: String(option.id) } : { value: option.value ?? option.name };
    return def.schema?.type === 'array' ? [ref] : ref;
  }
  if (def?.schema?.type === 'string') return text;
  if (def?.schema?.type === 'array' && def.schema.items === 'string') return [text];
  return null;
}

// What filling would do to each field. `fields` are the ticket's current values; `editFields`
// is the ticket's editmeta (null when it has not been read yet).
export function planFill(settings, fields, match, editFields = null) {
  if (match?.status !== 'found') return [];
  const wanted = [
    settings.crewCodeField && { field: settings.crewCodeField, label: 'Crew code', value: match.crew.crewCode },
    settings.baseField && { field: settings.baseField, label: 'Base', value: match.crew.base }
  ].filter(Boolean);
  return wanted.map(({ field, label, value }) => {
    const current = firstValue(fields?.[field.id]);
    const row = { fieldId: field.id, fieldName: field.name || label, label, current, value };
    if (!value) return { ...row, action: 'no-value-in-register' };
    if (current) return { ...row, action: normalise(current) === normalise(value) ? 'already-set' : 'kept-existing' };
    if (!editFields) return { ...row, action: 'fill' };
    const def = editFields[field.id];
    if (!def) return { ...row, action: 'not-on-edit-screen' };
    const jiraValue = jiraFieldValue(def, value);
    return jiraValue === null ? { ...row, action: 'not-an-option' } : { ...row, action: 'fill', jiraValue };
  });
}

export function fillFieldIds(settings) {
  return [settings.crewCodeField?.id, settings.baseField?.id].filter(Boolean);
}

// Reads the editmeta and writes every field the plan can fill. `as` is api.asApp or api.asUser.
export async function applyFill(as, issueKey, settings, fields, match) {
  if (!planFill(settings, fields, match).some((row) => row.action === 'fill')) return { result: 'nothing-to-fill', rows: planFill(settings, fields, match) };
  const meta = await as().requestJira(route`/rest/api/3/issue/${issueKey}/editmeta`, { headers: { Accept: 'application/json' } });
  if (!meta.ok) return { result: 'jira-read-failed', rows: [] };
  const rows = planFill(settings, fields, match, (await meta.json()).fields || {});
  const update = Object.fromEntries(rows.filter((row) => row.action === 'fill').map((row) => [row.fieldId, row.jiraValue]));
  if (!Object.keys(update).length) return { result: 'nothing-to-fill', rows };
  const put = await as().requestJira(route`/rest/api/3/issue/${issueKey}`, { method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: update }) });
  if (!put.ok) return { result: 'jira-update-failed', rows };
  return { result: 'filled', rows: rows.map((row) => (row.action === 'fill' ? { ...row, action: 'filled' } : row)) };
}

export async function logFill(entry) {
  const previous = (await kvs.get(FILL_LOG_KEY)) || [];
  await kvs.set(FILL_LOG_KEY, [{ at: now(), ...entry }, ...previous].slice(0, LOG_SIZE));
}

// The reporter whose crew details belong on a ticket: its own, or the parent's for a sub-task
// (a sub-task is raised by the agent who split the request, not by the crew member).
async function crewReporter(issueKey, settings) {
  const ids = fillFieldIds(settings);
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}?fields=${['project', 'reporter', 'issuetype', 'parent', ...ids].join(',')}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return { error: 'jira-read-failed' };
  const fields = (await response.json()).fields || {};
  let reporter = fields.reporter;
  const parentKey = fields.issuetype?.subtask ? clean(fields.parent?.key) : '';
  if (parentKey) {
    const parent = await api.asApp().requestJira(route`/rest/api/3/issue/${parentKey}?fields=reporter`, { headers: { Accept: 'application/json' } });
    if (!parent.ok) return { error: 'jira-read-failed' };
    reporter = (await parent.json()).fields?.reporter;
  }
  return { fields, reporter, parentKey };
}

// Ticket-created trigger: fill the new ticket from its reporter's crew record.
export async function fillOnCreate(event, issueKey) {
  if (!issueKey || !/created/.test(String(event?.eventType || ''))) return null;
  const settings = await getFillSettings();
  if (!settings.fillOnCreate || !fillConfigured(settings)) return null;
  const projectKey = clean(event?.issue?.fields?.project?.key);
  if (projectKey && !projectInScope(settings, projectKey)) return null;
  const ticket = await crewReporter(issueKey, settings);
  if (ticket.error) { await logFill({ issueKey, result: ticket.error }); return ticket.error; }
  if (!projectInScope(settings, ticket.fields.project?.key)) return null;
  if (fillFieldIds(settings).every((id) => firstValue(ticket.fields[id]))) return 'already-set';
  const match = await findCrewForUser(ticket.reporter);
  const reporter = clean(ticket.reporter?.displayName) || clean(ticket.reporter?.emailAddress);
  if (match.status !== 'found') { await logFill({ issueKey, reporter, result: match.status, ...(match.crewCodes ? { detail: match.crewCodes.join(', ') } : {}) }); return match.status; }
  const outcome = await applyFill(api.asApp, issueKey, settings, ticket.fields, match);
  await logFill({ issueKey, reporter, crewCode: match.crew.crewCode, result: outcome.result, detail: outcome.rows.map((r) => `${r.label}: ${r.action}`).join(', ') });
  return outcome.result;
}
