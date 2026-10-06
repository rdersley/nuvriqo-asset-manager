import fs from 'node:fs';

const manifest = fs.readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
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

// Paid listing: Forge only passes context.license when licensing is enabled in the descriptor.
if (!/^app:\s*\n(?:[ \t]+.*\n)*?[ \t]+licensing:\s*\n[ \t]+enabled:\s*true\b/m.test(manifest)) failures.push('Marketplace manifest must set app.licensing.enabled: true.');

// Every Marketplace function must enforce the licence. This repository is the Marketplace edition
// only: the internal-only modules live in a separate internal repository and must not come back.
const INTERNAL_ONLY_MODULES = ['crew.js', 'portal-plus-publisher.js', 'portal-plus-refresh.js', 'soti.js'];
const srcFile = (name) => new URL(`../src/${name}`, import.meta.url);
const handlerFiles = [...manifest.matchAll(/handler:\s*([\w-]+)\.handler/g)].map((m) => `${m[1]}.js`);
if (!handlerFiles.length) failures.push('Marketplace manifest declares no function handlers.');
const importsOf = (name) => [...fs.readFileSync(srcFile(name), 'utf8').matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*)['"]\.\/([\w.-]+)['"]/g)].map((m) => m[1]);
const seen = new Set();
const walk = (name, from) => {
  if (INTERNAL_ONLY_MODULES.includes(name)) failures.push(`${from} pulls in internal-only module src/${name}`);
  if (seen.has(name)) return;
  seen.add(name);
  if (!fs.existsSync(srcFile(name))) { failures.push(`Marketplace module src/${name} does not exist`); return; }
  for (const dep of importsOf(name)) walk(dep, `src/${name}`);
};
for (const file of handlerFiles) {
  walk(file, 'manifest.yml');
  if (fs.existsSync(srcFile(file)) && !/licensedResolver\(new Resolver\(\)\)/.test(fs.readFileSync(srcFile(file), 'utf8'))) failures.push(`src/${file} must wrap its resolver with licensedResolver()`);
}
for (const module of INTERNAL_ONLY_MODULES) if (fs.existsSync(srcFile(module))) failures.push(`src/${module} is internal-only and must not be in the Marketplace repository`);
for (const path of ['manifest.marketplace.yml', 'crew-static']) if (fs.existsSync(new URL(`../${path}`, import.meta.url))) failures.push(`${path} belongs to the old two-edition layout; manifest.yml is the Marketplace manifest`);

if (!/^0\.9\./.test(packageJson.version) && packageJson.version !== '1.0.0') failures.push(`Unexpected release version ${packageJson.version}`);
if (!readme.includes('Marketplace edition')) failures.push('README must document the Marketplace/internal edition split.');

if (failures.length) {
  console.error('Marketplace release verification failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Marketplace release verification passed.');
