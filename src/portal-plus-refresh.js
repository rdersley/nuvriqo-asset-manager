import { refreshPortalPlusSnapshot } from './portal-plus-publisher.js';

// Hourly scheduled trigger: keeps the Portal+ snapshot current without slowing asset saves.
export async function handler() {
  return refreshPortalPlusSnapshot();
}
