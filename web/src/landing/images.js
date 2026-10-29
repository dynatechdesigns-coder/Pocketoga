// Which landing images exist, decided at build time by scripts/landing-images.mjs
// (photo, else illustration, else left out), with their real sizes.
import slots from "virtual:landing-images";

export const image = (slot) => slots[slot] ?? null;
export const hasImage = (slot) => slot in slots;
