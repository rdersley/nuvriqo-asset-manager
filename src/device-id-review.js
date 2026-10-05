import { kvs } from '@forge/kvs';

// Records of values in the Jira Device ID field that are not Device IDs, for the Device ID
// clean-up list. Written by the Jira scan (src/index.js) and when a ticket is saved
// (src/status-sync.js); both must use the same key.
export const DEVICE_ID_REVIEW_PREFIX = 'device-id-review:';

const normalise = (value) => String(value ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');
const now = () => new Date().toISOString();

export const deviceIdReviewKey = (value) => `${DEVICE_ID_REVIEW_PREFIX}${Buffer.from(normalise(value), 'utf8').toString('base64url')}`;

// A ticket was saved with this value. Adds the ticket to the value's record without restarting
// the scan's counts (the next scan recounts). Ignored values stay ignored.
export async function recordTicketRejection(value, reason, issueKey) {
  const key = deviceIdReviewKey(value);
  const existing = await kvs.get(key);
  const keys = Array.isArray(existing?.issueKeys) ? existing.issueKeys : [];
  const isNew = issueKey && !keys.includes(issueKey);
  await kvs.set(key, {
    ...(existing || {}),
    value: existing?.value || String(value).trim(),
    reason,
    runId: existing?.runId || 'ticket-saved',
    ticketCount: Number(existing?.ticketCount || 0) + (isNew ? 1 : 0),
    issueKeys: isNew ? [issueKey, ...keys].slice(0, 10) : keys,
    status: existing?.status === 'ignored' ? 'ignored' : 'open',
    firstSeen: existing?.firstSeen || now(),
    lastSeen: now(),
  });
}
