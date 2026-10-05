import { AsyncLocalStorage } from 'node:async_hooks';

// The Jira user behind the current resolver call, so history entries can record who made a
// change without passing the caller through every function. Triggers and scheduled jobs run
// outside a resolver and record no one (their history `source` says what made the change).
const store = new AsyncLocalStorage();

// Wraps resolver.define so each handler runs with the caller's account id available. Apply it
// outermost (trackActor(licensedResolver(new Resolver()))): the release checks look for that inner
// form, and the licence and admin checks still run before the handler.
export function trackActor(resolver) {
  const define = resolver.define.bind(resolver);
  resolver.define = (key, handler) => define(key, (request) => store.run({ accountId: String(request?.context?.accountId || '') }, () => handler(request)));
  return resolver;
}

// Spread into a history event: { changedBy } when a user made the change, otherwise nothing.
export function actorFields() {
  const accountId = store.getStore()?.accountId;
  return accountId ? { changedBy: accountId } : {};
}
