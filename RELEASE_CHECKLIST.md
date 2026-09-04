# Nuvriqo Asset Manager — Initial V1 Release Checklist

Target: 0.9.x release candidate leading to the first 1.0.0 release.

## Automated gate

- [x] Resolver syntax check in GitHub Actions
- [x] Asset Manager Custom UI build in GitHub Actions
- [x] Device custom-field UI build in GitHub Actions
- [x] Import validation regression tests in GitHub Actions
- [x] Authenticated Forge lint in GitHub Actions
- [x] Jira ticket history supports `nextPageToken` pagination beyond 100 issues
- [x] Delete flow checks both legacy links and Device custom-field Jira relationships
- [x] Fleet-level reporting implementation is present

## Forge gate

Run from the current `main` branch:

```powershell
npm install
npm run validate
forge lint
forge deploy
```

Then install or upgrade the development installation on the Nuvriqo Jira site.

## Live Jira smoke test

### Asset register
- [ ] Asset Manager global page opens without errors
- [ ] Add an asset manually
- [ ] Device Name is required
- [ ] Duplicate Device Name is rejected case-insensitively
- [ ] Edit an asset
- [ ] Delete an unlinked asset with confirmation
- [ ] Attempting to delete an asset linked through the Device field is blocked
- [ ] Attempting to delete an asset linked through the legacy issue panel is blocked
- [ ] Search by Device Name, serial, model and assigned user
- [ ] Filter by type, status and location

### Import/export
- [ ] Import a CSV file
- [ ] Import an Excel `.xlsx` file
- [ ] Import preview displays expected rows
- [ ] Missing Device Names are blocked
- [ ] Duplicate Device Names in the file are blocked
- [ ] Existing Device Names are blocked unless the row is an intended update
- [ ] Import result clearly reports successes and failures
- [ ] CSV export opens correctly in Excel

### Assignment and configuration
- [ ] Jira user search returns expected users
- [ ] Assign and unassign a device
- [ ] Assignment change appears in asset history
- [ ] Status change appears in asset history
- [ ] Location change appears in asset history
- [ ] Custom asset fields save and display correctly
- [ ] Asset types, statuses and locations save correctly

### Jira Device field
- [ ] Device custom field is available to Jira
- [ ] Picker displays Device Name only
- [ ] Type-ahead search finds devices by Device Name
- [ ] Selected value displays Device Name only
- [ ] Value persists on issue reload
- [ ] Value can be cleared
- [ ] Device field works on issue create/edit/transition where configured
- [ ] Device field can be queried through JQL using its searchable properties

### Fault / ticket history
- [ ] Ticket using the Device field appears under the asset's Fault History
- [ ] Legacy issue-panel link also appears under Fault History
- [ ] Unlinking legacy panel link removes that relationship
- [ ] Fault History shows issue key, summary, status, type, priority, assignee, created and resolved dates
- [ ] Jira issue key opens the ticket
- [ ] Total, open and resolved counts are correct
- [ ] Last 30-day and 90-day counts are correct
- [ ] A device with more than 100 linked issues returns complete paginated history

### Asset Reporting
- [ ] Reports page opens successfully
- [ ] Assets are ranked by total fault count
- [ ] Total fault and open fault summary figures are correct
- [ ] Devices with 3+ faults count is correct
- [ ] Clicking a report row opens the asset detail
- [ ] Refresh reloads report data
- [ ] Report CSV export opens correctly
- [ ] Jira lookup failures are clearly marked rather than displayed as zero faults

## Initial V1 release decision

Promote to `1.0.0` only after the Forge gate and live Jira smoke test above pass without a release-blocking defect.

JSM portal device selection is deliberately excluded from this initial release gate and remains a post-core enhancement.
