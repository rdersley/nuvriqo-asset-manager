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
const assetNameField = fields.find((field) => field.custom && String(field.name || '').trim().toLowerCase() === 'asset name');
assert.ok(assetNameField?.id, 'Expected existing Jira custom field “Asset Name” was not found in the sandbox.');
console.log(`Found Asset Name field: ${assetNameField.id}`);

const numericId = String(assetNameField.id).replace('customfield_', '');
const search = await jira('/rest/api/3/search/jql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jql: `cf[${numericId}] is not EMPTY ORDER BY created DESC`,
    fields: [assetNameField.id, 'summary', 'status'],
    maxResults: 5
  })
});
assert.ok(Array.isArray(search?.issues), 'Jira search did not return an issues array.');
console.log(`Asset Name JQL is valid. Sample issues returned: ${search.issues.length}`);
for (const issue of search.issues) {
  assert.ok(issue.key, 'Returned Jira issue is missing a key.');
  assert.ok(issue.fields && Object.prototype.hasOwnProperty.call(issue.fields, assetNameField.id), `Issue ${issue.key} did not return the Asset Name field.`);
}
console.log('Live Jira smoke tests passed.');
