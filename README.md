# Nuvriqo Asset Manager

A deliberately simple asset and device manager for Jira and Jira Service Management.

> Assets without the CMDB.

## V1 release scope

The current V1 release candidate includes:

- Forge global page for the asset register, overview and reporting
- Manual create, edit and protected delete flows
- Mandatory, case-insensitive unique Device Name validation
- CSV and Excel `.xlsx` bulk import with preview and validation
- CSV export, search and filters
- Jira/JSM user search for optional holder identity
- Configurable asset types, statuses, locations and text/date custom fields
- Configurable Jira mappings for Device ID, related device, client, location, device type, device fault and assignment reference
- Resumable Jira Device ID discovery designed for production-sized sites
- Strong Device ID validation to reject placeholder or malformed values
- Assignment, Device Name, status and location history
- Asset detail, activity timeline and historical fault ledger
- Jira issue panel for linking a ticket to a device
- Jira `Device` custom field with a Device Name picker
- Device custom-field values retain the internal asset ID while displaying the friendly Device Name
- Per-device Jira support/fault history and latest-fault indicators
- Fleet-level reporting and CSV report export
- JSM portal organisation device view
- Safe, batched cleanup of Jira-discovered records
- Scale guards on KVS and Jira pagination paths so normal screens do not perform unlimited scans
- GitHub Actions validation, regression simulation, Forge lint, live Jira smoke tests and automatic development deployment

## Marketplace edition

This repository is the Nuvriqo Marketplace edition only. `manifest.yml` is the customer-facing Marketplace manifest; it has no organisation-specific modules (crew tracking, device usage reconciliation, SOTI sync or the Portal+ snapshot publisher). Organisation-specific editions are maintained in their own repositories and Forge apps.

CI validates every change. The Marketplace candidate is deployed to Forge staging on `nuvriqo.atlassian.net` by the Marketplace final test workflow, and to Forge production only by the manual release workflow after the final acceptance gate in `RELEASE_CHECKLIST.md` is complete. Before a production deployment, run:

```bash
npm run verify:marketplace
npm run build
```

### Licensing

The Marketplace edition is a paid app: `manifest.yml` sets `app.licensing.enabled: true`. Every Marketplace resolver checks the licence from the Forge invocation context (no extra Jira or storage calls). In the Forge production environment a missing or inactive licence is refused and the screens show an "Asset Manager licence inactive" message; asset data is kept. Development and staging installations are never blocked. `npm run verify:marketplace` fails if licensing is not enabled, if a Marketplace resolver is not licence-wrapped, or if an internal-only module (`crew.js`, `soti.js`, `portal-plus-publisher.js`, `portal-plus-refresh.js`) is present.

## Limits

Resolvers are bounded so one call stays inside Forge execution time and per-installation rate limits on large sites. The caps customers can notice:

- **Per-prefix storage reads: 1,000 records.** The shared `queryAllByPrefix` helper reads at most 1,000 records for one key prefix in a single call. This bounds, for example, the activity history and fault history shown for one asset, and the number of distinct indexed clients offered as client options.
- **Client options: 10 storage pages.** `getJiraClientOptions` combines up to 1,000 indexed client values with client values read from at most 10 pages of the asset register (100 assets per page, so the first 1,000 assets). On larger registers a client that appears only on assets outside that window, and is not in the client index, is not offered in the Client filter or picker.
- **Device search: 2,000 assets.** Substring search in the Device field scans at most 20 pages (2,000 assets). An exact Device Name or Jira Device ID match is always found by key.

## Asset model

Core fields include internal asset ID, unique Device Name, authoritative Jira Device ID, client, type, manufacturer, model, serial number, optional Jira/JSM account identity, free-text holder/assignment reference, status, location, purchase date, warranty expiry, notes and configurable custom fields.

## Storage model

- `asset:<id>` — asset records
- `asset-name:<normalised-name>` — unique Device Name index
- `issue-link:<issueKey>` — issue-to-asset links
- `asset-history:<assetId>:<timestamp>:<id>` — asset activity history
- `fault-history:<assetId>:...` — historical fault records
- `settings:asset-manager` — admin configuration

Assignment data is kept in Forge app storage rather than Jira entity properties.

## Import headings

The general asset importer recognises common headings including `Device Name`, `Name`, `Device ID`, `Type`, `Manufacturer`, `Model`, `Serial Number`, `Assigned To`, `Assigned Person / Holder`, `Crew Code`, `Status`, `Location`, `Purchase Date`, `Warranty Expiry` and `Notes`.

Device Name is required. Duplicate Device Names are rejected both within an import file and against the existing asset register.

## Release gate

The V1 code scope is not considered Marketplace-ready simply because CI is green. Before promoting to `1.0.0` we require all of the following:

1. Full CI validation and Forge lint pass on the exact release candidate.
2. Staging deployment and install/upgrade on the Nuvriqo test site succeed.
3. Post-deploy Jira smoke tests pass.
4. Browser acceptance confirms Overview, Assets, Imports, Reports and Configuration render correctly.
5. Large-data checks confirm no Forge-limit errors on the production-sized copied dataset.
6. Jira Device ID cleanup and resumable scan complete safely.
7. The Marketplace manifest passes `npm run verify:marketplace` and contains no internal-only modules or terminology.
8. Marketplace documentation, privacy/security answers, support details, branding assets and screenshots are final.
9. Only then promote the package to `1.0.0`, tag the exact tested commit and deploy `manifest.yml` to Forge production.

## Post-V1 roadmap

Items that should not delay V1 include optional SOTI MobiControl integration, deeper portal workflows, richer CMDB-style relationships and destructive/device-management actions.
