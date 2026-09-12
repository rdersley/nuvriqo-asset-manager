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

## Internal edition

The development/internal manifest (`manifest.yml`) also includes **Internal Asset Operations**. This contains the organisation-specific Crew Tracking and Device Usage Reconciliation tools used for internal operational imports and device/holder reconciliation.

These tools intentionally remain available on the internal development installation, but they are **not part of the public Marketplace edition**.

## Marketplace edition

`manifest.marketplace.yml` is the customer-facing Marketplace manifest. It deliberately excludes Internal Asset Operations, crew-specific imports, vPOS-specific reconciliation and their resources/handlers. This keeps the public product generic and prevents internal operational terminology or workflows from appearing for Marketplace customers.

Before a production deployment, run:

```bash
npm run verify:marketplace
npm run build:marketplace
```

The production release workflow uses the Marketplace manifest and must only be run after the final acceptance gate in `RELEASE_CHECKLIST.md` is complete.

## Asset model

Core fields include internal asset ID, unique Device Name, authoritative Jira Device ID, client, type, manufacturer, model, serial number, optional Jira/JSM account identity, free-text holder/assignment reference, status, location, purchase date, warranty expiry, notes and configurable custom fields.

## Storage model

- `asset:<id>` — asset records
- `asset-name:<normalised-name>` — unique Device Name index
- `issue-link:<issueKey>` — issue-to-asset links
- `asset-history:<assetId>:<timestamp>:<id>` — asset activity history
- `fault-history:<assetId>:...` — historical fault records
- `settings:asset-manager` — admin configuration
- internal-only prefixes are used for Crew Tracking and Device Usage Reconciliation in the development/internal edition

Assignment data is kept in Forge app storage rather than Jira entity properties.

## Import headings

The general asset importer recognises common headings including `Device Name`, `Name`, `Device ID`, `Type`, `Manufacturer`, `Model`, `Serial Number`, `Assigned To`, `Assigned Person / Holder`, `Crew Code`, `Status`, `Location`, `Purchase Date`, `Warranty Expiry` and `Notes`.

Device Name is required. Duplicate Device Names are rejected both within an import file and against the existing asset register.

## Release gate

The V1 code scope is not considered Marketplace-ready simply because CI is green. Before promoting to `1.0.0` we require all of the following:

1. Full CI validation and Forge lint pass on the exact release candidate.
2. Development deployment and sandbox install/upgrade succeed.
3. Post-deploy Jira smoke tests pass.
4. Browser acceptance confirms Overview, Assets, Imports, Reports and Configuration render correctly.
5. Large-data checks confirm no Forge-limit errors on the production-sized copied dataset.
6. Jira Device ID cleanup and resumable scan complete safely.
7. Internal Crew Tracking and Device Usage Reconciliation pass their internal acceptance checks.
8. The Marketplace manifest passes `npm run verify:marketplace` and contains no internal-only modules or terminology.
9. Marketplace documentation, privacy/security answers, support details, branding assets and screenshots are final.
10. Only then promote the package to `1.0.0`, tag the exact tested commit and deploy the Marketplace manifest to Forge production.

## Post-V1 roadmap

Items that should not delay V1 include optional SOTI MobiControl integration, deeper portal workflows, richer CMDB-style relationships and destructive/device-management actions.
