import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { csvEscape, toCsv } from '../shared/csv.js';
import { readAssetImportFile } from '../static/src/importUtils.js';

test('formula-like text is neutralised with a leading apostrophe', () => {
  assert.equal(csvEscape('=HYPERLINK("http://evil","click")'), `"'=HYPERLINK(""http://evil"",""click"")"`);
  assert.equal(csvEscape('+1+1'), "'+1+1");
  assert.equal(csvEscape('-2+3'), "'-2+3");
  assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvEscape('\t=1'), "'\t=1");
  assert.equal(csvEscape('\r=1'), `"'\r=1"`);
});

test('ordinary values are unchanged and numbers are never prefixed', () => {
  assert.equal(csvEscape('RYR_WM_7'), 'RYR_WM_7');
  assert.equal(csvEscape('a=b'), 'a=b');
  assert.equal(csvEscape(-5), '-5');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
});

test('delimiters, quotes and line breaks are quoted', () => {
  assert.equal(csvEscape('Dublin, IE'), '"Dublin, IE"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape('line1\rline2'), '"line1\rline2"');
});

test('files start with a UTF-8 BOM and use CRLF rows', () => {
  const csv = toCsv(['Device Name', 'Notes'], [['Tablet 1', 'ok'], ['Tablet 2', '']]);
  assert.ok(csv.startsWith('﻿Device Name,Notes\r\n'));
  assert.equal(csv.split('\r\n').length, 3);
});

test('an export re-imports with the original values', async () => {
  const csv = toCsv(['Device Name', 'Device ID', 'Notes', 'Location'], [['=cmd|calc', '-RYR1', 'multi\nline, "quoted"', 'Dublin']]);
  const [row] = await readAssetImportFile({ name: 'export.csv', text: async () => csv });
  assert.equal(row.name, '=cmd|calc');
  assert.equal(row.jiraIdentifier, '-RYR1');
  assert.equal(row.notes, 'multi\nline, "quoted"');
  assert.equal(row.location, 'Dublin');
});

test('every built UI exports through the shared escaper', () => {
  for (const file of ['static/src/main.jsx', 'static/src/reports.jsx', 'static/src/ReportsWorkspace.jsx', 'reports-static/src/main.jsx']) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(src, /import \{ downloadCsv \} from '\.\.\/\.\.\/shared\/csv\.js';/, file);
    assert.doesNotMatch(src, /function (csvEscape|downloadCsv)\(|const esc=/, file);
  }
});
