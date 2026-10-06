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
// figures yet (run the Jira scan); `partial` is true if the register was cut short.
const MAX_REPORT_PAGES = 50;
export async function loadFullReport(onProgress) {
  const assets = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await invoke('getReportPage', { cursor });
    assets.push(...(page?.items || []));
    cursor = page?.nextCursor || null;
    pages += 1;
    onProgress?.(`Loading devices… ${assets.length.toLocaleString()} so far`);
  } while (cursor && pages < MAX_REPORT_PAGES);
  const reports = assets.map(reportRowFromSummary).filter(Boolean);
  return { assets, reports, unscanned: assets.length - reports.length, partial: Boolean(cursor) };
}
