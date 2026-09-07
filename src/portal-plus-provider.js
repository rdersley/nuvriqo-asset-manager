export const PORTAL_PLUS_ASSET_CONTRACT_VERSION = 1;

const safe = (value, fallback = '') => value == null ? fallback : String(value);
const safeArray = (value) => Array.isArray(value) ? value : [];

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
