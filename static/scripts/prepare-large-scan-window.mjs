import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

// Jira discovery is resumable server-side and now processes 25 Jira tickets per
// Forge invocation. Allow the browser-driven scan to continue across a much larger
// window so estates with thousands of devices do not stop early.
// 800 continuation pages + the initial page covers roughly 20,000 Jira tickets
// while each individual Forge invocation remains deliberately small.
if (src.includes('guard<50')) {
  src = src.replaceAll('guard<50', 'guard<800');
} else if (src.includes('guard<20')) {
  src = src.replaceAll('guard<20', 'guard<800');
} else if (src.includes('guard<200')) {
  src = src.replaceAll('guard<200', 'guard<800');
} else if (!src.includes('guard<800')) {
  throw new Error('Could not locate Jira scan continuation guard.');
}

fs.writeFileSync(path, src);
console.log('Prepared large Jira discovery scan window (up to ~20,000 tickets per run).');
