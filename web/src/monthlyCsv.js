// "Download spreadsheet (CSV)" on Reports: the month list, the request and the
// file name, in one place. Plain JavaScript so the web tests can run it.
//
//   GET /reports/monthly.csv?month=YYYY-MM
//   200  a CSV file (UTF-8, Content-Disposition attachment)
//   400  { error }
// The file is saved straight from the response. It is never put in a cache and
// never opened in the page.
export const CSV_ROUTE = "/reports/monthly.csv";
export const MONTHS_BACK = 12;
export const CSV_OFFLINE_MESSAGE = "You need data to download this. Try again when you are back online.";
export const CSV_FAILED_MESSAGE = "Could not make the spreadsheet. Please try again in a moment.";
export const CSV_NETWORK_MESSAGE = "Cannot reach PocketOga. Check your connection and try again.";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

// This month first, then the 12 months before it: 13 entries in all.
// `today` is a Lagos day "YYYY-MM-DD" (lagosToday() from format.js).
export function monthOptions(today, back = MONTHS_BACK) {
  const m = /^(\d{4})-(\d{2})/.exec(String(today ?? ""));
  if (!m) return [];
  let year = Number(m[1]);
  let month = Number(m[2]);
  const out = [];
  for (let i = 0; i <= back; i++) {
    out.push({ value: `${year}-${pad(month)}`, label: `${MONTH_NAMES[month - 1]} ${year}${i === 0 ? " (this month)" : ""}` });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(v ?? ""));
export const csvPath = (month) => `${CSV_ROUTE}?month=${encodeURIComponent(month)}`;
export const csvFileName = (month) => `pocketoga-${month}.csv`;

// The server's { error } is shown when it is plain words; code-style text and
// the app's own "server error 500" filler get a plain sentence instead.
const TECHNICAL_WORDS = /\b(undefined|null|payload|json|exception|stack|sqlite|ledger)\b|^server error \d+$/i;
const CODE_NAMES = /[a-z][A-Z]|_/;
export function csvError(err) {
  const status = err?.status;
  if (status === 0) return CSV_NETWORK_MESSAGE;
  const m = typeof err?.message === "string" ? err.message.trim() : "";
  if (status >= 400 && status < 500 && m && !TECHNICAL_WORDS.test(m) && !CODE_NAMES.test(m.replace(/PocketOga/g, "Pocket"))) return m.charAt(0).toUpperCase() + m.slice(1);
  return CSV_FAILED_MESSAGE;
}
