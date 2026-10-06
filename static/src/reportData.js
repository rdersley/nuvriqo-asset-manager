import { invoke } from './invoke.js';

// getAssetReport handles at most this many assets per call (REPORT_BATCH in src/index.js).
const BATCH = 100;
// Kept low: Forge rate-limits invocations per installation.
const CONCURRENCY = 2;

// Runs getAssetReport for each batch with a few calls in flight. A failed or truncated
// batch marks the result partial instead of failing the whole report.
async function reportRowsFor(batches, onBatch, { recordHistory = true } = {}) {
  const rows = [];
  let partial = false;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const result = await invoke('getAssetReport', { assetIds: batch.map((asset) => asset.id), recordHistory });
        rows.push(...(result?.rows || []));
        if (result?.truncated) partial = true;
      } catch {
        partial = true;
      }
      onBatch?.(batch.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return { rows, partial };
}

// Report rows for assets already on screen (the asset list's Fault column).
export async function loadReportRows(assets) {
  const batches = [];
  for (let i = 0; i < assets.length; i += BATCH) batches.push(assets.slice(i, i + BATCH));
  return reportRowsFor(batches, undefined, { recordHistory: false });
}

// A report row in getAssetReport's shape, from the fault figures the Jira scan saved on the
// device. Null when the scan hasn't reached the device yet.
export function reportRowFromSummary(asset) {
  const f = asset?.faultSummary;
  if (!f) return null;
  return {
    assetId: asset.id, name: asset.name, type: asset.type, status: asset.status, assigneeName: asset.assigneeName || asset.crewCode || '',
    total: f.total || 0, open: f.open || 0, resolved: f.resolved || 0, related: f.related || 0, involved: f.involved || 0, lastFault: f.lastFault || '',
    latestFault: f.latestFaultKey ? { key: f.latestFaultKey, fault: f.latestFault || '', summary: '' } : null, error: false
  };
}

// Every asset in the register with its report row, read from the fault figures saved by the Jira
// scan: about one call per 2,000 devices and no Jira search. `unscanned` counts devices with no
// figures yet (run the Jira scan), `lastScan` when the last full scan finished; `partial` is
// true if the register was cut short.
const MAX_REPORT_PAGES = 50;
export async function loadFullReport(onProgress) {
  const assets = [];
  let cursor = null;
  let pages = 0;
  let scan = null;
  do {
    const page = await invoke('getReportPage', { cursor });
    if (page?.scan) scan = page.scan;
    assets.push(...(page?.items || []));
    cursor = page?.nextCursor || null;
    pages += 1;
    onProgress?.(`Loading devices… ${assets.length.toLocaleString()} so far`);
  } while (cursor && pages < MAX_REPORT_PAGES);
  // Once a full Jira scan has finished (since repeat faults were counted), every device with a
  // ticket has figures, so one without has no tickets. Until then they need the scan to run.
  const scanned = Boolean(scan?.complete);
  const noTickets = { total: 0, open: 0, resolved: 0, related: 0, involved: 0, lastFault: '', repeats: [] };
  const reports = assets.map((a) => reportRowFromSummary(scanned && !a.faultSummary ? { ...a, faultSummary: noTickets } : a)).filter(Boolean);
  const unscanned = scanned ? 0 : assets.filter((a) => !Array.isArray(a.faultSummary?.repeats)).length;
  return { assets, reports, unscanned, lastScan: scan?.timestamp || '', partial: Boolean(cursor) };
}

// One row per device and fault that came up at least `min` times (the same Device Fault value,
// ignoring case and spacing), most times first.
export function repeatFaultRows(assets = [], min = 2) {
  const rows = [];
  for (const a of assets) {
    for (const r of a?.faultSummary?.repeats || []) {
      if (r.count < min) continue;
      rows.push({ assetId: a.id, name: a.name || '', deviceId: a.jiraIdentifier || a.name || '', type: a.type || '', holder: a.assigneeName || a.crewCode || '', location: a.location || '', fault: r.fault, count: r.count, open: r.open || 0, first: r.first || '', last: r.last || '', keys: r.keys || [] });
    }
  }
  return rows.sort((x, y) => y.count - x.count || String(y.last).localeCompare(String(x.last)) || x.name.localeCompare(y.name));
}
