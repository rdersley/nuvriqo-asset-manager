import React, { useMemo, useState } from 'react';
import { invoke } from './invoke.js';
import { checkDeviceId, compileDeviceIdPatterns } from '../../src/device-id-rule.js';

const linesOf = (text) => String(text || '').split('\n').map((x) => x.trim()).filter(Boolean);

// The Device ID format rule, with a box to try values against it before saving.
export function DeviceIdFormat({ value, onChange, disabled, assetTypes = [] }) {
  const [sample, setSample] = useState('');
  const compiled = useMemo(() => { try { return compileDeviceIdPatterns(linesOf(value), assetTypes); } catch { return null; } }, [value, assetTypes]);
  const result = useMemo(() => {
    return compiled ? checkDeviceId(sample, compiled) : { ok: false, reason: 'The format could not be read' };
  }, [sample, compiled]);
  const typed = (compiled || []).filter((c) => c.type);
  const unlisted = [...new Set((compiled || []).filter((c) => c.unlisted).map((c) => c.type))];
  return (
    <label className="wide">Device ID format
      <textarea rows="3" value={value} disabled={disabled} placeholder={'Tablet: TAB####\nvPOS: VPOS-*\nDEV####'} onChange={(e) => onChange(e.target.value)} />
      <small>One pattern per line. <code>#</code> = digit, <code>@</code> = letter, <code>?</code> = any one character, <code>*</code> = anything; other characters must match exactly (capitals don't matter). Start a line with a device type from Asset types to make it that type's format (<code>Tablet: TAB####</code>): a new device found by the scan gets the type its Device ID matches. Lines without a type apply to every type. The Jira scan only creates devices from values that match one of the patterns; everything else goes to Device ID clean-up in Data conflicts. Leave empty to accept any value with letters in it.{typed.length ? ` Formats by type: ${[...new Set(typed.map((c) => c.type))].join(', ')}.` : ''}</small>
      {unlisted.length > 0 && <small style={{ fontWeight: 600 }}>Not in Asset types yet: {unlisted.join(', ')}. Add {unlisted.length === 1 ? 'it' : 'them'} to Asset types so devices get that type.</small>}
      <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <input aria-label="Try a value" placeholder="Try a value" value={sample} onChange={(e) => setSample(e.target.value)} style={{ maxWidth: 220 }} />
        {sample.trim() && <small>{result?.ok ? `✓ Counts as a Device ID${result.type ? ` (${result.type})` : ''}` : `✗ ${result?.reason || 'Empty'}`}</small>}
      </span>
    </label>
  );
}

// Runs the read-only preview page by page and totals it. Devices aren't changed; rejected values
// are saved for Device ID clean-up.
export async function runScanPreview(onProgress) {
  let runId = null, nextPageToken = null, tickets = 0, guard = 0;
  const found = new Map(), rejected = new Map();
  do {
    const page = await invoke('previewJiraScan', { runId, nextPageToken });
    runId = page.runId; nextPageToken = page.nextPageToken || null; tickets += page.issuesScanned || 0; guard += 1;
    for (const f of page.found || []) { const k = f.identifier.toLowerCase(); if (!found.has(k)) found.set(k, f); }
    for (const r of page.rejected || []) { const k = r.value.toLowerCase(); const prev = rejected.get(k); rejected.set(k, { ...r, tickets: (prev?.tickets || 0) + r.tickets }); }
    onProgress?.(`Previewing Jira scan… ${tickets} tickets checked`);
  } while (nextPageToken && guard < 800);
  const all = [...found.values()];
  return {
    tickets, complete: !nextPageToken,
    registered: all.filter((f) => f.registered).length,
    newIds: all.filter((f) => !f.registered).map((f) => (f.type ? `${f.identifier} (${f.type})` : f.identifier)),
    rejected: [...rejected.values()].sort((a, b) => b.tickets - a.tickets),
  };
}

export function ScanPreviewSummary({ summary, onClose }) {
  if (!summary) return null;
  const rejectedTickets = summary.rejected.reduce((n, r) => n + r.tickets, 0);
  return (
    <div className="card" role="status" style={{ marginTop: 12 }}>
      <div className="section-head"><h2>Jira scan preview</h2><button className="secondary" onClick={onClose}>Close</button></div>
      <p>{summary.tickets} tickets checked{summary.complete ? '' : ' (stopped early; run it again to continue)'}. Nothing in the register was changed.</p>
      <ul>
        <li><strong>{summary.registered}</strong> Device IDs already in Asset Manager.</li>
        <li><strong>{summary.newIds.length}</strong> would be added as new devices{summary.newIds.length ? `: ${summary.newIds.slice(0, 15).join(', ')}${summary.newIds.length > 15 ? ', …' : ''}` : ''}.</li>
        <li><strong>{summary.rejected.length}</strong> other values on {rejectedTickets} tickets would be skipped. They're listed under Device ID clean-up in Data conflicts.</li>
      </ul>
      {summary.rejected.length > 0 && <div className="table-wrap"><table aria-label="Values that would be skipped"><thead><tr><th>Value</th><th>Tickets</th><th>Why</th></tr></thead><tbody>
        {summary.rejected.slice(0, 10).map((r) => <tr key={r.value} style={{ cursor: 'default' }}><td>{r.value}</td><td>{r.tickets}</td><td>{r.reason}</td></tr>)}
      </tbody></table>{summary.rejected.length > 10 && <small>Top 10 shown; the full list is in Data conflicts.</small>}</div>}
      <small>If the new devices look wrong, tighten the Device ID format and preview again before running the real scan.</small>
    </div>
  );
}
