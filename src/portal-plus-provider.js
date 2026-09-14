export const PORTAL_PLUS_ASSET_CONTRACT_VERSION = 1;
export const PORTAL_PLUS_ASSET_PROPERTY_KEY = 'nuvriqo.asset-manager.portal';

const safe = (value, fallback = '') => value == null ? fallback : String(value);
const safeArray = (value) => Array.isArray(value) ? value : [];

function safeAsset(asset = {}) {
  return {
    id: safe(asset?.id),
    deviceId: safe(asset?.deviceId),
    name: safe(asset?.name || asset?.deviceId || 'Asset'),
    type: safe(asset?.type),
    manufacturer: safe(asset?.manufacturer),
    model: safe(asset?.model),
    holder: safe(asset?.holder),
    status: safe(asset?.status),
    location: safe(asset?.location)
  };
}

export function buildPortalPlusProjectSnapshot({ projectId = '', organisations = [], assets = [], updatedAt = new Date().toISOString(), portalUrl = '' } = {}) {
  const orgs = safeArray(organisations).map((org) => ({ id: safe(org?.id), name: safe(org?.name) })).filter((org) => org.id && org.name);
  const byName = new Map(orgs.map((org) => [org.name.toLocaleLowerCase('en'), org]));
  const groups = new Map(orgs.map((org) => [org.id, { id: org.id, name: org.name, assets: [] }]));

  for (const asset of safeArray(assets)) {
    const clean = safeAsset(asset);
    if (!clean.id) continue;
    const seen = new Set();
    for (const name of safeArray(asset?.organisationNames).map(String)) {
      const org = byName.get(name.toLocaleLowerCase('en'));
      if (!org || seen.has(org.id)) continue;
      seen.add(org.id);
      groups.get(org.id)?.assets.push(clean);
    }
  }

  return {
    provider: 'nuvriqo-asset-manager',
    contractVersion: PORTAL_PLUS_ASSET_CONTRACT_VERSION,
    projectId: safe(projectId),
    updatedAt: safe(updatedAt),
    portalUrl: safe(portalUrl),
    organisations: [...groups.values()].map((group) => ({ ...group, assets: group.assets.slice(0, 100) }))
  };
}

export function buildPortalPlusAssetModule({ assets = [], configured = true, reason = '' } = {}) {
  const rows = safeArray(assets).slice(0, 50).map((asset) => ({
    id: safe(asset?.id),
    title: safe(asset?.name || asset?.deviceId || 'Asset'),
    subtitle: [safe(asset?.type), safe(asset?.manufacturer), safe(asset?.model)].filter(Boolean).join(' · '),
    status: safe(asset?.status),
    url: '',
    badge: safe(asset?.deviceId),
    metadata: {
      deviceId: safe(asset?.deviceId),
      type: safe(asset?.type),
      manufacturer: safe(asset?.manufacturer),
      model: safe(asset?.model),
      holder: safe(asset?.holder),
      location: safe(asset?.location),
      organisationNames: safeArray(asset?.organisationNames).map(String).slice(0, 10)
    }
  }));

  const inService = rows.filter((row) => /active|assigned|in service|deployed/i.test(row.status)).length;
  const attention = rows.filter((row) => /repair|fault|damaged|lost|missing|retired/i.test(row.status)).length;

  return {
    contractVersion: PORTAL_PLUS_ASSET_CONTRACT_VERSION,
    id: 'assets',
    provider: 'nuvriqo-asset-manager',
    version: 1,
    title: 'My Assets',
    description: configured ? 'Assets assigned to you or your organisation.' : safe(reason, 'Asset Manager is not configured.'),
    enabled: configured,
    priority: 30,
    counters: [
      { id: 'assigned', label: 'Visible assets', value: rows.length, tone: 'neutral' },
      { id: 'in-service', label: 'In service', value: inService, tone: 'positive' },
      { id: 'attention', label: 'Needs attention', value: attention, tone: attention ? 'attention' : 'neutral' }
    ],
    actions: rows.length ? [{ id: 'view-assets', label: 'View my assets', description: 'See devices and equipment linked to your organisation.', url: '' }] : [],
    items: rows.slice(0, 20),
    health: { available: configured, status: configured ? 'available' : 'not-configured', message: safe(reason) },
    metadata: { total: rows.length, source: 'nuvriqo-asset-manager', privacyModel: 'customer-organisation-scoped' }
  };
}
