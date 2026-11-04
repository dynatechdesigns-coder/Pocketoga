// The numbers and words on the public "How accurate is PocketOga?" page, in one
// place. Run on 2 Nov 2026. Plain JavaScript so the web tests can check them.
// Nothing here is computed from live data: it is a fixed, dated test result.

export const ACCURACY_PATH = "/accuracy";
export const ACCURACY_LINK = "How accurate is PocketOga?";
export const ACCURACY_TITLE = "How accurate is PocketOga?";
export const ACCURACY_DATE = "2 Nov 2026";

export const TESTED = {
  heading: "What we tested",
  text: "16 spoken notes in the author's own voice (English, Pidgin and one Yoruba). Each note was run 3 times, in two setups: a new shop with no history, and an established shop with known customers. That is 96 runs in total.",
  runs: 96,
};

// The bar: three parts that add up to 96.
export const RESULTS = {
  heading: "Results",
  total: 96,
  parts: [
    { key: "correct", label: "Fully correct", count: 72, percent: 75, note: "PocketOga got everything right." },
    { key: "flagged", label: "Wrong, but flagged", count: 24, percent: 25, note: "Something was wrong, and PocketOga asked you to check it." },
    { key: "silent", label: "Wrong and not flagged", count: 0, percent: 0, note: "Wrong with no warning. This did not happen." },
  ],
};

export const SETUPS = {
  heading: "By shop",
  rows: [
    { label: "Established shop", correct: 37, flagged: 11, silent: 0 },
    { label: "New shop", correct: 35, flagged: 13, silent: 0 },
  ],
};

export const FIELDS = {
  heading: "By detail",
  rows: [
    { label: "Item type", right: 86 },
    { label: "Amounts", right: 78 },
    { label: "Customer names", right: 86 },
    { label: "Item counts", right: 92 },
  ],
  of: 96,
};

export const FLAGGED = {
  heading: "What \"flagged\" means",
  text: "PocketOga asks you a question or shows a check card, and nothing is saved until you confirm.",
};

export const STRUGGLES = {
  heading: "Where it struggles",
  items: [
    "A part payment with no sale in the sentence, like \"pay the remain 2500\".",
    "Totals with \"each\" and several items.",
    "Names that sound alike, like \"Mama Bisi\" heard as \"Mama busy\".",
    "Yoruba is experimental.",
    "Meta's audio call sometimes returns an error. When it does, nothing is saved without a check.",
  ],
};

export const SPEED = {
  heading: "Speed",
  items: [
    "Typed notes took a median of 5.4 seconds. The slowest took 6.9 seconds.",
    "Most short voice notes took 2 to 8 seconds. A few took longer.",
  ],
};

export const LIMITS = {
  heading: "Limits",
  items: [
    "This is one speaker and a small sample. The numbers are a guide, not a guarantee.",
    "The open-weight second opinion answered in time on 12 of 12 typed notes in the speed check.",
  ],
};

export const SUMMARY = "72 of 96 fully correct. 24 of 96 wrong but flagged. 0 of 96 wrong and not flagged.";

export const REAL_WORLD = {
  heading: "Real-world testing",
  text: "Over 15 people tried the live app, and several left written feedback in the app. The reviews were mostly positive, and they pointed out a few things, which we fixed during the event week: it asked for customer names that traders often don't know (names are now optional), it couldn't read shorthand like \"63\" for ₦6,300 (it now asks which is meant), and only the newest entry could be edited (any entry can now be corrected). Those testers are not part of the numbers above, which come from the scripted run only.",
};
