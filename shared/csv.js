// CSV export shared by every Custom UI.
//
// Spreadsheet apps evaluate cells that start with = + - @ (or a tab/CR) as
// formulas, and exported values often come from Jira fields anyone can edit.
// Such text is prefixed with an apostrophe so it is shown, not executed; the
// asset importer strips that prefix again so exports round-trip.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvEscape(value) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// The BOM makes Excel read the file as UTF-8 (accented names, “smart” quotes).
export function toCsv(headers, rows) {
  return '﻿' + [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
}

export function downloadCsv(filename, headers, rows) {
  const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
