// The open shop ({ id, name, demo }) is remembered on this device.
const SHOP_KEY = "pocketoga.shop";

export function loadShop() {
  try {
    return JSON.parse(localStorage.getItem(SHOP_KEY));
  } catch {
    return null;
  }
}

// Storage can be blocked (private mode); then the shop is kept until the
// page closes.
export function saveShop(shop) {
  try {
    if (shop) localStorage.setItem(SHOP_KEY, JSON.stringify(shop));
    else localStorage.removeItem(SHOP_KEY);
  } catch {
    // nothing to do
  }
}

// A real shop is only open while its session token is live. The demo shop
// needs none.
export function hasSession(shop) {
  if (!shop) return false;
  if (shop.demo) return true;
  return typeof shop.token === "string" && shop.token !== "" && Date.parse(shop.expiresAt) > Date.now();
}

// The last shop that logged in on this device, so the next login only needs
// the code. Not a secret: the shop id alone opens nothing.
const LAST_KEY = "pocketoga.lastShop";

export function loadLastShop() {
  try {
    return localStorage.getItem(LAST_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveLastShop(id) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    // nothing to do
  }
}
