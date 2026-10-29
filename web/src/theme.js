// Light by default; dark only when the trader picks it, remembered on this
// device. index.html applies it before first paint (window.__applyTheme);
// this file changes it from the app.
const KEY = "pocketoga.theme";

export const isDark = () => document.documentElement.classList.contains("dark");

export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked (private mode): the choice lasts until the page closes.
  }
  window.__applyTheme?.();
  // Storage blocked, so the saved value could not be read back: set it here.
  if (isDark() !== (theme === "dark")) {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0d0d1e" : "#f7f8fc";
  }
  // Every theme control (header button, Settings) follows the change.
  window.dispatchEvent(new Event("pocketoga:theme"));
}
