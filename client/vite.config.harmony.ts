import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// Plugin to replace Node.js modules with stubs in the harmony build
function harmonyStubs(): Plugin {
  return {
    name: 'harmony-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
      // Redirect any import of server/src/db (but not db-harmony, db-interface, db-sqljs)
      if (importer && source.endsWith('/db') && !source.includes('db-')) {
        return path.resolve(__dirname, '../server/src/db-harmony.ts')
      }
      // Stub out better-sqlite3
      if (source === 'better-sqlite3') {
        return '\0empty-module'
      }
      // Stub out Node built-ins that might leak through
      if (source === 'path' || source === 'fs' || source === 'express' || source === 'cors') {
        return '\0empty-module'
      }
      return null
    },
    load(id) {
      if (id === '\0empty-module') {
        return `
          const noop = () => {};
          const handler = { get: () => new Proxy(noop, handler), apply: () => new Proxy(noop, handler) };
          const stub = new Proxy(noop, handler);
          export default stub;
          export const Router = () => new Proxy(noop, handler);
          export const join = () => "";
          export const resolve = () => "";
          export const json = () => noop;
          export const urlencoded = () => noop;
        `
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [harmonyStubs(), react(), tailwindcss()],
  base: './', // relative paths for file:// loading in WebView
  define: {
    'import.meta.env.VITE_HARMONY': JSON.stringify('true'),
  },
  resolve: {
    alias: [
      { find: '@server', replacement: path.resolve(__dirname, '../server/src') },
      { find: 'sql.js', replacement: path.resolve(__dirname, 'node_modules/sql.js/dist/sql-wasm-browser.js') },
    ],
  },
  optimizeDeps: {
    include: ['sql.js'],
  },
  build: {
    outDir: '../harmony-app/entry/src/main/resources/rawfile/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: path.resolve(__dirname, 'index.harmony.html'),
    },
  },
})
