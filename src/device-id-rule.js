// Decides whether a value in the Jira Device ID field is a real Device ID. Shared by the
// backend (Jira scan, preview) and the Configuration page's tester, so both agree.
//
// Format patterns, one per line, matched against the whole value ignoring case:
//   #  one digit        @  one letter        ?  any one character        *  any characters
// Anything else is literal. "VPOS-####" matches VPOS-0012; "@@@####" matches ABC1234.
// A line can start with a device type from the Asset types list: "Tablet: TAB####" is the
// Tablet format. A value matching it is a Tablet, which names the type of a new device.
// Lines without a type apply to every type. No patterns means any value that passes the
// basic checks counts as a Device ID.

const PLACEHOLDERS = ['.', '-', 'n/a', 'na', 'none', 'null', 'unknown'];
const norm = (v) => String(v ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ');

function toRegExp(pattern) {
  return new RegExp(`^${[...pattern].map((c) => (c === '#' ? '\\d' : c === '@' ? '[a-z]' : c === '?' ? '.' : c === '*' ? '.*' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'i');
}

// assetTypes: the configured list. "Type: pattern" is that type's format, spelled as on the list.
// A type not on the list yet still counts when a space follows the colon ("vPOS: RYRS######") and
// the name has no pattern symbols; it is marked unlisted so the settings page can say to add it.
// "AB:##" (no space) with AB not on the list stays one pattern, colon included.
export function compileDeviceIdPatterns(patterns = [], assetTypes = []) {
  const types = new Map((Array.isArray(assetTypes) ? assetTypes : []).map((t) => [norm(t), String(t).trim()]));
  return (Array.isArray(patterns) ? patterns : [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      const prefix = at > 0 ? line.slice(0, at).trim() : '';
      const listed = prefix ? types.get(norm(prefix)) : undefined;
      const unlisted = !listed && /^[^#@?*]{1,60}$/.test(prefix) && /^\s/.test(line.slice(at + 1)) ? prefix : undefined;
      const type = listed || unlisted;
      const pattern = type ? line.slice(at + 1).trim() : line;
      return pattern ? { type: type || null, pattern, re: toRegExp(pattern), ...(unlisted ? { unlisted: true } : {}) } : null;
    })
    .filter(Boolean);
}

// { ok: true, type } for a Device ID (type: the device type whose format it matched, if any),
// otherwise { ok: false, reason }. ticketType, when given, makes a rejection name the format
// expected for that type. Blank values return null: an empty field is not bad data.
export function checkDeviceId(value, compiled = [], ticketType = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const lower = norm(raw);
  if (PLACEHOLDERS.includes(lower) || /^[?._\-\s]+$/.test(raw)) return { ok: false, reason: 'Placeholder, not a device' };
  if (raw.length < 4 || raw.length > 100) return { ok: false, reason: 'Too short or too long' };
  if (/^\d+$/.test(raw)) return { ok: false, reason: 'Numbers only (often a serial number)' };
  if (!/[a-z]/i.test(raw)) return { ok: false, reason: 'No letters' };
  if (!compiled.length) return { ok: true, type: null };
  // A format for the ticket's own type wins when two types' formats both match.
  const matches = compiled.filter((c) => c.re.test(raw));
  if (matches.length) {
    const own = matches.find((c) => c.type && norm(c.type) === norm(ticketType));
    return { ok: true, type: (own || matches.find((c) => c.type) || matches[0]).type };
  }
  const expected = compiled.filter((c) => c.type && norm(c.type) === norm(ticketType));
  return { ok: false, reason: expected.length ? `Doesn't match the ${expected[0].type} format (${expected.map((c) => c.pattern).join(' or ')})` : "Doesn't match the Device ID format" };
}
