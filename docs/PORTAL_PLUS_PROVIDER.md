# Portal+ provider integration

Nuvriqo Asset Manager can contribute a `My Assets` module to Nuvriqo Portal+ while remaining a separately installable Forge app.

## Provider contract

Provider id: `nuvriqo-asset-manager`

Contract version: `1`

The provider module exposes only customer-facing data needed for Portal+ rendering: asset id, display/device id, name, type, manufacturer, model, holder, status, location and organisation membership. Serial numbers are intentionally excluded from the Portal+ module contract.

The module is scoped to the signed-in customer's Jira Service Management organisation memberships and is bounded to 50 visible records, with up to 20 rendered items.

## Consent-free direction

The Portal+ provider resolver uses `api.asApp()` with the signed-in account id when resolving JSM organisation memberships. This avoids introducing a separate Atlassian customer consent prompt for the integrated Portal+ experience.

## Portal+ presentation

Portal+ can render:
- Visible assets count
- In-service count
- Needs-attention count
- Up to 20 asset cards/rows
- Device id, type, manufacturer/model, holder, location and status

The transport between independent Forge apps remains versioned and replaceable. The provider contract is deliberately separate from Asset Manager's internal KVS record format.
