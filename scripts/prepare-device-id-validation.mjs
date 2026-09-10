import fs from 'node:fs';

const path = new URL('../src/index.js', import.meta.url);
let src = fs.readFileSync(path, 'utf8');
const from = "const validIdentifier = (value) => {\n  const v = normaliseName(value);\n  return Boolean(v && !['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v));\n};";
const to = "const validIdentifier = (value) => {\n  const raw = String(clean(value) || '').trim();\n  const v = normaliseName(raw);\n  if (!v || ['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v)) return false;\n  if (raw.length < 4 || raw.length > 100) return false;\n  if (/^[?._\\-\\s]+$/.test(raw)) return false;\n  if (/^0+$/.test(raw)) return false;\n  if (/^\\d+$/.test(raw)) return false;\n  if (!/[a-z]/i.test(raw)) return false;\n  return true;\n};";
if (!src.includes(to)) {
  if (!src.includes(from)) throw new Error('Could not locate Device ID validation function.');
  src = src.replace(from, to);
}
fs.writeFileSync(path, src);
