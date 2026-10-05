import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeviceTimeline, bulkCandidate, latestReporterRun, dateOnly } from '../src/device-timeline.js';

const t = (key, crewCode, created, extra = {}) => ({ key, crewCode, created, relation: 'primary', ...extra });

test('the latest run stops at the first ticket under another crew code and ignores related tickets', () => {
  const run = latestReporterRun([t('A-1', 'C1', '2026-01-01'), t('A-4', 'c2', '2026-04-01'), t('A-3', 'C2', '2026-03-01'), t('A-5', 'C9', '2026-05-01', { relation: 'related' }), t('A-2', '', '2026-02-15')]);
  assert.deepEqual(run, { crewCode: 'c2', count: 2, since: '2026-03-01', until: '2026-04-01', issueKeys: ['A-4', 'A-3'] });
  assert.equal(latestReporterRun([t('A-1', '', '2026-01-01')]), null);
});

test('a bulk candidate needs enough tickets, a recent enough one, and a different person', () => {
  const tickets = [t('A-2', 'C2', '2026-04-01'), t('A-1', 'C2', '2026-03-01')];
  assert.equal(bulkCandidate({ crewCode: 'C1' }, tickets, { minTickets: 2 }).crewCode, 'C2');
  assert.equal(bulkCandidate({ crewCode: 'C1' }, tickets, { minTickets: 3 }), null);
  assert.equal(bulkCandidate({ crewCode: 'C1' }, tickets, { minTickets: 2, since: '2026-05-01' }), null);
  assert.equal(bulkCandidate({ crewCode: 'c2' }, tickets, { minTickets: 1 }), null);
});

test('the timeline merges tickets and holder changes newest first, with base, and counts reports since assignment', () => {
  const asset = { crewCode: 'C1', assigneeName: 'Anna', assignedAt: '2026-02-01' };
  const history = [{ type: 'updated', timestamp: '2026-02-01T09:00:00Z', message: 'Asset updated', changes: [{ field: 'assigned person', from: 'Ben', to: 'Anna' }] }, { type: 'updated', timestamp: '2026-02-05T09:00:00Z', changes: [{ field: 'location', from: 'DUB', to: 'STN' }] }];
  const tl = buildDeviceTimeline(asset, [t('A-1', 'C2', '2026-01-10'), t('A-2', 'C2', '2026-03-01', { base: 'STN' }), t('A-3', 'C1', '2026-04-01')], history);
  assert.deepEqual(tl.events.map((e) => e.key || e.kind), ['A-3', 'A-2', 'holder', 'A-1']);
  assert.equal(tl.events[1].base, 'STN');
  assert.equal(tl.otherReportsSinceAssigned, 1);
  assert.equal(tl.latestMatchesHolder, true);
  assert.equal(dateOnly('2026-03-04T10:20:00.000+0000'), '2026-03-04');
});

test('creation entries are left out, except a device created as a replacement', () => {
  const history = [{ type: 'created', source: 'jira-sync', timestamp: '2026-10-05T00:00:00Z', message: 'Asset discovered from Jira' }, { type: 'created', source: 'ticket-replacement', timestamp: '2026-10-04T00:00:00Z', message: 'Created as the replacement for X on HW-1' }];
  assert.deepEqual(buildDeviceTimeline({}, [], history).events.map((e) => e.message), ['Created as the replacement for X on HW-1']);
});
