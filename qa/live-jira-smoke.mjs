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

console.log(`Running read-only Jira smoke tests against ${site}`);
const myself = await jira('/rest/api/3/myself');
assert.ok(myself?.accountId, 'Jira authentication succeeded but no accountId was returned.');
console.log(`Authenticated as ${myself.displayName || myself.accountId}`);

const fields = await jira('/rest/api/3/field');
assert.ok(Array.isArray(fields), 'Jira field endpoint did not return an array.');
const customFields = fields.filter((field) => field.custom && field.id);
assert.ok(customFields.length > 0, 'No Jira custom fields were returned from the sandbox.');
console.log(`Jira custom-field discovery is healthy. Found ${customFields.length} custom fields.`);

const search = await jira('/rest/api/3/search/jql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jql: 'ORDER BY created DESC',
    fields: ['summary', 'status'],
    maxResults: 5
  })
});
assert.ok(Array.isArray(search?.issues), 'Jira search did not return an issues array.');
for (const issue of search.issues) assert.ok(issue.key, 'Returned Jira issue is missing a key.');
console.log(`Jira enhanced search is healthy. Sample issues returned: ${search.issues.length}`);

const likelyAssetFields = customFields.filter((field) => /asset|device|hardware|serial/i.test(String(field.name || '')));
console.log(`Potential asset/device fields visible to the app: ${likelyAssetFields.map((f) => `${f.name} (${f.id})`).join(', ') || 'none'}`);
console.log('Live Jira smoke tests passed.');
