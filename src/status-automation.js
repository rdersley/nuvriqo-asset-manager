// Device status automation: keep a device's status in line with the ticket it is on, e.g.
// "when an SD or HW ticket moves to Dispatched, set the device to In Use". Pure helpers so the
// rules can be tested without Forge; the trigger itself is src/status-sync.js.

export const MAX_STATUS_RULES = 30;
export const STATUS_AUTOMATION_LOG_KEY = 'status-automation:log';
export const STATUS_AUTOMATION_LOG_SIZE = 50;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const asList = (value) => (Array.isArray(value) ? value : []);
const statusKey = (value) => clean(value).toLocaleLowerCase('en').replace(/\s+/g, ' ');
const PROJECT_KEY = /^[A-Z][A-Z0-9_]{0,29}$/;

// Rules as saved from Configuration. A rule needs a ticket status and a device status that is one
// of the configured device statuses (stored with that status's exact spelling). Projects may be an
// array or a comma-separated string; empty means any project.
export function normaliseStatusRules(rules, deviceStatuses = []) {
  const byKey = new Map(asList(deviceStatuses).map((s) => [statusKey(s), clean(s)]));
  return asList(rules).map((rule) => {
    const projects = (Array.isArray(rule?.projects) ? rule.projects : String(rule?.projects || '').split(','))
      .map((p) => clean(p).toUpperCase()).filter((p) => PROJECT_KEY.test(p));
    return { projects: [...new Set(projects)], ticketStatus: clean(rule?.ticketStatus).slice(0, 100), deviceStatus: byKey.get(statusKey(rule?.deviceStatus)) || '' };
  }).filter((rule) => rule.ticketStatus && rule.deviceStatus).slice(0, MAX_STATUS_RULES);
}

// The status change in an avi:jira:updated:issue event, or null when the status did not change.
export function statusChangeFromEvent(event) {
  const item = asList(event?.changelog?.items).find((i) => i?.fieldId === 'status' || clean(i?.field).toLowerCase() === 'status');
  if (!item || !clean(item.toString)) return null;
  return { from: clean(item.fromString), to: clean(item.toString) };
}

// First rule for this project and new ticket status (status names compared case-insensitively).
export function matchStatusRule(rules, projectKey, ticketStatus) {
  const project = clean(projectKey).toUpperCase();
  return asList(rules).find((r) => statusKey(r.ticketStatus) === statusKey(ticketStatus) && (!r.projects?.length || r.projects.includes(project))) || null;
}

// Device replacements: HW tickets record the device being replaced and its replacement in a pair
// of fields per device type (e.g. "vPos Device ID - Existing" / "vPos Device ID - Replacement").
// When the ticket moves to the configured status, the replacement device takes over the old
// device's holder, client and location and gets the configured status.
export const MAX_REPLACEMENT_PAIRS = 6;
const CUSTOM_FIELD = /^customfield_\d+$/;
const fieldRef = (f) => (CUSTOM_FIELD.test(clean(f?.id)) ? { id: clean(f.id), name: clean(f?.name) || clean(f.id) } : null);

export function normaliseReplacementSettings(input, deviceStatuses = []) {
  const byKey = new Map(asList(deviceStatuses).map((s) => [statusKey(s), clean(s)]));
  const projects = (Array.isArray(input?.projects) ? input.projects : String(input?.projects || '').split(','))
    .map((p) => clean(p).toUpperCase()).filter((p) => PROJECT_KEY.test(p));
  const pairs = asList(input?.pairs).map((p) => ({ existingField: fieldRef(p?.existingField), replacementField: fieldRef(p?.replacementField) }))
    .filter((p) => p.existingField && p.replacementField && p.existingField.id !== p.replacementField.id).slice(0, MAX_REPLACEMENT_PAIRS);
  return {
    enabled: input?.enabled === true,
    projects: [...new Set(projects)],
    ticketStatus: clean(input?.ticketStatus).slice(0, 100),
    deviceStatus: byKey.get(statusKey(input?.deviceStatus)) || '',
    pairs
  };
}

export function replacementApplies(replacement, projectKey, ticketStatus) {
  if (!replacement?.enabled || !replacement.ticketStatus || !replacement.deviceStatus || !replacement.pairs?.length) return false;
  const project = clean(projectKey).toUpperCase();
  return statusKey(replacement.ticketStatus) === statusKey(ticketStatus) && (!replacement.projects.length || replacement.projects.includes(project));
}

// Fields that identify "the device on this ticket" for status rules: the main Device ID field
// plus the "existing device" field of every replacement pair (HW tickets use those).
export function deviceFieldIds(settings = {}) {
  const ids = [clean(settings.jiraAssetField?.id), ...asList(settings.replacement?.pairs).map((p) => clean(p?.existingField?.id))];
  return [...new Set(ids.filter(Boolean))];
}
