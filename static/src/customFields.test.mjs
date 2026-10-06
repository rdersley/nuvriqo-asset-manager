import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomFields } from './customFields.js';

test('a plain name is a text field, with a key made from it', () => {
  assert.deepEqual(parseCustomFields('Asset owner\nIMEI 2'), [{ key: 'assetOwner', label: 'Asset owner', type: 'text' }, { key: 'imei2', label: 'IMEI 2', type: 'text' }]);
});

test('label | type, key | label, and the full form all work; blanks and repeats are dropped', () => {
  assert.deepEqual(parseCustomFields('Handover date | date\nowner | Asset owner\n\nsim | SIM number | text\nsim | Again | text\nNotes | weird'), [
    { key: 'handoverDate', label: 'Handover date', type: 'date' },
    { key: 'owner', label: 'Asset owner', type: 'text' },
    { key: 'sim', label: 'SIM number', type: 'text' },
    { key: 'Notes', label: 'weird', type: 'text' }
  ]);
});
