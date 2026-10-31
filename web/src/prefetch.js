// Quiet background refresh of the saved copies behind Money, Debts and Reports,
// so each screen has a recent copy even if the trader never opened it. It runs
// when the app opens or comes back to the foreground, with a working connection
// and a signed-in shop, at most once every 10 minutes, one request at a time,
// and only while nothing else is being loaded (the screen the trader is on
// always goes first). The first failed request, a lost connection, a sign-out
// or another shop stops it at once. It shows nothing: no spinner, label or
// error. Plain JavaScript so the web tests can run it under node.
export const PREFETCH_EVERY_MS = 10 * 60 * 1000;
export const PREFETCH_START_MS = 3000; // let the screen on show load first
export const PREFETCH_IDLE_POLL_MS = 1000;
export const PREFETCH_IDLE_GIVE_UP_MS = 30_000;

// getShop() -> the signed-in (non-demo) shop { id } or null, read fresh each time.
// isOnline() -> true when the connection is working. isIdle() -> true when no
// other request is running. activeShopId() -> the shop the API layer is set to.
export function createPrefetch({ getShop, isOnline, isIdle, activeShopId, tasks, store, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const lastRun = new Map(); // shop id -> when this shop's last refresh started
  let running = false;
  let stopped = false;
  let timer = null;
  let release = null; // lets stop() end a wait at once

  const sameShop = (shopId) => {
    const shop = getShop();
    return !stopped && !!shop && shop.id === shopId && activeShopId() === shopId;
  };
  const canGo = (shopId) => sameShop(shopId) && isOnline();

  // Resolves true once nothing else is loading, false if it should give up.
  const untilIdle = (shopId) =>
    new Promise((resolve) => {
      const started = now();
      release = () => resolve(false);
      const check = () => {
        timer = null;
        if (!canGo(shopId)) return resolve(false);
        if (isIdle()) return resolve(true);
        if (now() - started >= PREFETCH_IDLE_GIVE_UP_MS) return resolve(false);
        timer = setTimer(check, PREFETCH_IDLE_POLL_MS);
      };
      check();
    });

  async function run(shopId) {
    for (const task of tasks) {
      if (!(await untilIdle(shopId))) return;
      let data;
      try {
        data = await task.load();
      } catch {
        return; // one failure stops the whole refresh
      }
      if (!canGo(shopId)) return; // never save under another shop or after sign-out
      try {
        await store.save(shopId, task.key, task.prepare ? task.prepare(data) : data);
      } catch {
        return;
      }
    }
  }

  return {
    // Call on open and on every return to the foreground. Returns when the
    // refresh it started is over (or at once when there is nothing to do).
    async trigger() {
      const shop = getShop();
      if (stopped || running || !shop || !isOnline() || activeShopId() !== shop.id) return;
      if (now() - (lastRun.get(shop.id) ?? -Infinity) < PREFETCH_EVERY_MS) return;
      lastRun.set(shop.id, now()); // a failed run waits its 10 minutes too
      running = true;
      try {
        await new Promise((resolve) => {
          release = resolve;
          timer = setTimer(resolve, PREFETCH_START_MS);
        });
        timer = null;
        if (canGo(shop.id)) await run(shop.id);
      } finally {
        running = false;
      }
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      release?.();
    },
  };
}
