/**
 * Harmony WebView database stub.
 * In the Harmony build, this replaces db.ts.
 * It provides a sql.js-backed database that must be initialized before use.
 */
import type { DBAdapter } from './db-interface';

let _db: DBAdapter | null = null;

/** Set the database instance (called during Harmony app initialization) */
export function setHarmonyDb(adapter: DBAdapter) {
  _db = adapter;
}

/** Get the current database instance */
function getDb(): DBAdapter {
  if (!_db) {
    throw new Error('[Harmony] Database not initialized. Call setHarmonyDb() first.');
  }
  return _db;
}

// Proxy that delegates to the real db once initialized
const db: DBAdapter = new Proxy({} as DBAdapter, {
  get(_target, prop) {
    const realDb = getDb();
    const val = (realDb as any)[prop];
    if (typeof val === 'function') {
      return val.bind(realDb);
    }
    return val;
  },
});

export default db;
