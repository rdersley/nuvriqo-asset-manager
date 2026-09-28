// Marketplace licence enforcement. manifest.marketplace.yml sets app.licensing.enabled, so
// Forge production installations carry context.license. Production fails closed when it is
// missing or inactive; development and staging (including the internal edition) are not
// licensed by Forge, so they are never blocked. The check reads the invocation context only,
// so it adds no Jira or storage calls.
export const LICENCE_INACTIVE_CODE = 'NUVRIQO_LICENCE_INACTIVE';
export const LICENCE_INACTIVE_MESSAGE = 'Asset Manager does not have an active licence for this site. Ask a Jira administrator to renew or activate it in Manage apps.';

export function licenceState(context = {}) {
  const environmentType = String(context?.environmentType || '').trim().toUpperCase();
  const production = environmentType === 'PRODUCTION';
  const active = context?.license?.active === true || context?.license?.isActive === true;
  return { enforced: production, active: production ? active : true, environmentType: environmentType || 'UNKNOWN' };
}

export function requireActiveLicence(context) {
  const licence = licenceState(context);
  if (licence.enforced && !licence.active) throw new Error(`${LICENCE_INACTIVE_MESSAGE} [${LICENCE_INACTIVE_CODE}]`);
}

// Wraps resolver.define so every resolver checks the licence before running. Apply it
// innermost (guardResolver(licensedResolver(new Resolver()), ...)) so the licence check
// runs before the admin permission call.
export function licensedResolver(resolver) {
  const define = resolver.define.bind(resolver);
  resolver.define = (key, handler) => define(key, async (request) => { requireActiveLicence(request?.context); return handler(request); });
  return resolver;
}
