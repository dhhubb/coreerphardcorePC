'use client';

import type { StateStorage } from 'zustand/middleware';

/**
 * An IndexedDB-backed Zustand `StateStorage` (F7).
 *
 * F3 persisted the till's cart — including its parked carts ("holds") — to `localStorage`. The brief
 * asks the holds to live in an IndexedDB table, so a parked cart survives a browser restart and a
 * large cart does not compete with the small synchronous `localStorage` budget. This is the one
 * storage the cart store uses by default; a test still injects an in-memory storage, so the persist
 * round-trip is unchanged.
 *
 * Where IndexedDB is absent (a Node import, an SSR pass) it degrades to an in-memory map rather than
 * throwing, so importing the store on the server is always safe.
 */

/** One object store, one out-of-line key per persist `name`. */
export function createIndexedDbStorage(dbName: string, storeName: string): StateStorage {
  if (typeof indexedDB === 'undefined') return memoryStorage();

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to open IndexedDB'));
    });

  const run = <T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(storeName, mode);
          const request = fn(transaction.objectStore(storeName));
          request.onsuccess = () => resolve(request.result as T);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
          transaction.oncomplete = () => db.close();
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );

  return {
    getItem: (name) =>
      run<string | null>('readonly', (store) => store.get(name)).then((value) => value ?? null),
    setItem: (name, value) =>
      run<void>('readwrite', (store) => store.put(value, name)).then(() => undefined),
    removeItem: (name) =>
      run<void>('readwrite', (store) => store.delete(name)).then(() => undefined),
  };
}

/** An in-memory `StateStorage`, used where IndexedDB is absent (Node, SSR). */
export function memoryStorage(): StateStorage {
  const map = new Map<string, string>();
  return {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => void map.set(name, value),
    removeItem: (name) => void map.delete(name),
  };
}
