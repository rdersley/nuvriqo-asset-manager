import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

const when = (v) => (v ? new Date(v).toLocaleString() : '—');
const RESULT_TEXT = {
  filled: 'Filled',
  'nothing-to-fill': 'Nothing to fill',
  'not-found': 'Reporter not in crew file',
  multiple: 'Email used by more than one crew member',
  'no-reporter': 'No reporter',
  'jira-read-failed': 'Could not read the ticket',
  'jira-update-failed': 'Jira refused the update'
};

// Fill a ticket's crew code and base from its reporter, matched to the crew register by email
// (or by the JSM customer account linked to the crew member). Backend: src/reporter-fill.js.
export default function TicketFill() {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');

  async function load() {
    try {
      const s = await invoke('getTicketFillSettings');
      setForm({ ...s, projectsText: (s.projects || []).join(', ') });
    } catch (e) { setMessage(e.message || 'Could not load ticket fill settings.'); }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setBusy('save'); setMessage('');
    try {
      await invoke('saveTicketFillSettings', { baseField: form.baseField, fillOnCreate: form.fillOnCreate, projects: form.projectsText });
      await load(); setMessage('Saved.');
    } catch (e) { setMessage(e.message || 'Could not save.'); } finally { setBusy(''); }
  }

  async function rebuild() {
    setBusy('rebuild'); setMessage('');
    try {
      let cursor = null, processed = 0, calls = 0;
      do {
        const r = await invoke('rebuildCrewLookups', { cursor });
        processed += r.processed || 0; cursor = r.nextCursor || null; calls += 1;
        setMessage(`Preparing crew email lookups… ${processed} crew`);
      } while (cursor && calls < 100);
      await load(); setMessage(`Crew email lookups ready for ${processed} crew.`);
    } catch (e) { setMessage(e.message || 'Could not prepare the crew lookups.'); } finally { setBusy(''); }
  }

  if (!form) return <section className="card"><h2>Fill crew code and base on tickets</h2>{message ? <div className="notice">{message}</div> : <div className="empty">Loading…</div>}</section>;
  const pickBase = (e) => { const f = form.fields.find((x) => x.id === e.target.value); setForm({ ...form, baseField: f ? { id: f.id, name: f.name } : null }); };

  return (
    <section className="card">
      <h2>Fill crew code and base on tickets</h2>
      <p>The ticket's reporter is matched to the crew register by email, or by the JSM customer linked to the crew member when Jira hides the email. Only empty fields are filled, and nothing is filled when the match is unclear. Sub-tasks use their parent ticket's reporter. Split Devices also shows the match and can fill the parent before creating sub-tasks.</p>
      {message && <div className="notice">{message}</div>}
      <div className="toolbar">
        <label>Crew code field: <strong>{form.crewCodeField?.name || 'Not mapped'}</strong> <small>(the Jira assignment reference field in Asset Manager configuration)</small></label>
        <label>Base field{' '}
          <select value={form.baseField?.id || ''} onChange={pickBase} disabled={Boolean(busy)}>
            <option value="">Not used</option>
            {form.fields.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.id})</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={form.fillOnCreate} disabled={Boolean(busy)} onChange={(e) => setForm({ ...form, fillOnCreate: e.target.checked })} /> Fill automatically when a ticket is created</label>
        <label>Projects <input placeholder="All projects, or e.g. SD, HW" value={form.projectsText} disabled={Boolean(busy)} onChange={(e) => setForm({ ...form, projectsText: e.target.value })} /></label>
        <div>
          <button className="primary" onClick={save} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save'}</button>{' '}
          <button onClick={rebuild} disabled={Boolean(busy)}>{busy === 'rebuild' ? 'Working…' : 'Prepare crew email lookups'}</button>
          <small> {form.lookupsBuiltAt ? `Last prepared ${when(form.lookupsBuiltAt)}. Imports and JSM linking keep them up to date.` : 'Run once for crew imported before this feature; imports and JSM linking keep them up to date afterwards.'}</small>
        </div>
      </div>
      {form.log?.length > 0 && (
        <div className="tablewrap"><table><thead><tr><th>When</th><th>Ticket</th><th>Reporter</th><th>Crew code</th><th>Result</th><th>Detail</th></tr></thead>
          <tbody>{form.log.slice(0, 20).map((r, i) => <tr key={`${r.at}-${i}`}><td>{when(r.at)}</td><td>{r.issueKey}</td><td>{r.reporter || '—'}</td><td>{r.crewCode || '—'}</td><td>{RESULT_TEXT[r.result] || r.result}</td><td>{r.detail || ''}</td></tr>)}</tbody>
        </table></div>
      )}
    </section>
  );
}
