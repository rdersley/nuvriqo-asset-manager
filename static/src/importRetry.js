// Forge limits how much storage work one installation can do at a time. On a large import some
// rows come back with "Limits for the current installation have been exceeded"; nothing was
// wrong with those rows, so they are sent again after a pause instead of being reported.
export const BUSY = /Limits for the current installation have been exceeded/i;
export const isBusyFailure = (failure) => BUSY.test(String(failure?.error || ''));
export const BUSY_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// rows: the rows of the import; failed: [{ index, error }] with index into rows.
// sendBatch(rows) resolves to the reconcileAssetImport result for those rows.
// Returns the extra counts and the failures still left (indexes into rows).
export async function retryBusyRows(rows, failed, sendBatch, { delays = BUSY_RETRY_DELAYS_MS, wait = pause, batchSize = 25, onRetry } = {}) {
  const totals = { created: 0, updated: 0, merged: 0, unchanged: 0, deviceTypesAdded: [] };
  let left = failed;
  for (const delay of delays) {
    const busy = left.filter(isBusyFailure);
    if (!busy.length) break;
    onRetry?.(busy.length);
    await wait(delay);
    const still = left.filter((f) => !isBusyFailure(f));
    for (let i = 0; i < busy.length; i += batchSize) {
      const chunk = busy.slice(i, i + batchSize);
      let result;
      try { result = await sendBatch(chunk.map((f) => rows[f.index])); }
      catch (error) { still.push(...chunk.map((f) => ({ ...f, error: error?.message || f.error }))); continue; }
      totals.created += result.created || 0; totals.updated += result.updated || 0; totals.merged += result.merged || 0; totals.unchanged += result.unchanged || 0;
      totals.deviceTypesAdded.push(...(result.deviceTypesAdded || []));
      for (const f of result.failed || []) still.push({ ...f, index: chunk[f.index ?? 0].index });
    }
    left = still.sort((a, b) => a.index - b.index);
  }
  return { ...totals, failed: left };
}

// Pause before the next batch of the main import pass: doubles (from 2s, up to 20s) while Forge is
// turning rows away, and halves again once a batch goes through cleanly. Fewer rows then need the
// retry rounds at the end.
export function nextImportPause(previous, busyRows) {
  if (busyRows > 0) return Math.min(Math.max(previous * 2, 2000), 20000);
  const half = Math.floor(previous / 2);
  return half < 500 ? 0 : half;
}
