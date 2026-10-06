// Lines from the Custom fields box. Each line is a field: "Asset owner" (a text field), or
// "Purchase order | date" (label and type), or the full "assetOwner | Asset owner | text".
// The key, which stores the values, is made from the label when it isn't given.
export const CUSTOM_FIELD_TYPES = ['text', 'date'];
const keyFrom = (label) => String(label).trim().toLowerCase().replace(/[^a-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[^a-z]+/, '') || 'field';

export function parseCustomFields(text = '') {
  const seen = new Set();
  return String(text).split('\n').map((line) => line.split('|').map((x) => x.trim())).filter((parts) => parts[0]).map((parts) => {
    let key, label, type;
    if (parts.length >= 3) [key, label, type] = parts;
    else if (parts.length === 2 && CUSTOM_FIELD_TYPES.includes(parts[1].toLowerCase())) [label, type] = parts;
    else [key, label] = parts.length === 2 ? parts : [undefined, parts[0]];
    label = label || key;
    key = key || keyFrom(label);
    type = CUSTOM_FIELD_TYPES.includes(String(type || '').toLowerCase()) ? String(type).toLowerCase() : 'text';
    return { key, label, type };
  }).filter((f) => f.key && f.label && !seen.has(f.key) && seen.add(f.key));
}
