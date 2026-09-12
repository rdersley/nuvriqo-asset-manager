import fs from 'node:fs';

const manifest = fs.readFileSync(new URL('../manifest.marketplace.yml', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const failures = [];
const mustContain = [
  'jira:globalPage:',
  'jira:issuePanel:',
  'jira:customField:',
  'jiraServiceManagement:portalUserMenuAction:',
  'storage:app',
  'read:jira-work'
];
for (const token of mustContain) if (!manifest.includes(token)) failures.push(`Marketplace manifest is missing ${token}`);

const forbidden = [
  'nuvriqo-internal-asset-operations',
  'Internal Asset Operations',
  'Crew Tracking',
  'Device Usage Reconciliation',
  'crew-static',
  'handler: crew.handler',
  'vPOS',
  'Ryanair',
  'retailinmotion'
];
for (const token of forbidden) if (manifest.toLowerCase().includes(token.toLowerCase())) failures.push(`Marketplace manifest contains internal-only token: ${token}`);

const unnecessaryMarketplaceScopes = ['read:application-role:jira', 'read:group:jira'];
for (const scope of unnecessaryMarketplaceScopes) if (manifest.includes(scope)) failures.push(`Marketplace manifest contains unnecessary scope: ${scope}`);

if (!/^0\.9\./.test(packageJson.version) && packageJson.version !== '1.0.0') failures.push(`Unexpected release version ${packageJson.version}`);
if (!readme.includes('Marketplace edition')) failures.push('README must document the Marketplace/internal edition split.');

if (failures.length) {
  console.error('Marketplace release verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Marketplace release verification passed.');
