# Nuvriqo Asset Manager — 1.0.0 Sign-off Gate

Target: release candidate on `0.9.0`, promoted to `1.0.0` only after the candidate passes the automated gate and the final acceptance scenarios below.

## Current release-candidate scope

- Dedicated Asset Manager global page.
- Manual asset create/edit/delete with unique Device Name protection.
- CSV/XLSX bulk import with preview and validation.
- CSV export.
- Search and filtering.
- Assignment, status and location history.
- Jira Device ID discovery and matching.
- Friendly Device Name stored separately from the authoritative Jira Device ID.
- Configurable Jira mappings for Device ID, Device Type, Base/Location and Crew Code.
- Crew Code and holder support for JSM customers and people who are not Jira users.
- Optional Jira/JSM account identity; it is never required for a holder.
- Per-device Jira fault history and latest-fault indicator in the asset register.
- Fleet fault reporting.
- Jira issue panel/device field integration.

## Automated release gate

The last deployed baseline passed this complete gate. The current release candidate must pass it again after the final holder/import changes.

- [ ] Resolver syntax passes.
- [ ] Import validation tests pass.
- [ ] QA regression simulations pass.
- [ ] Asset Manager UI build passes.
- [ ] Device field UI build passes.
- [ ] Forge lint passes.
- [ ] Retail in Motion sandbox read-only Jira smoke tests pass.
- [ ] Forge development deployment succeeds.
- [ ] Retail in Motion sandbox install/upgrade succeeds.
- [ ] Post-deploy Jira smoke tests pass.

## Final acceptance scenarios

1. **Device discovery** — a populated configured Device ID creates or matches exactly one asset; placeholder values such as `.`, `-` and `N/A` are ignored.
2. **Friendly-name stability** — changing Device Name does not break Jira fault history because Device ID remains the authoritative Jira identifier.
3. **Fault history** — a representative device with multiple Jira tickets shows complete newest-first history and the register shows the correct latest fault.
4. **Metadata mapping** — Device Type, Base/Location and Crew Code use the latest matching ticket where each individual mapped field is populated; a newer blank field must not erase a valid value.
5. **External holder** — a Crew Code can identify a holder who is not a licensed Jira user or is not present in Jira. Jira account ID stays optional.
6. **Manual holder** — free-text holder entry saves correctly and optional Jira/JSM lookup can attach an account identity when desired.
7. **Import/export round trip** — exported CSV can be imported with Device ID, Crew Code and Assigned Person / Holder preserved. Legacy `Assigned User` and `Base` headings are accepted.
8. **Search/reporting** — search finds representative devices by friendly name, Device ID and Crew Code; report total/open/resolved fault counts match the source Jira data.
9. **Safe deletion** — an asset with matching Jira tickets cannot be deleted without first clearing or unlinking those ticket relationships.

## Release action

Only after every automated and acceptance item above is green:

- change root package version from `0.9.0` to `1.0.0`;
- create tag `v1.0.0` on the tested commit;
- preserve that exact commit as the Marketplace release candidate;
- proceed with Marketplace release preparation.

## Deliberately outside the 1.0.0 gate

These are post-V1 roadmap items and must not delay sign-off:

- SOTI MobiControl integration;
- deeper JSM portal enhancements;
- full CMDB functionality;
- destructive/device-management actions.
