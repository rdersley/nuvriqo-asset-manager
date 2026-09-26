import { invoke } from '@forge/bridge';

// Page caps: crew and assets are read 1,000 per call, tickets up to 1,000 per call.
const MAX_CREW_CALLS = 50;
const MAX_ASSET_CALLS = 100;
const MAX_TICKET_CALLS = 30;

const clean = (v) => (typeof v === 'string' ? v.trim() : v);
const normalise = (v) => String(clean(v) || '').toLocaleLowerCase('en').replace(/\s+/g, ' ');
function fieldValues(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(fieldValues);
  if (typeof v === 'string' || typeof v === 'number') return [String(v).trim()].filter(Boolean);
  if (typeof v === 'object') { const c = v.value ?? v.name ?? v.label ?? v.displayName ?? v.objectKey ?? v.key; return c ? [String(c).trim()] : []; }
  return [];
}

// Joins crew, assets and crew-code tickets into one row per crew member. Same rules as the
// former getCrewReport resolver.
export function buildCrewReport({ crewRows = [], assets = [], issues = [], crewCodeFieldId, assetFieldId }) {
  const map = new Map(crewRows.map((c) => [normalise(c.crewCode), { ...c, currentDevices: [], historicalDevices: new Set(), tickets: [] }]));
  const ensure = (code) => {
    const k = normalise(code); if (!k) return null;
    if (!map.has(k)) map.set(k, { crewCode: clean(code), name: '', location: '', email: '', status: 'Not in imported crew list', currentDevices: [], historicalDevices: new Set(), tickets: [] });
    return map.get(k);
  };
  for (const a of assets) {
    if (!a?.crewCode) continue;
    const c = ensure(a.crewCode), id = a.jiraIdentifier || a.name || a.id;
    c.currentDevices.push({ id: a.id, name: a.name || id, identifier: id, type: a.type || 'Unspecified', status: a.status || '', location: a.location || '' });
    if (id) c.historicalDevices.add(id);
  }
  for (const issue of issues) {
    for (const code of fieldValues(issue.fields?.[crewCodeFieldId])) {
      const c = ensure(code); if (!c) continue;
      const dev = assetFieldId ? fieldValues(issue.fields?.[assetFieldId]) : [];
      dev.forEach((d) => c.historicalDevices.add(d));
      c.tickets.push({ key: issue.key, summary: issue.fields?.summary || '', status: issue.fields?.status?.name || '', issueType: issue.fields?.issuetype?.name || '', priority: issue.fields?.priority?.name || '', created: issue.fields?.created || '', resolved: issue.fields?.resolutiondate || '', devices: dev });
    }
  }
  return [...map.values()].map((c) => {
    const tm = new Map();
    for (const d of c.currentDevices) {
      const type = clean(d.type) || 'Unspecified', k = normalise(type) || 'unspecified';
      if (!tm.has(k)) tm.set(k, { type, count: 0, devices: [] });
      const g = tm.get(k); g.count++; g.devices.push(d);
    }
    const currentDeviceTypes = [...tm.values()].sort((a, b) => String(a.type).localeCompare(String(b.type), undefined, { sensitivity: 'base' }));
    const duplicateDeviceTypes = currentDeviceTypes.filter((g) => g.count > 1);
    return { ...c, historicalDevices: [...c.historicalDevices], currentDeviceTypes, duplicateDeviceTypes, currentDeviceCount: c.currentDevices.length, currentDeviceTypeCount: currentDeviceTypes.length, historicalDeviceCount: c.historicalDevices.size, ticketCount: c.tickets.length, reviewRequired: duplicateDeviceTypes.length > 0, unreturnedIndicator: duplicateDeviceTypes.reduce((s, g) => s + Math.max(0, g.count - 1), 0) };
  }).sort((a, b) => (a.reviewRequired !== b.reviewRequired ? (a.reviewRequired ? -1 : 1) : String(a.crewCode).localeCompare(String(b.crewCode), undefined, { sensitivity: 'base' })));
}

async function pageAll(name, cursorKey, maxCalls, onPage) {
  const items = []; let cursor = null; let calls = 0;
  do {
    const page = await invoke(name, { [cursorKey]: cursor });
    items.push(...(page?.items || page?.issues || []));
    cursor = page?.nextCursor || page?.nextPageToken || null; calls += 1;
    onPage?.(items.length, items);
  } while (cursor && calls < maxCalls);
  return { items, partial: Boolean(cursor) };
}

// Loads every crew record, every asset with a crew code and the crew-code tickets, then joins
// them. onRows receives the crew/device view as soon as it is ready and again as ticket pages
// arrive. `partial` is true if any source hit its page cap.
export async function loadCrewReport(onProgress, onRows) {
  const config = await invoke('getCrewReportConfig');
  const crew = await pageAll('getCrewPage', 'cursor', MAX_CREW_CALLS, (n) => onProgress?.(`Loading crew… ${n.toLocaleString()}`));
  const assets = await pageAll('getCrewAssetPage', 'cursor', MAX_ASSET_CALLS, (n) => onProgress?.(`Loading crew devices… ${n.toLocaleString()}`));
  const build = (issues) => buildCrewReport({ crewRows: crew.items, assets: assets.items, issues, crewCodeFieldId: config.crewCodeFieldId, assetFieldId: config.assetFieldId });
  onRows?.(build([]));
  const tickets = await pageAll('getCrewTicketPage', 'nextPageToken', MAX_TICKET_CALLS, (n, items) => { onProgress?.(`Loading crew tickets… ${n.toLocaleString()}`); onRows?.(build(items)); });
  return {
    rows: buildCrewReport({ crewRows: crew.items, assets: assets.items, issues: tickets.items, crewCodeFieldId: config.crewCodeFieldId, assetFieldId: config.assetFieldId }),
    partial: crew.partial || assets.partial || tickets.partial
  };
}
