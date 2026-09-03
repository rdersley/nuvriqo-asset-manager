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
- Linked Jira ticket history on each asset
- Jira `Device` custom field with a Device Name-only picker
- Device custom field object value retains the internal asset ID while displaying only the Device Name
- Asset delete flow
- Paginated Forge KVS reads for larger registers
- GitHub Actions build validation for the main UI and Device field UI

## Asset model

Core fields are internal asset ID, unique Device Name, type, manufacturer, model, serial number, assigned Jira user, status, location, purchase date, warranty expiry, notes and configurable custom fields.

## Storage model

- `asset:<id>` — asset records
- `asset-name:<normalised-name>` — unique Device Name index
- `issue-link:<issueKey>` — issue-to-asset link records
- `asset-history:<assetId>:<timestamp>:<id>` — asset activity history
- `settings:asset-manager` — admin configuration

Personal assignment data is kept in Forge app storage rather than Jira entity properties.

## Import headings

The importer recognises common headings including `Device Name`, `Name`, `Type`, `Manufacturer`, `Model`, `Serial Number`, `Assigned To`, `Status`, `Location`, `Purchase Date`, `Warranty Expiry` and `Notes`.

Device Name is required. Duplicate Device Names are rejected both within an import file and against the existing asset register.

## First deployment gate

Before calling the initial version complete:

1. GitHub Actions must successfully build both Custom UIs and syntax-check the resolver.
2. Run `forge lint` locally against the registered app.
3. Deploy to the Forge development environment.
4. Install on the Nuvriqo Jira site.
5. Perform live smoke tests for manual create/edit/delete, CSV import, Excel import, Device picker, Jira user assignment and linked tickets.
6. Resolve any Forge manifest or permission issues found in the development install.

## Deliberately later

The JSM portal device picker and portal request detail experience are intentionally deferred until after the core V1 is stable. V1 also avoids CMDB schemas, dependency maps, discovery and AQL-style querying.
