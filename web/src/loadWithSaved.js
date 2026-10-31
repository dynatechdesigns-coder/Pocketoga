// One screen load, with the last known data as a fallback for a lost
// connection only. Returns the screen state to show:
//   fresh data            -> { data, saved: null }, and the data is saved
//   network error/timeout -> saved data with { saved: { savedAt } } when there
//                            is some, otherwise the normal error
//   anything else         -> the normal error (a 400, 401, 403, 500... is
//                            never hidden behind saved data)
// Plain JavaScript so the web tests can run it under node.
import { friendlyError, isNetworkFailure, isNotBuilt } from "./api.js";
import { savedData } from "./savedData.js";

export async function loadWithSaved(loader, { shopId, cacheKey, prepare, store = savedData } = {}) {
  try {
    const data = await loader();
    if (cacheKey) store.save(shopId, cacheKey, prepare ? prepare(data) : data).catch(() => {}); // not awaited: never slows the screen
    return { loading: false, data, error: null, unavailable: false, saved: null, network: false };
  } catch (err) {
    const network = isNetworkFailure(err);
    if (network && cacheKey) {
      const hit = await store.load(shopId, cacheKey).catch(() => null);
      if (hit) return { loading: false, data: hit.data, error: null, unavailable: false, saved: { savedAt: hit.savedAt }, network: true };
    }
    return { loading: false, data: null, error: friendlyError(err), unavailable: isNotBuilt(err), saved: null, network };
  }
}
