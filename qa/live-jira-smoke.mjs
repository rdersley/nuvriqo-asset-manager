import assert from 'node:assert/strict';

const site = process.env.FORGE_SITE || 'retailinmotion-sandbox1.atlassian.net';
const email = process.env.FORGE_EMAIL;
const token = process.env.FORGE_API_TOKEN;
assert.ok(email && token, 'FORGE_EMAIL and FORGE_API_TOKEN are required for live Jira smoke tests.');

const base = `https://${site}`;
const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
const headers = { Accept: 'application/json', Authorization: auth };

async function jira(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const normalise = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const validIdentifier = (value) => {
  const v = normalise(value);
  return Boolean(v && !['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'].includes(v));
};
function fieldValues(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(fieldValues);
  if (typeof value === 'string' || typeof value === 'number') return [String(value).trim()].filter(Boolean);
  if (typeof value === 'object') {
    const candidate = value.value ?? value.name ?? value.label ?? value.displayName ?? value.objectKey ?? value.key;
    return candidate ? [String(candidate).trim()] : [];
  }
  return [];
}

console.log(`Running read-only Jira smoke tests against ${site}`);
const myself = await jira('/rest/api/3/myself');
assert.ok(myself?.accountId, 'Jira authentication succeeded but no accountId was returned.');
console.log(`Authenticated as ${myself.displayName || myself.accountId}`);

const fields = await jira('/rest/api/3/field');
assert.ok(Array.isArray(fields), 'Jira field endpoint did not return an array.');
assert.ok(fields.length > 0, 'Jira field endpoint returned no fields.');
const customFields = fields.filter((field) => String(field.id || '').startsWith('customfield_'));
console.log(`Jira field discovery is healthy. Found ${fields.length} fields (${customFields.length} custom-field ids).`);

const search = await jira('/rest/api/3/search/jql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jql: 'created >= -3650d ORDER BY created DESC',
    fields: ['summary', 'status'],
    maxResults: 5
  })
});
assert.ok(Array.isArray(search?.issues), 'Jira search did not return an issues array.');
for (const issue of search.issues) assert.ok(issue.key, 'Returned Jira issue is missing a key.');
console.log(`Jira enhanced search is healthy. Sample issues returned: ${search.issues.length}`);

const likelyAssetFields = fields.filter((field) => /asset|device|hardware|serial/i.test(String(field.name || '')));
console.log(`Potential asset/device fields visible to the app: ${likelyAssetFields.map((f) => `${f.name} (${f.id})`).join(', ') || 'none'}`);

// Release audit: exercise the exact paginated enhanced-search pattern used by Asset Manager.
// Prefer an exact "Device ID" field, otherwise allow an explicit CI override.
const requestedAssetFieldId = process.env.ASSET_FIELD_ID || '';
const deviceIdField = customFields.find((field) => field.id === requestedAssetFieldId)
  || customFields.find((field) => normalise(field.name) === 'device id');
if (deviceIdField) {
  const numericId = String(deviceIdField.id).replace('customfield_', '');
  const issues = [];
  let nextPageToken;
  let pages = 0;
  const seenPageTokens = new Set();
  do {
    const body = {
      jql: `cf[${numericId}] is not EMPTY ORDER BY created DESC`,
      fields: [deviceIdField.id],
      maxResults: 100
    };
    if (nextPageToken) {
      if (seenPageTokens.has(nextPageToken)) throw new Error('Device ID audit pagination repeated a nextPageToken; pagination is looping.');
      seenPageTokens.add(nextPageToken);
      body.nextPageToken = nextPageToken;
    }
    const page = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.ok(Array.isArray(page?.issues), 'Device ID audit search did not return an issues array.');
    issues.push(...page.issues);
    nextPageToken = page.nextPageToken || null;
    pages += 1;
    if (pages > 500) throw new Error('Device ID audit exceeded 500 pages; aborting the release audit as a safety guard.');
  } while (nextPageToken);

  const identifiers = issues.flatMap((issue) => fieldValues(issue.fields?.[deviceIdField.id]));
  const valid = identifiers.filter(validIdentifier);
  const unique = new Map();
  for (const identifier of valid) {
    const key = normalise(identifier);
    if (!unique.has(key)) unique.set(key, identifier);
  }
  const invalid = identifiers.filter((identifier) => !validIdentifier(identifier));
  console.log(`DEVICE_ID_AUDIT field=${deviceIdField.name} (${deviceIdField.id}) pages=${pages} issues=${issues.length} values=${identifiers.length} valid=${valid.length} uniqueValid=${unique.size} invalid=${invalid.length}`);
  if (invalid.length) console.log(`DEVICE_ID_AUDIT invalid samples: ${[...new Set(invalid)].slice(0, 10).join(', ')}`);
} else {
  console.log('DEVICE_ID_AUDIT skipped: no exact Device ID custom field was found.');
}

console.log('Live Jira smoke tests passed.');
