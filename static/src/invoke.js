import { invoke as bridgeInvoke } from '@forge/bridge';

// Forge rate-limits resolver invocations per installation and rejects the excess with
// this message. It is temporary, so wait and retry instead of failing the screen.
const RATE_LIMITED = /Limits for the current installation have been exceeded/i;
export const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function invoke(name, payload, { delays = RETRY_DELAYS_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await bridgeInvoke(name, payload);
    } catch (error) {
      if (attempt >= delays.length || !RATE_LIMITED.test(String(error?.message || error))) throw error;
      await wait(delays[attempt]);
    }
  }
}
