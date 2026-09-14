import fs from 'node:fs';
import path from 'node:path';

const encoded = process.env.PLAYWRIGHT_STORAGE_STATE_B64 || '';
if (!encoded) {
  console.error('PLAYWRIGHT_STORAGE_STATE_B64 is not configured.');
  process.exit(2);
}

const dir = path.resolve('qa/.auth');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'state.json');
fs.writeFileSync(target, Buffer.from(encoded, 'base64'));
console.log(`Playwright storage state written to ${target}`);
