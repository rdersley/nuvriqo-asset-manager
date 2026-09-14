import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

// Jira discovery is already resumable server-side and processes one Jira page per
// Forge invocation. Allow the browser-driven scan to continue across a much larger
// window so estates with thousands of devices do not stop after ~2,100 tickets.
// 200 continuation pages + the initial page covers up to ~20,100 Jira tickets per
// click while each individual Forge invocation remains deliberately small.
if (src.includes('guard<20')) {
  src = src.replaceAll('guard<20', 'guard<200');
} else if (!src.includes('guard<200')) {
  throw new Error('Could not locate Jira scan continuation guard.');
}

fs.writeFileSync(path, src);
console.log('Prepared large Jira discovery scan window (up to ~20,100 tickets per run).');
