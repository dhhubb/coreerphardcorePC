'use client';

/**
 * The till's device registration (decision 12).
 *
 * A till is registered once: the operator enters the 6-digit one-time code an admin minted on
 * /settings/devices, and the branch issues a device token. The token is kept in IndexedDB, not
 * localStorage: it is a durable credential that survives a reload, and IndexedDB is the same store
 * the outbox uses, so the till has one place to clear.
 *
 * The raw token is only ever in this store and in the one response that issued it; the branch keeps
 * only its hash (ADR-0024).
 */

export const DEVICE_DB_NAME = 'erp-branch-device';
export const DEVICE_DB_VERSION = 1;
export const DEVICE_STORE = 'device';
export const DEVICE_KEY = 'registration';

export interface DeviceRegistration {
  deviceToken: string;
  tillId: string;
  label: string | null;
  registeredAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB_NAME, DEVICE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_STORE)) {
        db.createObjectStore(DEVICE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open the device store'));
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(DEVICE_STORE, mode);
        const request = fn(transaction.objectStore(DEVICE_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('device store request failed'));
        transaction.oncomplete = () => db.close();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('device store transaction aborted'));
      }),
  );
}

/** Persist the device token, replacing any previous registration. */
export async function saveDeviceRegistration(
  registration: Omit<DeviceRegistration, 'registeredAt'> & { registeredAt?: string },
): Promise<DeviceRegistration> {
  const entry = {
    key: DEVICE_KEY,
    deviceToken: registration.deviceToken,
    tillId: registration.tillId,
    label: registration.label,
    registeredAt: registration.registeredAt ?? new Date().toISOString(),
  };
  await runTransaction('readwrite', (store) => store.put(entry));
  return entry;
}

/** Read the stored registration, or null when the till has never registered. */
export async function loadDeviceRegistration(): Promise<DeviceRegistration | null> {
  const row = await runTransaction<{ key: string } & DeviceRegistration | undefined>(
    'readonly',
    (store) => store.get(DEVICE_KEY),
  );
  if (!row) return null;
  return {
    deviceToken: row.deviceToken,
    tillId: row.tillId,
    label: row.label,
    registeredAt: row.registeredAt,
  };
}

/** Forget the registration (a re-registration or a decommissioned till). */
export async function clearDeviceRegistration(): Promise<void> {
  await runTransaction('readwrite', (store) => store.delete(DEVICE_KEY));
}
