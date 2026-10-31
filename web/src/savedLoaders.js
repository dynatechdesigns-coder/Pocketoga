// What the Money, Debts and Reports screens load, in one place, so the screens
// and the quiet background refresh (prefetch.js) read exactly the same data and
// save it under the same keys. Plain JavaScript so the web tests can run it.
import { getCustomers, getDebts, getLedger, getProfit, getPromises, getReport } from "./api.js";
import { withoutPhones } from "./savedData.js";

// Money: the report, plus the ledger's own check of its hash chain for the chip.
// The chip is optional: if the ledger cannot load, Money still shows.
// `serial` sends the requests one after another (the background refresh).
export async function loadMoney(serial = false) {
  const verifyOf = () => getLedger().then((l) => l.verify, () => null);
  if (serial) {
    const report = await getReport();
    return { ...report, verify: await verifyOf() };
  }
  const [report, verify] = await Promise.all([getReport(), verifyOf()]);
  return { ...report, verify };
}

// Debts: the ranked chase list, every promise, and customers (optional, so
// Debts still works without them). `serial` sends them one after another.
export async function loadDebts(serial = false) {
  if (serial) {
    const { debts, chase } = await getDebts();
    const promises = await getPromises();
    const customers = await getCustomers().catch(() => []);
    return { debts, chase, promises, customers };
  }
  const [{ debts, chase }, promises, customers] = await Promise.all([getDebts(), getPromises(), getCustomers().catch(() => [])]);
  return { debts, chase, promises, customers };
}

// What is kept on the device (phone numbers stay out of it).
export const DEBTS_SAVED = { key: "debts", prepare: withoutPhones };

// The saved copies the background refresh keeps recent, in the order it loads
// them: Money, Debts, Reports (leaks, then the default "today" profit).
export const PREFETCH_TASKS = [
  { key: "money", load: () => loadMoney(true) },
  { key: DEBTS_SAVED.key, load: () => loadDebts(true), prepare: DEBTS_SAVED.prepare },
  { key: "report", load: () => getReport() },
  { key: "profit:today", load: () => getProfit("today") },
];
