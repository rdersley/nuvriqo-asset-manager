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
