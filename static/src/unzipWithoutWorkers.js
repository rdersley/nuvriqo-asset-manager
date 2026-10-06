import { unzipSync } from 'fflate';

// Replaces read-excel-file's zip reader (see vite.config.js). That one unzips large parts of a
// workbook in a Web Worker started from a blob: URL, which Jira's Content Security Policy blocks,
// so reading any sizeable .xlsx never finished. Unzipping here takes well under a second for a
// register-sized file.
export default function unzipFromArrayBuffer(input, { filter } = {}) {
  try {
    return Promise.resolve(unzipSync(new Uint8Array(input), { filter: filter ? (file) => filter({ path: file.name }) : undefined }));
  } catch (error) {
    return Promise.reject(new Error(`This file could not be opened as an Excel workbook (${error?.message || 'unzip failed'}). Save it again as .xlsx or CSV and retry.`));
  }
}
