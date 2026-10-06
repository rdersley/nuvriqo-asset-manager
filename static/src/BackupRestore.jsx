import React, { useState } from 'react';
import { collectBackup, saveBackupFile, parseBackup, restoreBackup } from '../../shared/backupClient.js';

// Backup & restore panel for a Custom UI admin screen. `invoke` is the app's resolver call.
export default function BackupRestore({ invoke, app, filePrefix, children }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);

  const run = async (work) => {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e?.message || String(e)); } finally { setBusy(false); }
  };

  const download = () => run(async () => {
    setStatus('Reading app data…');
    const backup = await collectBackup(invoke, { app, onProgress: (n) => setStatus(`Reading app data… ${n.toLocaleString()} records`) });
    saveBackupFile(backup, filePrefix);
    setStatus(`Backup downloaded: ${backup.count.toLocaleString()} records.`);
  });

  const choose = (file) => run(async () => {
    setPending(null);
    if (!file) return;
    const backup = parseBackup(await file.text());
    setPending({ name: file.name, backup });
    setStatus('');
  });

  const restore = () => run(async () => {
    const { backup } = pending;
    const totals = await restoreBackup(invoke, backup, { onProgress: (done, total) => setStatus(`Restoring… ${done.toLocaleString()} of ${total.toLocaleString()}`) });
    setPending(null);
    setStatus(`Restore finished: ${totals.restored.toLocaleString()} records restored${totals.skipped ? `, ${totals.skipped.toLocaleString()} skipped (expired or not restorable)` : ''}.${totals.failed.length ? ` ${totals.failed.length} could not be written; restore again to retry them.` : ' Reload the app to see the restored data.'}`);
  });

  return <div className="card backup-restore" style={{ padding: 16 }}>
    <h2 style={{ marginTop: 0 }}>Backup &amp; restore</h2>
    <p>Download everything this app stores on this site (settings and data) as one file, or restore a backup, for example to move to another installation of the app. Passwords and API keys are never included; enter them again after a restore.</p>
    <p><button className="primary" disabled={busy} onClick={download}>Download backup</button></p>
    <h3>Restore</h3>
    <p>Restoring writes every record in the backup and replaces records with the same key. Records that are not in the backup are kept.</p>
    <input type="file" accept="application/json,.json" disabled={busy} onChange={(e) => choose(e.target.files?.[0])} />
    {pending && <div style={{ marginTop: 12 }}>
      <p><strong>{pending.name}</strong>: {pending.backup.count?.toLocaleString?.() ?? pending.backup.items.length} records{pending.backup.app ? ` from ${pending.backup.app}` : ''}, made {new Date(pending.backup.createdAt).toLocaleString()}.</p>
      <button className="primary" disabled={busy} onClick={restore}>Restore this backup</button>{' '}
      <button className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
    </div>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert" style={{ color: 'var(--ds-text-danger, #ae2a19)' }}>{error}</p>}
    {children}
  </div>;
}
