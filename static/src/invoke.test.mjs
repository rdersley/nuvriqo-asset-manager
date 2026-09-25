import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let failures = [];
let calls = 0;
mock.module('@forge/bridge', { namedExports: { invoke: async (name) => {
  calls += 1;
  const next = failures.shift();
  if (next) throw new Error(next);
  return `ok:${name}`;
} } });
const { invoke } = await import('./invoke.js');
const fast = { delays: [0, 0, 0, 0] };
const LIMIT = 'There was an error invoking the function - Limits for the current installation have been exceeded';

beforeEach(() => { failures = []; calls = 0; });

test('retries Forge installation rate-limit errors until the call succeeds', async () => {
  failures = [LIMIT, LIMIT];
  assert.equal(await invoke('previewAssetImportReconciliation', {}, fast), 'ok:previewAssetImportReconciliation');
  assert.equal(calls, 3);
});

test('gives up after the last retry and surfaces the error', async () => {
  failures = [LIMIT, LIMIT, LIMIT, LIMIT, LIMIT];
  await assert.rejects(invoke('x', {}, fast), /Limits for the current installation/);
  assert.equal(calls, 5);
});

test('does not retry other errors', async () => {
  failures = ['Only Jira administrators can perform this action.'];
  await assert.rejects(invoke('saveSettings', {}, fast), /Only Jira administrators/);
  assert.equal(calls, 1);
});
