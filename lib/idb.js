/**
 * @fileoverview IndexedDB wrapper for the AI Studio Automator extension.
 * Provides a clean async API over IndexedDB with singleton connection management.
 *
 * DB Name:    AI_Studio_Automator_DB (version 1)
 * Stores:
 *   - input_files  : keyPath 'id', autoIncrement, index 'by_status' on 'status'
 *   - config       : keyPath 'key'
 *   - output_buffer: keyPath 'key'
 */

'use strict';

/** @type {Promise<IDBDatabase>|null} Singleton DB promise — created only once. */
let _dbPromise = null;

const DB_NAME     = 'AI_Studio_Automator_DB';
const DB_NAME_OLD = 'OCR_Automation_DB';       // legacy name — migrated automatically
const DB_VERSION  = 1;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wraps an IDBRequest in a Promise.
 * Resolves with `request.result` on success; rejects with `request.error` on error.
 *
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Wraps an IDBTransaction in a Promise that resolves on `oncomplete`
 * and rejects on `onerror` or `onabort`.
 *
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function txToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(new Error('Transaction aborted'));
  });
}

// ---------------------------------------------------------------------------
// Database Setup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// One-time migration helper (OCR_Automation_DB → AI_Studio_Automator_DB)
// ---------------------------------------------------------------------------

/**
 * Copies all records from the legacy DB into the new DB, then deletes the old DB.
 * Runs silently — any error is swallowed so it never blocks normal startup.
 *
 * @param {IDBDatabase} newDb  Already-open handle to AI_Studio_Automator_DB.
 * @returns {Promise<void>}
 */
async function _migrateFromLegacyDB(newDb) {
  try {
    // Check if the old DB exists by opening it without creating stores.
    const oldDb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME_OLD);
      req.onsuccess = () => resolve(req.result);
      req.onerror  = () => reject(req.error);
      // onupgradeneeded fires only if the old DB didn't exist — skip migration.
      req.onupgradeneeded = (e) => {
        e.target.result.close();
        indexedDB.deleteDatabase(DB_NAME_OLD);
        resolve(null);
      };
    });

    if (!oldDb) return; // nothing to migrate

    const stores = ['input_files', 'config', 'output_buffer'];

    for (const storeName of stores) {
      if (!oldDb.objectStoreNames.contains(storeName)) continue;
      if (!newDb.objectStoreNames.contains(storeName)) continue;

      // Read all records from old store.
      const records = await new Promise((resolve, reject) => {
        const tx  = oldDb.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });

      if (!records || records.length === 0) continue;

      // Write into new store (skip if key already present).
      const newTx    = newDb.transaction(storeName, 'readwrite');
      const newStore = newTx.objectStore(storeName);
      for (const record of records) {
        try { newStore.add(record); } catch (_) { /* already exists */ }
      }
      await txToPromise(newTx).catch(() => {});
    }

    oldDb.close();
    indexedDB.deleteDatabase(DB_NAME_OLD);
    console.info('[idb] Legacy DB migrated and removed.');

  } catch (err) {
    console.warn('[idb] Legacy migration skipped:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Database Setup
// ---------------------------------------------------------------------------

/**
 * Opens (or returns the cached) IndexedDB connection.
 * On the very first open, silently migrates any data from the legacy
 * OCR_Automation_DB to the new AI_Studio_Automator_DB.
 * Implements the singleton pattern using a module-level promise so concurrent
 * callers all receive the same `IDBDatabase` instance.
 *
 * @returns {Promise<IDBDatabase>}
 */
export async function openDB() {
  if (_dbPromise !== null) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      /** @type {IDBDatabase} */
      const db = event.target.result;

      // -- input_files store --------------------------------------------------
      if (!db.objectStoreNames.contains('input_files')) {
        const filesStore = db.createObjectStore('input_files', {
          keyPath: 'id',
          autoIncrement: true,
        });
        filesStore.createIndex('by_status', 'status', { unique: false });
      }

      // -- config store -------------------------------------------------------
      if (!db.objectStoreNames.contains('config')) {
        db.createObjectStore('config', { keyPath: 'key' });
      }

      // -- output_buffer store ------------------------------------------------
      if (!db.objectStoreNames.contains('output_buffer')) {
        db.createObjectStore('output_buffer', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      // Kick off silent background migration (does not block caller).
      _migrateFromLegacyDB(db).catch(() => {});
      resolve(db);
    };

    request.onerror = () => {
      _dbPromise = null; // allow retry on next call
      reject(request.error);
    };

    request.onblocked = () => {
      console.warn('[idb] DB open blocked — another tab may have an older version open.');
    };
  });

  return _dbPromise;
}

// ---------------------------------------------------------------------------
// input_files CRUD
// ---------------------------------------------------------------------------

/**
 * Updates a file record completely.
 * @param {object} fileRecord The complete file object
 * @returns {Promise<void>}
 */
export async function updateFile(fileRecord) {
  const db = await openDB();
  const tx = db.transaction('input_files', 'readwrite');
  tx.objectStore('input_files').put(fileRecord);
  await txToPromise(tx);
}

/**
 * Adds a new file record to the `input_files` store with status `'pending'`.
 *
 * @param {ArrayBuffer} fileData  - Raw binary content of the file.
 * @param {string}      name      - Original filename.
 * @param {number}      size      - File size in bytes.
 * @param {string}      mimeType  - MIME type (e.g. `'application/pdf'`).
 * @returns {Promise<number>} The auto-generated record `id`.
 */
export async function addFile(fileData, name, size, mimeType) {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readwrite');
    const store = tx.objectStore('input_files');
    const id = await requestToPromise(
      store.add({ fileData, name, size, type: mimeType, status: 'pending', startTime: null, endTime: null })
    );
    await txToPromise(tx);
    return id;
  } catch (err) {
    console.error('[idb] addFile error:', err);
    throw err;
  }
}

/**
 * Returns all records in `input_files`, sorted by `id` ascending.
 *
 * @returns {Promise<Array<{id: number, fileData: ArrayBuffer, name: string, size: number, type: string, status: string, startTime: number|null, endTime: number|null}>>}
 */
export async function getAllFiles() {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readonly');
    const store = tx.objectStore('input_files');
    const records = await requestToPromise(store.getAll());
    // IDB getAll returns records in key order (ascending id) by default,
    // but we sort explicitly for safety.
    records.sort((a, b) => a.id - b.id);
    return records;
  } catch (err) {
    console.error('[idb] getAllFiles error:', err);
    throw err;
  }
}

/**
 * Retrieves a single `input_files` record by its primary key.
 *
 * @param {number} id - The record's auto-generated id.
 * @returns {Promise<{id: number, fileData: ArrayBuffer, name: string, size: number, type: string, status: string, startTime: number|null, endTime: number|null}|undefined>}
 */
export async function getFileById(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readonly');
    const store = tx.objectStore('input_files');
    return await requestToPromise(store.get(id));
  } catch (err) {
    console.error('[idb] getFileById error:', err);
    throw err;
  }
}

/**
 * Updates the `status` field of an `input_files` record in-place.
 * Reads the existing record first so no other fields are lost.
 *
 * @param {number} id     - The record's auto-generated id.
 * @param {'pending'|'sent'|'processing'|'processed'|'failed'} status - New status value.
 * @returns {Promise<void>}
 */
export async function updateFileStatus(id, status) {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readwrite');
    const store = tx.objectStore('input_files');

    // Read the existing record
    const record = await requestToPromise(store.get(id));
    if (!record) {
      throw new Error(`[idb] updateFileStatus: record id=${id} not found`);
    }

    record.status = status;
    if (status === 'processing' && !record.startTime) {
      record.startTime = Date.now();
    }
    if (status === 'processed' || status === 'failed') {
      record.endTime = Date.now();
    }

    await requestToPromise(store.put(record));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] updateFileStatus error:', err);
    throw err;
  }
}

/**
 * Deletes an `input_files` record by its primary key.
 *
 * @param {number} id - The record's auto-generated id.
 * @returns {Promise<void>}
 */
export async function deleteFile(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readwrite');
    const store = tx.objectStore('input_files');
    await requestToPromise(store.delete(id));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] deleteFile error:', err);
    throw err;
  }
}

/**
 * Clears all records from the `input_files` store.
 *
 * @returns {Promise<void>}
 */
export async function clearInputFiles() {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readwrite');
    const store = tx.objectStore('input_files');
    await requestToPromise(store.clear());
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] clearInputFiles error:', err);
    throw err;
  }
}

/**
 * Returns all `input_files` records whose `status` is `'pending'`,
 * using the `by_status` index for efficient lookup.
 *
 * @returns {Promise<Array<{id: number, fileData: ArrayBuffer, name: string, size: number, type: string, status: string}>>}
 */
export async function getPendingFiles() {
  try {
    const db = await openDB();
    const tx = db.transaction('input_files', 'readonly');
    const store = tx.objectStore('input_files');
    const index = store.index('by_status');
    const records = await requestToPromise(index.getAll('pending'));
    records.sort((a, b) => a.id - b.id);
    return records;
  } catch (err) {
    console.error('[idb] getPendingFiles error:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// config store
// ---------------------------------------------------------------------------

/**
 * Retrieves a value from the `config` store by key.
 *
 * @param {string} key - The config key (e.g. `'profiles'`, `'batchSize'`).
 * @returns {Promise<any|null>} The stored `value`, or `null` if not found.
 */
export async function getConfig(key) {
  try {
    const db = await openDB();
    const tx = db.transaction('config', 'readonly');
    const store = tx.objectStore('config');
    const record = await requestToPromise(store.get(key));
    return record !== undefined ? record.value : null;
  } catch (err) {
    console.error('[idb] getConfig error:', err);
    throw err;
  }
}

/**
 * Upserts a value into the `config` store.
 * If a record with this key already exists it is overwritten.
 *
 * @param {string} key   - The config key.
 * @param {any}    value - The value to store (must be structured-cloneable).
 * @returns {Promise<void>}
 */
export async function setConfig(key, value) {
  try {
    const db = await openDB();
    const tx = db.transaction('config', 'readwrite');
    const store = tx.objectStore('config');
    await requestToPromise(store.put({ key, value }));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] setConfig error:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// output_buffer store
// ---------------------------------------------------------------------------

/**
 * Returns the current accumulated text from the `output_buffer` store.
 *
 * @returns {Promise<string>} Accumulated text, or `''` if the buffer is empty.
 */
export async function getOutputBuffer() {
  try {
    const db = await openDB();
    const tx = db.transaction('output_buffer', 'readonly');
    const store = tx.objectStore('output_buffer');
    const record = await requestToPromise(store.get('text'));
    return record !== undefined ? record.value : '';
  } catch (err) {
    console.error('[idb] getOutputBuffer error:', err);
    throw err;
  }
}

/**
 * Appends `text` (followed by a newline) to the existing `output_buffer`.
 * Reads the current value first to prevent race-condition overwriting when
 * called in sequence — callers should await each call.
 *
 * @param {string} text - The text chunk to append.
 * @returns {Promise<void>}
 */
export async function appendOutputBuffer(text) {
  try {
    const db = await openDB();
    const tx = db.transaction('output_buffer', 'readwrite');
    const store = tx.objectStore('output_buffer');

    const record = await requestToPromise(store.get('text'));
    const current = record !== undefined ? record.value : '';
    const updated = current + text + '\n';

    await requestToPromise(store.put({ key: 'text', value: updated }));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] appendOutputBuffer error:', err);
    throw err;
  }
}

/**
 * Deletes the `'text'` record from the `output_buffer` store,
 * effectively clearing all accumulated output.
 *
 * @returns {Promise<void>}
 */
export async function clearOutputBuffer() {
  try {
    const db = await openDB();
    const tx = db.transaction('output_buffer', 'readwrite');
    const store = tx.objectStore('output_buffer');
    await requestToPromise(store.delete('text'));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] clearOutputBuffer error:', err);
    throw err;
  }
}

/**
 * Replaces the entire `output_buffer` content with the given text.
 * Unlike `appendOutputBuffer`, this overwrites whatever was stored before.
 *
 * @param {string} text - The new buffer content.
 * @returns {Promise<void>}
 */
export async function setOutputBuffer(text) {
  try {
    const db = await openDB();
    const tx = db.transaction('output_buffer', 'readwrite');
    const store = tx.objectStore('output_buffer');
    await requestToPromise(store.put({ key: 'text', value: text }));
    await txToPromise(tx);
  } catch (err) {
    console.error('[idb] setOutputBuffer error:', err);
    throw err;
  }
}
