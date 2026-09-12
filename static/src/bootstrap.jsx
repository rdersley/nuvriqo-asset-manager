import { view } from '@forge/bridge';

const wait = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms));

async function contextWithTimeout(ms = 1200) {
  try {
    return await Promise.race([view.getContext(), wait(ms)]);
  } catch {
    return null;
  }
}

function renderFatal(error) {
  const root = document.getElementById('root');
  if (!root) return;
  const message = String(error?.message || error || 'Unknown startup error');
  const safe = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  root.innerHTML = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:24px;max-width:760px;margin:24px auto;border:1px solid #dfe1e6;border-radius:8px;background:#fff"><h2 style="margin:0 0 8px">Asset Manager could not start</h2><p style="margin:0 0 12px;color:#44546f">The app UI failed during startup. Refresh once; if this remains, copy the message below for support.</p><pre style="white-space:pre-wrap;background:#f7f8f9;padding:12px;border-radius:6px">${safe}</pre></div>`;
}

async function start() {
  const context = await contextWithTimeout();
  const location = String(context?.extension?.location || window.location.pathname || '').toLowerCase();
  if (location.includes('/reports')) {
    await import('./reports.jsx');
    return;
  }
  await import('./main.jsx');
}

start().catch((error) => {
  console.error('Asset Manager bootstrap failed', error);
  renderFatal(error);
});
