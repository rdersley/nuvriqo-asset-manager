// Evidence of who has a device: its Jira tickets (each with the assignment reference / crew code
// it was raised under) and its holder changes. Shared by the device timeline and the bulk holder
// review, so both read the evidence the same way.

const norm = (v) => String(v ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
const newestFirst = (a, b) => String(b.at ?? b.created ?? '').localeCompare(String(a.at ?? a.created ?? ''));

// "2026-03-04T10:20:00.000+0000" → "2026-03-04"; anything that isn't a date → ''.
export const dateOnly = (v) => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''; };

// Tickets where the device was the primary device and a crew code was recorded, newest first.
const reportedTickets = (tickets = []) => tickets
  .filter((t) => t && t.relation !== 'related' && String(t.crewCode || '').trim() && t.created)
  .sort(newestFirst);

// The newest tickets raised under one crew code, back to the first ticket under a different code:
// "the last 3 tickets, since 4 March, were all raised by C123".
export function latestReporterRun(tickets = []) {
  const reported = reportedTickets(tickets);
  if (!reported.length) return null;
  const code = norm(reported[0].crewCode);
  const run = [];
  for (const t of reported) { if (norm(t.crewCode) !== code) break; run.push(t); }
  return { crewCode: String(reported[0].crewCode).trim(), count: run.length, since: run.at(-1).created, until: run[0].created, issueKeys: run.map((t) => t.key) };
}

// Each crew code that has raised tickets with the device: how many, first and last, newest first.
export function reporterSummary(tickets = []) {
  const byCode = new Map();
  for (const t of reportedTickets(tickets)) {
    const key = norm(t.crewCode);
    const entry = byCode.get(key) || { crewCode: String(t.crewCode).trim(), count: 0, first: t.created, last: t.created };
    entry.count += 1;
    if (String(t.created) < String(entry.first)) entry.first = t.created;
    if (String(t.created) > String(entry.last)) entry.last = t.created;
    byCode.set(key, entry);
  }
  return [...byCode.values()].sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

const HOLDER_EVENTS = new Set(['created', 'holder-conflict-accepted', 'holder-conflict-kept', 'holder-bulk-accepted', 'replaced', 'merged']);
const HOLDER_FIELDS = new Set(['assigned person', 'assignment reference', 'assigned since', 'crewCode', 'assigneeName', 'assignedAt']);

// One list, newest first: tickets (flagged when raised under someone other than the current
// holder) and holder changes, with a summary of who has reported with the device.
export function buildDeviceTimeline(asset = {}, tickets = [], history = []) {
  const holderCode = norm(asset.crewCode);
  const ticketEvents = tickets.map((t) => ({
    kind: 'ticket', at: t.created || '', key: t.key, summary: t.fault || t.summary || '', status: t.status || '', issueType: t.issueType || '',
    relation: t.relation || 'primary', crewCode: String(t.crewCode || '').trim(), base: String(t.base || '').trim(),
    otherHolder: Boolean(holderCode && String(t.crewCode || '').trim() && norm(t.crewCode) !== holderCode && t.relation !== 'related')
  }));
  const holderEvents = history
    .filter((h) => HOLDER_EVENTS.has(h.type) || (h.changes || []).some((c) => HOLDER_FIELDS.has(c.field)))
    .map((h) => ({ kind: 'holder', at: h.timestamp || '', type: h.type || '', message: h.message || '', issueKey: h.issueKey || '', by: h.changedByName || '', changes: (h.changes || []).filter((c) => HOLDER_FIELDS.has(c.field)) }));
  const latestRun = latestReporterRun(tickets);
  const assigned = dateOnly(asset.assignedAt);
  return {
    holder: asset.assigneeName || asset.crewCode || '',
    crewCode: asset.crewCode || '',
    assignedAt: asset.assignedAt || '',
    events: [...ticketEvents, ...holderEvents].sort(newestFirst),
    reporters: reporterSummary(tickets),
    latestRun,
    latestMatchesHolder: latestRun && holderCode ? norm(latestRun.crewCode) === holderCode : null,
    // Tickets since the device was assigned that were raised by someone else.
    otherReportsSinceAssigned: ticketEvents.filter((e) => e.otherHolder && (!assigned || dateOnly(e.at) >= assigned)).length
  };
}

// Whether the bulk review should move a device to its latest reporter: at least minTickets newest
// tickets in a row from one crew code that isn't the current holder, the newest on or after since.
export function bulkCandidate(asset, tickets, { minTickets = 2, since = '' } = {}) {
  const run = latestReporterRun(tickets);
  if (!run || run.count < Math.max(1, Number(minTickets) || 1)) return null;
  if (since && dateOnly(run.until) < dateOnly(since)) return null;
  if (norm(run.crewCode) === norm(asset?.crewCode)) return null;
  return run;
}
