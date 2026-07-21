import { encryptJSON, decryptJSON } from '../crypto/crypto.js';

const DB_NAME = 'finance-tracker';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('records')) {
        const store = db.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('type', 'type', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function getMeta(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'meta', 'readonly').get(key);
    req.onsuccess = () => resolve(req.result?.value);
    req.onerror = () => reject(req.error);
  });
}

export async function setMeta(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'meta', 'readwrite').put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllRawRecords() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'records', 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRawRecord(row) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'records', 'readwrite').put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRawRecord(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, 'records', 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// --- Encrypted-record convenience API, used once the encryption key is available ---

export async function loadAllDecrypted(key) {
  const rows = await getAllRawRecords();
  const out = [];
  for (const row of rows) {
    const payload = await decryptJSON(key, row);
    out.push({ ...payload, id: row.id, type: row.type });
  }
  return out;
}

export async function saveEncrypted(key, type, entity) {
  const { iv, ciphertext } = await encryptJSON(key, entity);
  await putRawRecord({ id: entity.id, type, iv, ciphertext });
}

export async function deleteEncrypted(id) {
  await deleteRawRecord(id);
}
