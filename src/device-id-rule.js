// Decides whether a value in the Jira Device ID field is a real Device ID. Shared by the
// backend (Jira scan, preview) and the Configuration page's tester, so both agree.
//
// Format patterns, one per line, matched against the whole value ignoring case:
//   #  one digit        @  one letter        ?  any one character        *  any characters
// Anything else is literal. "VPOS-####" matches VPOS-0012; "@@@####" matches ABC1234.
// No patterns means any value that passes the basic checks counts as a Device ID.

const PLACEHOLDERS = ['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'];

export function compileDeviceIdPatterns(patterns = []) {
  return (Array.isArray(patterns) ? patterns : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${[...p].map((c) => (c === '#' ? '\\d' : c === '@' ? '[a-z]' : c === '?' ? '.' : c === '*' ? '.*' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'i'));
}

// { ok: true } for a Device ID, otherwise { ok: false, reason }. Blank values return null:
// an empty field is not bad data.
export function checkDeviceId(value, compiled = []) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lower = raw.toLocaleLowerCase('en').replace(/\s+/g, ' ');
  if (PLACEHOLDERS.includes(lower) || /^[?._\-\s]+$/.test(raw)) return { ok: false, reason: 'Placeholder, not a device' };
  if (raw.length < 4 || raw.length > 100) return { ok: false, reason: 'Too short or too long' };
  if (/^\d+$/.test(raw)) return { ok: false, reason: 'Numbers only (often a serial number)' };
  if (!/[a-z]/i.test(raw)) return { ok: false, reason: 'No letters' };
  if (compiled.length && !compiled.some((re) => re.test(raw))) return { ok: false, reason: "Doesn't match the Device ID format" };
  return { ok: true };
}
