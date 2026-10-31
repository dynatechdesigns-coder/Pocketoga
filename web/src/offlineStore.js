// IndexedDB home for the queue, one database per shop. Returns null when
// IndexedDB is not there (some private modes), so the screen says "You are
// offline" instead of pretending to keep the note.
const STORE = "items";

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function openQueueStore(shopId, idb = globalThis.indexedDB) {
  if (!idb) return null;
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const open = idb.open(`pocketoga-queue-${shopId}`, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
  } catch {
    return null;
  }
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  return {
    getAll: () => wrap(tx("readonly").getAll()),
    put: (item) => wrap(tx("readwrite").put(item)),
    delete: (id) => wrap(tx("readwrite").delete(id)),
  };
}
