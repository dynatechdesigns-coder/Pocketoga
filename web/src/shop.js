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
