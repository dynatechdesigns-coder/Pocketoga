// The offline queue: notes (typed, spoken, photographed) that could not be
// sent are kept and sent later, one at a time, oldest first. Each item keeps
// one request id for all its tries so the server can spot a repeat. Sending
// only asks for a proposal; the trader still confirms every one, so nothing
// here can reach the ledger. Storage and sending are passed in, so this file
// is plain JavaScript the web tests run under node.
import { ApiError, friendlyError } from "./api.js";

export const MAX_TRIES = 5;
export const SAVED_MESSAGE = "Saved. It will send when you are back online.";
export const OFFLINE_MESSAGE = "You are offline. Try again when you are back online.";
export const SEND_TIMEOUT_MS = 60_000;

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// Wait before try n+1 after n failures: 5 s, 15 s, 45 s, 2 min 15 s.
export const backoffMs = (failures) => Math.min(5000 * 3 ** Math.max(0, failures - 1), 600_000);

// The id and time of one note, made when the trader sends it and kept for every
// retry and for the queue, so a repeat is recognisable.
export const newMeta = (now = Date.now) => ({ requestId: newId(), spokenAt: new Date(now()).toISOString() });

export const isNetworkError = (err) => err instanceof ApiError && err.status === 0;


// store: { getAll(), put(item), delete(id) } (async). send(item, signal) ->
// proposal. onResult(item, proposal) runs after each successful send.
export function createQueue({ store, send, onResult, isOnline = () => globalThis.navigator?.onLine !== false, now = Date.now, timeoutMs = SEND_TIMEOUT_MS }) {
  let items = [];
  let loaded = null;
  let flushing = false;
  let again = false;
  let timer = null;
  let inflight = null; // { id, controller }
  const listeners = new Set();
  const snapshot = () => [...items].sort((a, b) => a.seq - b.seq);
  const emit = () => listeners.forEach((l) => l(snapshot()));

  const load = () => (loaded ??= store.getAll().then((rows) => void (items = rows)));

  async function save(item) {
    const i = items.findIndex((x) => x.id === item.id);
    if (i >= 0) items[i] = item;
    else items.push(item);
    await store.put(item);
    emit();
  }

  async function remove(id) {
    items = items.filter((x) => x.id !== id);
    await store.delete(id);
    emit();
  }

  // Keep a note. `failed`: a live send just failed, so it already counts as
  // one try and waits out the first backoff.
  async function enqueue(kind, payload, { hint = null, requestId = newId(), spokenAt = new Date(now()).toISOString(), failed = false } = {}) {
    await load();
    const seq = items.reduce((m, x) => Math.max(m, x.seq), 0) + 1;
    const item = {
      id: newId(),
      requestId,
      kind,
      payload,
      hint,
      spokenAt,
      createdAt: new Date(now()).toISOString(),
      seq,
      tries: failed ? 1 : 0,
      nextAt: failed ? now() + backoffMs(1) : 0,
      status: "waiting",
      error: null,
    };
    await save(item);
    schedule();
    return item;
  }

  async function cancel(id) {
    await load();
    if (inflight?.id === id) inflight.controller.abort(); // its answer is ignored
    await remove(id);
  }

  // "Needs you" -> try again from the start (same request id).
  async function retry(id) {
    await load();
    const item = items.find((x) => x.id === id);
    if (!item) return;
    await save({ ...item, status: "waiting", tries: 0, nextAt: 0, error: null });
    flush();
  }

  async function sendOne(item) {
    const controller = new AbortController();
    inflight = { id: item.id, controller };
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const proposal = await send(item, controller.signal);
      if (!items.some((x) => x.id === item.id)) return; // cancelled meanwhile
      await remove(item.id);
      onResult?.(item, proposal);
    } catch (err) {
      if (!items.some((x) => x.id === item.id)) return; // cancelled meanwhile
      const tries = item.tries + 1;
      const network = isNetworkError(err) || err?.name === "AbortError";
      // A reply from the server is never hidden: a 4xx stops the item at once
      // with the server's message; a 5xx, a 429 (too many requests), a 409 for
      // a repeat still being processed, or a lost connection is tried again.
      const serverRefused =
        err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429 && !(err.status === 409 && /being processed/i.test(err.message));
      if (serverRefused || tries >= MAX_TRIES) {
        const message = network ? `Could not reach PocketOga after ${MAX_TRIES} tries.` : friendlyError(err);
        await save({ ...item, tries, status: "needs-you", error: message, nextAt: 0 });
      } else {
        await save({ ...item, tries, nextAt: now() + backoffMs(tries), error: network ? null : friendlyError(err) });
      }
    } finally {
      clearTimeout(timeout);
      inflight = null;
    }
  }

  // Sends what is due, oldest first, one at a time. Does nothing offline.
  async function flush() {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    try {
      await load();
      do {
        again = false;
        if (!isOnline()) break;
        for (const item of snapshot()) {
          if (!isOnline()) break;
          const current = items.find((x) => x.id === item.id);
          if (!current || current.status !== "waiting" || current.nextAt > now()) continue;
          await sendOne(current);
        }
      } while (again);
    } finally {
      flushing = false;
    }
    schedule();
  }

  // Wake up again when the next backed-off item is due.
  function schedule() {
    clearTimeout(timer);
    const due = items.filter((x) => x.status === "waiting" && x.nextAt > 0).map((x) => x.nextAt);
    if (due.length === 0 || !isOnline()) return;
    timer = setTimeout(flush, Math.max(0, Math.min(...due) - now()));
    timer?.unref?.(); // a pending retry never keeps node (the tests) alive
  }

  return {
    enqueue,
    cancel,
    retry,
    flush,
    load: async () => {
      await load();
      emit();
      return snapshot();
    },
    list: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: () => clearTimeout(timer),
  };
}
