import test from 'node:test';
import assert from 'node:assert/strict';
import { retryBusyRows, nextImportPause } from './importRetry.js';

const BUSY = 'There was an error invoking the function - Limits for the current installation have been exceeded';
const rows = ['A', 'B', 'C', 'D'].map((name) => ({ name }));
const noWait = { wait: async () => {} };

test('rows turned away as busy are sent again; other failures are kept', async () => {
  const sent = [];
  const result = await retryBusyRows(rows, [{ index: 1, error: BUSY }, { index: 2, error: 'Device Name already exists.' }, { index: 3, error: BUSY }], async (batch) => { sent.push(batch.map((r) => r.name)); return { created: batch.length, failed: [] }; }, noWait);
  assert.deepEqual(sent, [['B', 'D']]);
  assert.equal(result.created, 2);
  assert.deepEqual(result.failed, [{ index: 2, error: 'Device Name already exists.' }]);
});

test('rows still busy are tried again, then reported with their original row index', async () => {
  let calls = 0;
  const result = await retryBusyRows(rows, [{ index: 0, error: BUSY }, { index: 3, error: BUSY }], async (batch) => {
    calls += 1;
    return calls === 1 ? { created: 1, failed: [{ index: 1, error: BUSY }] } : { created: 0, failed: [{ index: 0, error: BUSY }] };
  }, { ...noWait, delays: [1, 1] });
  assert.equal(result.created, 1);
  assert.deepEqual(result.failed, [{ index: 3, error: BUSY }]);
});

test('nothing is sent when no row was busy', async () => {
  const result = await retryBusyRows(rows, [{ index: 0, error: 'Device Name is required.' }], async () => { throw new Error('should not be called'); }, noWait);
  assert.equal(result.failed.length, 1);
});

test('the import slows down while rows are turned away and speeds up again after', () => {
  let pause = 0;
  pause = nextImportPause(pause, 3); assert.equal(pause, 2000);
  pause = nextImportPause(pause, 1); assert.equal(pause, 4000);
  for (let i = 0; i < 5; i += 1) pause = nextImportPause(pause, 2);
  assert.equal(pause, 20000, 'never more than 20s');
  pause = nextImportPause(pause, 0); assert.equal(pause, 10000);
  pause = nextImportPause(nextImportPause(nextImportPause(nextImportPause(nextImportPause(pause, 0), 0), 0), 0), 0);
  assert.equal(pause, 0);
});
