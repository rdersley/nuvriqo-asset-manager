import fs from 'node:fs';

function edit(rel, transform) {
  const url = new URL(`../${rel}`, import.meta.url);
  const before = fs.readFileSync(url, 'utf8');
  const after = transform(before);
  if (after === before) console.log(`Scale guard: no change needed for ${rel}`);
  else fs.writeFileSync(url, after);
}

function replaceRequired(src, from, to, label) {
  if (src.includes(to)) return src;
  if (!src.includes(from)) throw new Error(`Scale guard could not locate ${label}`);
  return src.replace(from, to);
}

// Core resolver: no generic KVS helper may read an unlimited prefix, and legacy
// full Jira scans are capped. Resumable sync uses its own page token and is not changed.
edit('src/index.js', (input) => {
  let src = input;
  src = replaceRequired(
    src,
    "async function queryAllByPrefix(prefix) { const values = []; let cursor; do { let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100); if (cursor) query = query.cursor(cursor); const page = await query.getMany(); values.push(...page.results.map((e) => e.value)); cursor = page.nextCursor; } while (cursor); return values; }",
    "async function queryAllByPrefix(prefix,limit=500) { const values = []; let cursor; const cap=Math.max(1,Math.min(Number(limit)||500,1000)); do { let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100,cap-values.length)); if (cursor) query = query.cursor(cursor); const page = await query.getMany(); values.push(...page.results.map((e) => e.value)); cursor = page.nextCursor; } while (cursor&&values.length<cap); return values.slice(0,cap); }",
    'bounded core KVS prefix helper'
  );
  src = replaceRequired(
    src,
    "async function searchIssuesWithConfiguredAssetField(){let page=await searchIssuePageWithConfiguredAssetField();if(!page.field)return{field:null,issues:[],settings:page.settings};const issues=[...page.issues];let nextPageToken=page.nextPageToken;while(nextPageToken){page=await searchIssuePageWithConfiguredAssetField({nextPageToken});issues.push(...page.issues);nextPageToken=page.nextPageToken;}return{field:page.field,issues,settings:page.settings};}",
    "async function searchIssuesWithConfiguredAssetField(){let page=await searchIssuePageWithConfiguredAssetField();if(!page.field)return{field:null,issues:[],settings:page.settings};const issues=[...page.issues];let nextPageToken=page.nextPageToken,guard=0;while(nextPageToken&&guard<5){page=await searchIssuePageWithConfiguredAssetField({nextPageToken});issues.push(...page.issues);nextPageToken=page.nextPageToken;guard+=1;}return{field:page.field,issues,settings:page.settings,truncated:Boolean(nextPageToken)};}",
    'bounded legacy Jira issue lookup'
  );
  // Report card on the main page is deliberately a snapshot, not a fleet-wide blocking scan.
  src = src.replace("const assets=await queryAllByPrefix(ASSET_PREFIX);if(!assets.length)return[];const rows=[];", "const assets=await queryAllByPrefix(ASSET_PREFIX,100);if(!assets.length)return[];const rows=[];");
  return src;
});

edit('src/issue-panel.js', (input) => {
  let src = input;
  src = replaceRequired(
    src,
    "async function queryAllByPrefix(prefix) {\n  const values = [];\n  let cursor;\n  do {\n    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);\n    if (cursor) query = query.cursor(cursor);\n    const page = await query.getMany();\n    values.push(...page.results.map((entry) => entry.value));\n    cursor = page.nextCursor;\n  } while (cursor);\n  return values;\n}",
    "async function queryAllByPrefix(prefix, limit = 300) {\n  const values = [];\n  let cursor;\n  const cap = Math.max(1, Math.min(Number(limit) || 300, 500));\n  do {\n    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, cap - values.length));\n    if (cursor) query = query.cursor(cursor);\n    const page = await query.getMany();\n    values.push(...page.results.map((entry) => entry.value));\n    cursor = page.nextCursor;\n  } while (cursor && values.length < cap);\n  return values.slice(0, cap);\n}",
    'issue-panel KVS cap'
  );
  return src;
});

edit('src/device-split.js', (input) => {
  let src = input;
  src = replaceRequired(
    src,
    "async function queryAllByPrefix(prefix) {\n  const values = [];\n  let cursor;\n  do {\n    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);\n    if (cursor) query = query.cursor(cursor);\n    const page = await query.getMany();\n    values.push(...page.results.map((entry) => entry.value));\n    cursor = page.nextCursor;\n  } while (cursor);\n  return values;\n}",
    "async function queryAllByPrefix(prefix, limit = 500) {\n  const values = [];\n  let cursor;\n  const cap = Math.max(1, Math.min(Number(limit) || 500, 500));\n  do {\n    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(Math.min(100, cap - values.length));\n    if (cursor) query = query.cursor(cursor);\n    const page = await query.getMany();\n    values.push(...page.results.map((entry) => entry.value));\n    cursor = page.nextCursor;\n  } while (cursor && values.length < cap);\n  return values.slice(0, cap);\n}",
    'device split KVS cap'
  );
  return src;
});

edit('src/reporting.js', (input) => {
  let src = input;
  src = src.replace('async function queryAllByPrefix(prefix) {', 'async function queryAllByPrefix(prefix, limit = 500) {');
  src = src.replace('  } while (cursor);\n  return values;\n}\n\nasync function getFields()', '    if (values.length >= limit) break;\n  } while (cursor);\n  return values.slice(0, limit);\n}\n\nasync function getFields()');
  src = src.replace('for (let guard = 0; guard < 250; guard += 1)', 'for (let guard = 0; guard < 5; guard += 1)');
  return src;
});

edit('src/crew.js', (input) => {
  let src = input;
  src = replaceRequired(src, 'async function entries(prefix, limit = null) {', 'async function entries(prefix, limit = 500) {', 'crew KVS default cap');
  src = src.replace('const values = async (prefix) => (await entries(prefix)).map(e => e.value);', 'const values = async (prefix, limit = 500) => (await entries(prefix, limit)).map(e => e.value);');
  src = src.replace('  const issues = []; let nextPageToken;\n  do {', '  const issues = []; let nextPageToken; let guard=0;\n  do {');
  src = src.replace('    const data = await r.json(); issues.push(...safeArray(data.issues)); nextPageToken = data.nextPageToken || null;\n  } while (nextPageToken);', '    const data = await r.json(); issues.push(...safeArray(data.issues)); nextPageToken = data.nextPageToken || null; guard+=1;\n  } while (nextPageToken && guard<5);');
  return src;
});

edit('src/portal-assets.js', (input) => {
  let src = input;
  src = src.replace('for (let guard = 0; guard < 50; guard += 1)', 'for (let guard = 0; guard < 10; guard += 1)');
  src = src.replace('for (let guard = 0; guard < 100; guard += 1)', 'for (let guard = 0; guard < 5; guard += 1)');
  return src;
});

edit('src/ticket-sync.js', (input) => {
  let src = input;
  src = src.replace('  let cursor;\n  do {', '  let cursor;\n  let pages = 0;\n  do {\n    pages += 1;');
  src = src.replace('  } while (cursor);\n\n  return results', '  } while (cursor && pages < 5);\n\n  return results');
  return src;
});

console.log('Scale safety guards prepared.');
