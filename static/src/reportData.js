import { invoke } from './invoke.js';

// getAssetReport handles at most this many assets per call (REPORT_BATCH in src/index.js).
const BATCH = 100;
// Kept low: Forge rate-limits invocations per installation.
const CONCURRENCY = 2;
// Register pages of 500 (five KVS pages per invocation); 80 pages = 40,000 assets
// before a report is marked partial.
const ASSET_PAGE = 500;
const MAX_ASSET_PAGES = 80;

// Runs getAssetReport for each batch with a few calls in flight. A failed or truncated
// batch marks the result partial instead of failing the whole report.
async function reportRowsFor(batches, onBatch) {
  const rows = [];
  let partial = false;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      try {
        const result = await invoke('getAssetReport', { assetIds: batch.map((asset) => asset.id) });
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
  return reportRowsFor(batches);
}

// Every asset in the register plus its report row, paged so no single Forge call
// reads too much. `partial` is true if the register or any Jira search was cut short.
export async function loadFullReport(onProgress) {
  const assets = [];
  let cursor = null;
  let pages = 0;
  do {
    const page = await invoke('listAssetsPage', { cursor, limit: ASSET_PAGE, maxScanPages: ASSET_PAGE / 100 });
    assets.push(...(page?.items || []));
    cursor = page?.nextCursor || null;
    pages += 1;
    onProgress?.(`Loading assets… ${assets.length.toLocaleString()} so far`);
  } while (cursor && pages < MAX_ASSET_PAGES);

  const batches = [];
  for (let i = 0; i < assets.length; i += BATCH) batches.push(assets.slice(i, i + BATCH));
  let matched = 0;
  const { rows, partial } = await reportRowsFor(batches, (count) => {
    matched += count;
    onProgress?.(`Matching Jira tickets… ${matched.toLocaleString()} of ${assets.length.toLocaleString()} assets`);
  });
  return { assets, reports: rows, partial: partial || Boolean(cursor) };
}
