import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import unzipFromArrayBuffer from './unzipWithoutWorkers.js';

test('unzips a workbook without a worker, keeping only the parts asked for', async () => {
  // Large enough that read-excel-file's own reader would have used a blob: Web Worker.
  const big = strToU8('<sheetData>' + 'x'.repeat(2_000_000) + '</sheetData>');
  const zip = zipSync({ 'xl/worksheets/sheet1.xml': big, 'xl/media/image1.png': new Uint8Array([1, 2, 3]) });
  const files = await unzipFromArrayBuffer(zip.buffer, { filter: ({ path }) => path.endsWith('.xml') });
  assert.deepEqual(Object.keys(files), ['xl/worksheets/sheet1.xml']);
  assert.equal(files['xl/worksheets/sheet1.xml'].length, big.length);
});

test('a file that is not a workbook is rejected with a readable message', async () => {
  await assert.rejects(unzipFromArrayBuffer(new Uint8Array([1, 2, 3, 4]).buffer), /could not be opened as an Excel workbook/);
});

test('the build swaps read-excel-file\'s worker-based unzip for this one', () => {
  assert.match(fs.readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8'), /unzipFromArrayBuffer\\\.js\$\/, replacement: .*unzipWithoutWorkers\.js/);
});
