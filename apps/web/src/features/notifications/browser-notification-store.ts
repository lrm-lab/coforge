import { isFreshNotification, MAX_NOTIFICATION_AGE_MS } from "./notification-routing";

const DATABASE = "coforge-browser-notifications";
const INSTALLATION = "installation";
const CLAIMS = "claims";
const EXPIRY = "expiresAt";

function openNotificationDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(INSTALLATION);
      open.result.createObjectStore(CLAIMS).createIndex(EXPIRY, EXPIRY);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}

async function writeNotificationState<T>(
  storeName: string,
  write: (store: IDBObjectStore, result: (value: T) => void) => void,
): Promise<T> {
  const database = await openNotificationDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = () => reject(transaction.error);
      write(transaction.objectStore(storeName), (next) => {
        value = next;
      });
    });
  } finally {
    database.close();
  }
}

export function browserInstallationId(): Promise<string> {
  return writeNotificationState(INSTALLATION, (store, result) => {
    const read = store.get("id");
    read.onsuccess = () => {
      const id = read.result ?? crypto.randomUUID();
      if (!read.result) store.add(id, "id");
      result(id);
    };
  });
}

export function claimBrowserNotification(viewerId: string, messageId: string, at: number) {
  return writeNotificationState<boolean>(CLAIMS, (store, result) => {
    const key = [viewerId, messageId];
    const read = store.get(key);
    read.onsuccess = () => {
      const now = Date.now();
      if (!isFreshNotification(at, now) || read.result?.expiresAt >= now) {
        result(false);
        return;
      }
      store.put({ expiresAt: at + MAX_NOTIFICATION_AGE_MS }, key);
      const expired = store.index(EXPIRY).openCursor(IDBKeyRange.upperBound(now, true));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      result(true);
    };
  });
}
