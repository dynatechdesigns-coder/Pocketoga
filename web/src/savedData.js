// Last known data for the Money, Debts and Reports screens, kept on this
// device only (never sent anywhere), one set per shop. IndexedDB first, with
// localStorage as the fallback; every call is wrapped so a blocked or full
// store never breaks a screen. Only screen data goes in here: never audio,
// photos or WhatsApp content. A shop's data is deleted on sign-out and when
// another shop is opened. Plain JavaScript so the web tests can run it.
const DB = "pocketoga-saved";
const STORE = "items";
const LS_PREFIX = "pocketoga.saved.";

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function localBackend(ls) {
  const prefix = (shopId) => `${LS_PREFIX}${shopId}.`;
  return {
    async put(shopId, key, record) {
      ls.setItem(prefix(shopId) + key, JSON.stringify(record));
    },
    async get(shopId, key) {
      const raw = ls.getItem(prefix(shopId) + key);
      return raw ? JSON.parse(raw) : null;
    },
    async clear(shopId) {
      const p = prefix(shopId);
      const keys = [];
      for (let i = 0; i < ls.length; i++) if (ls.key(i)?.startsWith(p)) keys.push(ls.key(i));
      keys.forEach((k) => ls.removeItem(k));
    },
  };
}

async function openIdb(idb) {
  const db = await new Promise((resolve, reject) => {
    const open = idb.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("blocked"));
  });
  const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
  const id = (shopId, key) => `${shopId}\u0000${key}`;
  return {
    async put(shopId, key, record) {
      await wrap(tx("readwrite").put({ id: id(shopId, key), shopId, ...record }));
    },
    async get(shopId, key) {
      return (await wrap(tx("readonly").get(id(shopId, key)))) ?? null;
    },
    async clear(shopId) {
      const rows = await wrap(tx("readonly").getAll());
      for (const row of rows) if (row.shopId === shopId) await wrap(tx("readwrite").delete(row.id));
    },
  };
}

export function createSavedData({ idb = globalThis.indexedDB, ls, now = Date.now } = {}) {
  let storage = ls;
  if (storage === undefined) {
    try {
      storage = globalThis.localStorage ?? null;
    } catch {
      storage = null;
    }
  }
  const local = storage ? localBackend(storage) : null;
  let idbReady = null;
  const getIdb = () => (idbReady ??= idb ? openIdb(idb).catch(() => null) : Promise.resolve(null));

  // Try IndexedDB, then localStorage; never throws.
  async function each(fn) {
    for (const backend of [await getIdb(), local]) {
      if (!backend) continue;
      try {
        const out = await fn(backend);
        if (out !== undefined) return out;
      } catch {
        // try the next one
      }
    }
    return undefined;
  }

  return {
    // The data as it came from the server, with when it was saved.
    async save(shopId, key, data) {
      if (!shopId || !key) return false;
      const record = { key, savedAt: new Date(now()).toISOString(), data };
      const ok = await each(async (b) => (await b.put(shopId, key, record), true));
      return ok === true;
    },
    // { data, savedAt } for this shop, or null. Another shop's data is never returned.
    async load(shopId, key) {
      if (!shopId || !key) return null;
      const hit = await each(async (b) => {
        const r = await b.get(shopId, key);
        return r && r.data !== undefined ? { data: r.data, savedAt: r.savedAt } : undefined;
      });
      return hit ?? null;
    },
    // Everything saved for a shop, in both places.
    async clearShop(shopId) {
      if (!shopId) return;
      for (const backend of [await getIdb(), local]) {
        if (!backend) continue;
        try {
          await backend.clear(shopId);
        } catch {
          // keep clearing the other one
        }
      }
    },
  };
}

// Debts also carry customers' phone numbers (stored with consent). They are
// not needed to read balances, so the saved copy leaves them out.
export const withoutPhones = (d) => ({ ...d, customers: (d?.customers ?? []).map((c) => ({ ...c, phone: null })) });

export const savedData = createSavedData();
