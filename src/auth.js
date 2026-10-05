import api, { route } from '@forge/api';

// Jira answers 429 (rate limited) or 5xx when busy, for example during a large import or scan.
// Those are asked again after a pause; they are not a "no".
export const ADMIN_CHECK_RETRY = { delays: [500, 1500, 3000] };
const busy = (status) => status === 429 || (status >= 500 && status < 600);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// { admin, status }: status is Jira's HTTP status when it could not answer.
// Checked as the calling user so the answer reflects their own Jira
// permissions, not the app's.
export async function adminCheck() {
  for (let attempt = 0; ; attempt += 1) {
    const response = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const body = await response.json();
      return { admin: body?.permissions?.ADMINISTER?.havePermission === true };
    }
    if (!busy(response.status) || attempt >= ADMIN_CHECK_RETRY.delays.length) return { admin: false, status: response.status };
    await pause(ADMIN_CHECK_RETRY.delays[attempt]);
  }
}

export async function isJiraAdmin() {
  return (await adminCheck()).admin;
}

// Fails closed either way; the message says whether Jira said no or was too busy to answer.
export async function requireAdmin() {
  const { admin, status } = await adminCheck();
  if (admin) return;
  if (busy(status)) throw new Error(`Jira is busy and couldn't confirm you're a Jira administrator (Jira returned ${status}). Try again in a minute.`);
  throw new Error('Only Jira administrators can perform this action.');
}

// Wraps resolver.define so every key in adminKeys (or every key, when
// adminKeys is 'all') rejects callers who are not Jira administrators.
// Any Jira user who can open a module can invoke its resolvers directly,
// so hiding a control in the UI is not enough.
export function guardResolver(resolver, adminKeys) {
  const define = resolver.define.bind(resolver);
  resolver.define = (key, handler) => define(key, adminKeys === 'all' || adminKeys.has(key)
    ? async (request) => { await requireAdmin(); return handler(request); }
    : handler);
  return resolver;
}
