/**
 * Harmony WebView entry point.
 * Initializes sql.js database + local router before mounting React.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initLocalMode } from './api'

import initSqlJs from 'sql.js'
import { createSqlJsDb } from '../../server/src/db-sqljs'
import { setHarmonyDb } from '../../server/src/db-harmony'
import { dispatch } from '../../server/src/local-router'

async function bootstrap() {

  // Try to load existing database from IndexedDB
  let existingData: Uint8Array | null = null
  try {
    const stored = await loadFromIndexedDB()
    if (stored) existingData = stored
  } catch { /* fresh start */ }

  // Wrap initSqlJs to provide locateFile for WASM path
  const initWithWasm = (config?: any) => {
    return (initSqlJs as any)({
      ...config,
      locateFile: () => './sql-wasm.wasm',
    })
  }

  const db = await createSqlJsDb(
    initWithWasm,
    existingData,
    // Persist callback: save to IndexedDB after each write
    (data: Uint8Array) => saveToIndexedDB(data),
  )

  // Register the database with the harmony proxy
  setHarmonyDb(db)
  console.log('[Harmony] sql.js database initialized')

  // 2. Initialize local router
  initLocalMode(dispatch)
  console.log('[Harmony] Local router initialized')

  // 3. Mount React app
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // 4. Save database on page visibility change (app backgrounded)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && db.export) {
      saveToIndexedDB(db.export())
    }
  })
}

// --- IndexedDB persistence helpers ---

const DB_NAME = 'fund-tracker'
const STORE_NAME = 'database'
const KEY = 'main'

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function saveToIndexedDB(data: Uint8Array): Promise<void> {
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(data, KEY)
    tx.oncomplete = () => { idb.close(); resolve() }
    tx.onerror = () => { idb.close(); reject(tx.error) }
  })
}

async function loadFromIndexedDB(): Promise<Uint8Array | null> {
  const idb = await openIDB()
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(KEY)
    req.onsuccess = () => { idb.close(); resolve(req.result ?? null) }
    req.onerror = () => { idb.close(); reject(req.error) }
  })
}

// Start the app
bootstrap().catch(err => {
  console.error('[Harmony] Bootstrap failed:', err)
  document.body.innerHTML = `<pre style="color:red;padding:20px">启动失败: ${err.message}</pre>`
})
