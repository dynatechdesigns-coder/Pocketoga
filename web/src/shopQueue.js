// The one offline queue for the open shop, plus the small "ready" lists that
// carry a sent item's proposal to the screen that shows it. Results are never
// saved here: a proposal waits for the trader's Save like any other note.
import { proposeAudio, proposeEntryCorrection, proposeManual, proposePhoto, proposeText } from "./api.js";
import { createQueue } from "./offlineQueue.js";
import { openQueueStore } from "./offlineStore.js";

// localStorage that shrugs when storage is blocked.
const keep = {
  get: (key) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      return [];
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // the result just is not remembered across a reload
    }
  },
};

// Proposals that arrived from the queue and wait for the trader to check them.
// area: "record" (typed and voice notes) or "alert" (photos).
const readyKey = (shopId, area) => `pocketoga.ready.${area}.${shopId}`;
export const READY_EVENT = "pocketoga:queued-result";
export const areaOf = (kind) => (kind === "photo" ? "alert" : "record");

export function pushReady(shopId, area, proposalId) {
  keep.set(readyKey(shopId, area), [...keep.get(readyKey(shopId, area)), proposalId]);
  window.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { area } }));
}

// The oldest waiting proposal id for an area, removed from the list.
export function popReady(shopId, area) {
  const [first, ...rest] = keep.get(readyKey(shopId, area));
  if (first !== undefined) keep.set(readyKey(shopId, area), rest);
  return first ?? null;
}

export const readyCount = (shopId, area) => keep.get(readyKey(shopId, area)).length;

// The send for one stored item, with its own request id and spoken time.
export function sendItem(item, signal) {
  const meta = { requestId: item.requestId, spokenAt: item.spokenAt };
  if (item.kind === "text") return proposeText(item.payload.text, item.hint ?? undefined, signal, meta);
  if (item.kind === "correction") return proposeEntryCorrection(item.payload.entryId, item.payload.changes, signal, meta);
  if (item.kind === "manual") return proposeManual(item.payload.entry, signal, meta);
  if (item.kind === "audio") return proposeAudio(item.payload.base64, "wav", item.hint ?? undefined, signal, meta);
  return proposePhoto(item.payload.base64, item.payload.format ?? "jpg", signal, meta);
}

const queues = new Map(); // shop id -> queue promise (null result: no IndexedDB)

// The queue for a shop, or null when IndexedDB is unavailable. Starts sending
// what is waiting as soon as it opens (app open) and whenever the browser
// comes back online.
export function getShopQueue(shopId) {
  if (!queues.has(shopId)) {
    queues.set(
      shopId,
      openQueueStore(shopId).then(async (store) => {
        if (!store) return null;
        const queue = createQueue({
          store,
          send: sendItem,
          onResult: (item, proposal) => pushReady(shopId, areaOf(item.kind), proposal.id),
        });
        await queue.load();
        window.addEventListener("online", () => queue.flush());
        queue.flush();
        return queue;
      })
    );
  }
  return queues.get(shopId);
}
