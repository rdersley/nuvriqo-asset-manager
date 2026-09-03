# Nuvriqo Asset Manager

A deliberately simple asset and device manager for Jira and Jira Service Management.

> Assets without the CMDB.

## V0.2 scaffold

Current implementation includes:

- Forge global page for the asset register
- Forge Jira issue panel for linking a device to a ticket
- Forge KVS-backed asset records
- Search and filters
- Asset create/edit/delete
- Jira user search/autocomplete foundation for assignment
- Assignment, status and location activity history
- App-managed linked-ticket history
- CSV import and export
- Configurable asset types, statuses and locations
- Configurable text/date custom asset fields
- Asset detail view and activity timeline

## Asset model

Core fields currently include asset ID, name, type, manufacturer, model, serial number, assigned Jira user, status, location, purchase date, warranty expiry, notes and custom fields.

## Storage model

- `asset:<id>` — asset records
- `issue-link:<issueKey>` — issue-to-asset link records
- `asset-event:<assetId>:<timestamp>:<id>` — asset history events
- `asset-config` — admin configuration

Personal assignment data is kept in Forge app storage rather than Jira entity properties.

## Before first deployment

1. Replace `REPLACE_WITH_FORGE_APP_ID` in `manifest.yml` with the Forge app ID.
2. Install dependencies with `npm install`.
3. Build the Custom UI with `npm run build`.
4. Run Forge lint and deploy/install in a development environment.
5. Validate Jira user search permissions and the issue-panel context on the target site.

## Next V1 build slice

- JSM portal device picker restricted to devices assigned to the customer
- Portal request detail asset panel
- Larger-register pagination
- Import validation/mapping improvements
- Admin guards and release hardening
- Automated tests and GitHub Actions

The V1 scope intentionally avoids CMDB schemas, dependency maps, discovery and AQL-style querying.
