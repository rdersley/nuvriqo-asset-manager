import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: [
      // read-excel-file unzips in a blob: Web Worker, which Jira's CSP refuses; use a worker-free unzip.
      { find: /^\.\.\/zip\/unzipFromArrayBuffer\.js$/, replacement: fileURLToPath(new URL('./src/unzipWithoutWorkers.js', import.meta.url)) }
    ]
  }
});
