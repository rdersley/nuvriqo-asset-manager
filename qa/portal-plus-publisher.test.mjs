import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../src/portal-plus-publisher.js',import.meta.url),'utf8');

test('publishes the all-organisation snapshot through an app-scoped Jira project property',()=>{
  assert.match(source,/api\.asApp\(\)\.requestJira/);
  assert.match(source,/method:'PUT'/);
  assert.match(source,/PORTAL_PLUS_ASSET_PROPERTY_KEY/);
  assert.match(source,/buildPortalPlusProjectSnapshot/);
});

test('does not use a customer-scoped asUser transport',()=>{
  assert.doesNotMatch(source,/asUser\s*\(/);
});

test('fails closed when project id is missing or Jira rejects the write',()=>{
  assert.match(source,/Project id is required/);
  assert.match(source,/if\(!response\.ok\)/);
  assert.match(source,/Unable to publish Portal\+ asset snapshot/);
});
