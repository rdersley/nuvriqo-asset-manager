import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortalPlusAssetModule, buildPortalPlusProjectSnapshot, PORTAL_PLUS_ASSET_CONTRACT_VERSION, PORTAL_PLUS_ASSET_PROPERTY_KEY } from '../src/portal-plus-provider.js';

test('builds a Portal+ Assets module with bounded customer-safe data', () => {
  const module = buildPortalPlusAssetModule({
    configured: true,
    assets: [{
      id: 'asset-1',
      deviceId: 'DEV-001',
      name: 'Crew iPad 001',
      type: 'Tablet',
      manufacturer: 'Apple',
      model: 'iPad',
      serialNumber: 'SHOULD-NOT-BE-SHARED',
      holder: 'Crew 123',
      status: 'Assigned',
      location: 'DUB',
      organisationNames: ['Example Org']
    }]
  });

  assert.equal(module.contractVersion, PORTAL_PLUS_ASSET_CONTRACT_VERSION);
  assert.equal(module.id, 'assets');
  assert.equal(module.provider, 'nuvriqo-asset-manager');
  assert.equal(module.counters.find((x) => x.id === 'assigned').value, 1);
  assert.equal(module.items[0].title, 'Crew iPad 001');
  assert.equal(module.items[0].metadata.deviceId, 'DEV-001');
  assert.equal(module.items[0].metadata.organisationNames[0], 'Example Org');
  assert.equal('serialNumber' in module.items[0].metadata, false);
  assert.equal(JSON.stringify(module).includes('SHOULD-NOT-BE-SHARED'), false);
});

test('builds organisation-scoped project snapshot for Portal+', () => {
  const snapshot = buildPortalPlusProjectSnapshot({
    projectId: '10001',
    updatedAt: '2026-09-14T14:30:00.000Z',
    organisations: [{ id: '10', name: 'Example Org' }, { id: '20', name: 'Other Org' }],
    assets: [
      { id: 'a1', deviceId: 'DEV-1', name: 'Laptop 1', status: 'Assigned', serialNumber: 'PRIVATE', organisationNames: ['Example Org'] },
      { id: 'a2', deviceId: 'DEV-2', name: 'Tablet 2', status: 'In service', organisationNames: ['Other Org', 'Example Org'] }
    ]
  });

  assert.equal(PORTAL_PLUS_ASSET_PROPERTY_KEY, 'nuvriqo.asset-manager.portal');
  assert.equal(snapshot.provider, 'nuvriqo-asset-manager');
  assert.equal(snapshot.contractVersion, PORTAL_PLUS_ASSET_CONTRACT_VERSION);
  assert.equal(snapshot.organisations.find((x) => x.id === '10').assets.length, 2);
  assert.equal(snapshot.organisations.find((x) => x.id === '20').assets.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false);
});

test('returns disabled module when Asset Manager is not configured', () => {
  const module = buildPortalPlusAssetModule({ configured: false, reason: 'Not configured' });
  assert.equal(module.enabled, false);
  assert.equal(module.health.available, false);
  assert.equal(module.health.status, 'not-configured');
});

test('caps visible Portal+ items', () => {
  const assets = Array.from({ length: 80 }, (_, i) => ({ id: `a-${i}`, name: `Asset ${i}` }));
  const module = buildPortalPlusAssetModule({ configured: true, assets });
  assert.equal(module.metadata.total, 50);
  assert.equal(module.items.length, 20);
});
