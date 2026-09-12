# Nuvriqo Asset Manager — 1.0.0 Sign-off Gate

Target: keep the release candidate on `0.9.x` until the exact candidate has passed automated validation, browser acceptance on the production-sized sandbox copy, internal operational checks and Marketplace packaging checks. Promote to `1.0.0` only after every release blocker below is green.

## Public V1 scope

- Asset Manager overview, register and reporting global page.
- Manual asset create/edit/delete with unique Device Name protection.
- CSV/XLSX bulk import with preview and validation.
- CSV export, search and filtering.
- Configurable asset types, statuses, locations and custom fields.
- Configurable Jira mappings for Device ID, related device, Client, location, type, fault and assignment reference.
- Resumable Jira Device ID discovery and deterministic Jira asset IDs.
- Friendly Device Name stored separately from the authoritative Jira Device ID.
- Optional Jira/JSM account identity plus free-text holder/assignment reference.
- Per-device Jira fault history, historical fault ledger and latest-fault indicator.
- Fleet reporting.
- Jira issue panel and Device custom-field integration.
- JSM portal organisation device view.
- Scale guards and batched cleanup for large sites.

## Internal-only scope

The internal development installation additionally contains:

- Crew Tracking import/reporting.
- Device Usage Reconciliation and internal device-status import.
- Internal crew/device aliases and reconciliation storage.

These modules must remain in `manifest.yml` for the internal environment but must not appear in `manifest.marketplace.yml` or in Marketplace listing copy/screenshots.

## Automated release gate

Run the complete CI workflow on the exact candidate after the last code change.

- [ ] Resolver syntax passes for every backend module.
- [ ] Import validation tests pass.
- [ ] QA regression simulations pass.
- [ ] Main Asset Manager UI build passes.
- [ ] Device field UI build passes.
- [ ] Issue panel UI build passes.
- [ ] Device split UI build passes.
- [ ] Customer portal UI build passes.
- [ ] Reports UI build passes.
- [ ] Internal Asset Operations UI build passes.
- [ ] Marketplace manifest verification passes.
- [ ] Forge lint passes.
- [ ] Sandbox read-only Jira smoke tests pass.
- [ ] Forge development deployment succeeds.
- [ ] Sandbox install/upgrade succeeds.
- [ ] Post-deploy Jira smoke tests pass.

## Browser acceptance — release blockers

Run these in the installed development app, not just CI.

1. **Startup / blank-screen protection** — `/overview` renders the Asset Manager UI within a few seconds. A delayed or failed Forge context lookup must not leave a blank Jira frame.
2. **Navigation** — Overview, Assets, Imports, Reports and Configuration all open and the Asset Manager navigation remains usable.
3. **Configuration** — Jira custom fields load; mapped fields can be saved; Configuration remains reachable even if Jira discovery or reporting fails.
4. **Large-data behaviour** — opening Overview, Assets, Reports, issue panel, portal view and Internal Asset Operations does not produce Forge installation/execution-limit errors on the production-sized copy.
5. **Bad-import cleanup** — Remove Jira imports removes only automatically discovered Jira records in resumable batches, preserves manual/imported assets and pauses automatic discovery.
6. **Device discovery** — a configured Device ID creates or matches exactly one asset; placeholders such as `.`, `-`, `N/A`, all-zero and obviously invalid identifiers are ignored.
7. **Resumable scan** — Jira Device ID scanning can stop safely after a bounded batch and resume from stored progress without restarting or duplicating assets.
8. **Friendly-name stability** — changing Device Name does not break Jira fault history because Device ID remains authoritative.
9. **Metadata mapping** — Client, Device Type, Location and assignment reference use the newest populated mapped value; a newer blank field does not erase a valid value.
10. **Fault history** — representative devices with multiple Jira tickets show correct newest-first history and latest-fault data.
11. **Manual holder** — free-text holder saves correctly and optional Jira/JSM lookup can attach account identity.
12. **Import/export round trip** — exported CSV can be re-imported with Device ID, client, assignment reference and holder preserved; supported legacy headings remain accepted.
13. **Search/reporting** — search finds representative devices by friendly name, Device ID and assignment reference; reporting totals match the bounded/source data described by the UI.
14. **Safe deletion** — an asset with Jira relationships cannot be deleted until those relationships are cleared/unlinked.
15. **Portal view** — a JSM customer can open the organisation-device view without gaining access to another organisation's devices.

## Internal acceptance

- [ ] Crew register import accepts the agreed internal spreadsheet format in paced/resumable batches.
- [ ] Crew records retain email, location, aliases and assignment reference correctly.
- [ ] Device Usage Reconciliation imports the internal status report without overwriting a conflicting current assignment.
- [ ] Missing devices can be created safely from the internal status report.
- [ ] Assignment mismatches are flagged for review.
- [ ] Internal tools remain available only in the development/internal manifest.

## Marketplace packaging gate

Atlassian currently reviews function, security, performance, support and branding for new Marketplace apps. The Marketplace edition must therefore meet all of the following before submission:

- [ ] `npm run verify:marketplace` passes.
- [ ] `manifest.marketplace.yml` contains no Internal Asset Operations, crew-import or vPOS modules/resources/terminology.
- [ ] Requested Forge scopes are limited to the public functionality that actually ships.
- [ ] No external egress is required by V1 unless explicitly documented in the Privacy & Security tab.
- [ ] Privacy policy, support contact, end-user terms/EULA and security answers are final and publicly reachable where required.
- [ ] Marketplace name follows Atlassian trademark rules (for example, `Nuvriqo Asset Manager for Jira` rather than a name beginning with `Jira`).
- [ ] Logo, banner/highlights and screenshots contain only synthetic/generic data and no internal customer names, email addresses, crew codes, bases or operational screenshots.
- [ ] Listing description matches the public manifest exactly and does not advertise internal-only functionality.
- [ ] Clean-site installation test succeeds using the Marketplace/production manifest.
- [ ] Final production SHA and Forge version are recorded in the Marketplace submission pack.

## Release action

Only after every required item above is green:

1. Change root package version from `0.9.x` to `1.0.0`.
2. Run the full CI gate again on that exact commit.
3. Create tag `v1.0.0` on the tested commit.
4. Preserve that exact commit as the Marketplace release candidate.
5. Deploy `manifest.marketplace.yml` to Forge production using the manual Marketplace release workflow.
6. Perform one final clean-site install/smoke test against production.
7. Submit the Marketplace listing and record the submission/review ticket in the Nuvriqo submission pack.

## Post-V1 roadmap

These must not delay V1 unless a release blocker is discovered:

- SOTI MobiControl integration.
- Deeper portal workflows.
- Full CMDB/dependency functionality.
- Destructive/device-management actions.
