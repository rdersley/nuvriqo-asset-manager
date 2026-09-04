# Nuvriqo Asset Manager

A deliberately simple asset and device manager for Jira and Jira Service Management.

> Assets without the CMDB.

## Initial V1 build

Core implementation now includes:

- Forge global page for the asset register
- Manual Add Asset and Edit Asset screens
- Mandatory, case-insensitive unique Device Name validation
- CSV and Excel `.xlsx` bulk import
- Import preview and validation before assets are created
- CSV export
- Search and filters
- Jira user search/autocomplete for assignment
- Configurable asset types, statuses and locations
- Configurable text/date custom asset fields
- Assignment, Device Name, status and location history
- Asset detail and activity timeline
- Jira issue panel for linking a ticket to a device
- Jira `Device` custom field with a Device Name-only picker
- Device custom field object value retains the internal asset ID while displaying only the Device Name
- Per-device Jira fault/support history with status, type, priority, assignee, created and resolved dates
- Per-device fault KPIs for total, open, resolved, 30-day and 90-day activity
- Fleet-level Asset Reporting ranked by fault count, including repeat-problem devices
- Asset report CSV export
- Jira ticket history pagination using the current `nextPageToken` search API
- Deletion protection for both legacy issue links and Device custom-field ticket relationships
- Paginated Forge KVS reads for larger registers
- GitHub Actions build validation for the main UI and Device field UI
- Authenticated Forge lint in GitHub Actions

## Asset model

Core fields are internal asset ID, unique Device Name, type, manufacturer, model, serial number, assigned Jira user, status, location, purchase date, warranty expiry, notes and configurable custom fields.

## Storage model

- `asset:<id>` — asset records
- `asset-name:<normalised-name>` — unique Device Name index
- `issue-link:<issueKey>` — legacy issue-to-asset link records
- `asset-history:<assetId>:<timestamp>:<id>` — asset activity history
- `settings:asset-manager` — admin configuration

Personal assignment data is kept in Forge app storage rather than Jira entity properties.

## Import headings

The importer recognises common headings including `Device Name`, `Name`, `Type`, `Manufacturer`, `Model`, `Serial Number`, `Assigned To`, `Status`, `Location`, `Purchase Date`, `Warranty Expiry` and `Notes`.

Device Name is required. Duplicate Device Names are rejected both within an import file and against the existing asset register.

## First deployment gate

The V1 code scope is complete when CI is green. Before promoting to `1.0.0`:

1. Run or confirm authenticated Forge lint.
2. Deploy the current `main` branch to the Forge development environment.
3. Install or upgrade on the Nuvriqo Jira site.
4. Perform the live smoke tests in `RELEASE_CHECKLIST.md`.
5. Fix any release-blocking defect discovered in the real Jira environment.
6. Promote the package to `1.0.0` only after that live gate passes.

## Deliberately later

The JSM portal device picker and portal request detail experience are intentionally deferred until after the core V1 is stable. V1 also avoids CMDB schemas, dependency maps, discovery and AQL-style querying.

A future V2 can add optional SOTI MobiControl integration without changing the deliberately simple V1 asset-management model.
