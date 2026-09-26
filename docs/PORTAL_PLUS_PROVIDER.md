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

## Snapshot publishing

Forge apps cannot call each other's resolvers, so Portal+ reads a snapshot that Asset Manager publishes to the configured service desk project's `nuvriqo.asset-manager.portal` project property (`src/portal-plus-publisher.js`).

- **Source:** the most recently updated tickets in the configured project that carry both a Device ID and an Organization (up to 2,000 tickets, within a 15s budget). Devices are resolved through the deterministic Jira-discovery id and the Device Name index, with no register scan.
- **Shape:** `{ provider, contractVersion: 1, projectId, updatedAt, organisations: [{ id, name, assets: [...] }] }`. Serial numbers are excluded.
- **Size:** Jira entity properties are limited to 32 KB. The per-organisation asset list (at most 50, matching what Portal+ renders) is trimmed until the snapshot fits under 30,000 bytes.
- **When:** hourly, via the `portal-plus-snapshot` scheduled trigger. The last result is stored under `portal-plus:last-publish`.
- **Edition:** internal only. Writing a project property needs `manage:jira-project`, which only `manifest.yml` declares. Forge lint checks every file in `src/`, so the Marketplace workflows delete `src/portal-plus-publisher.js` and `src/portal-plus-refresh.js` after switching manifests. Shared resolvers (`index.js`, `portal-assets.js`, …) must therefore never import the publisher.
