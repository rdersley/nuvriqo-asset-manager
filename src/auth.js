import api, { route } from '@forge/api';

// Checked as the calling user so the answer reflects their own Jira
// permissions, not the app's.
export async function isJiraAdmin() {
  const response = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
  if (!response.ok) return false;
  const body = await response.json();
  return body?.permissions?.ADMINISTER?.havePermission === true;
}

export async function requireAdmin() {
  if (!(await isJiraAdmin())) throw new Error('Only Jira administrators can perform this action.');
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
