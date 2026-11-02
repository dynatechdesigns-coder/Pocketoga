// Deterministic Nigerian money parser. Plain code only: the model never does
// math. Parses a trader's amount phrase into integer kobo.
//
// Handles: "15k", "2.5k", "five k", "N2,500", "₦1,000", "5 hundred",
// "fifteen thousand", "one thousand five hundred", "remain 3k".

const ONES = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALES = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };

const REMAINDER_WORDS = "remains|remain|remaining|remainder|balances?|rest|left";

function fail(phrase) {
  throw new Error(`could not parse amount: "${phrase}"`);
}

function parseDecimalDigits(str, phrase) {
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(str)) fail(phrase);
  return Number(str);
}

// Standard English number words, plus digit tokens ("5 hundred") and decimals
// ("2.5 thousand"). Returns naira (may be fractional).
function parseWords(s, phrase) {
  const tokens = s.split(/[\s-]+/).filter((t) => t && t !== "and");
  if (tokens.length === 0) fail(phrase);
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (ONES[token] !== undefined) {
      current += ONES[token];
    } else if (TENS[token] !== undefined) {
      current += TENS[token];
    } else if (/^\d+(\.\d+)?$/.test(token)) {
      current += Number(token);
    } else if (token === "hundred") {
      current = (current || 1) * 100;
    } else if (SCALES[token] !== undefined) {
      total += (current || 1) * SCALES[token];
      current = 0;
    } else {
      fail(phrase);
    }
  }
  return total + current;
}

function toKobo(naira, phrase) {
  const kobo = naira * 100;
  const rounded = Math.round(kobo);
  // Epsilon absorbs float dust (e.g. 2.55k); genuinely fractional kobo fails.
  if (!Number.isFinite(kobo) || Math.abs(kobo - rounded) > 1e-6) {
    throw new Error(`amount is not whole kobo: "${phrase}"`);
  }
  return rounded;
}

// Parses one amount phrase. Returns { kobo, remainder } where remainder is
// true for "remain 3k"-style phrases. Throws on anything it cannot read.
export function parseNaira(phrase) {
  if (typeof phrase !== "string") throw new Error(`could not parse amount: "${phrase}"`);
  let s = phrase.trim().toLowerCase();
  if (!s) fail(phrase);

  let remainder = false;
  const pre = new RegExp(`^(${REMAINDER_WORDS})\\b\\s*`);
  const suf = new RegExp(`\\s*\\b(${REMAINDER_WORDS})$`);
  if (pre.test(s)) {
    remainder = true;
    s = s.replace(pre, "");
  } else if (suf.test(s)) {
    remainder = true;
    s = s.replace(suf, "");
  }

  if (/^(-|minus\b)\s*/.test(s)) {
    throw new Error(`negative amounts not allowed: "${phrase}"`);
  }

  s = s.replace(/₦/g, " ");
  s = s.replace(/\b(naira|ngn)\b/g, " ");
  s = s.replace(/^n(?=[\d,.\s])/, " "); // "N2,500" (word-numbers like "nine" are safe)
  s = s.replace(/,/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) fail(phrase);

  let naira;
  const kDigits = s.match(/^([\d.]+)\s*k$/);
  const kWords = s.match(/^(.+)\s+k$/);
  if (kDigits) {
    naira = parseDecimalDigits(kDigits[1], phrase) * 1000;
  } else if (/^[\d.]+$/.test(s)) {
    naira = parseDecimalDigits(s, phrase);
  } else if (kWords) {
    naira = parseWords(kWords[1], phrase) * 1000;
  } else {
    naira = parseWords(s, phrase);
  }
  return { kobo: toKobo(naira, phrase), remainder };
}

// Every naira amount stated in free text: digit tokens ("2500", "15k",
// "N2,500") plus English number-word runs ("forty-five hundred", "five k").
// Powers the heard-vs-amount magnitude check. Never throws; deduped.
const NUMBER_WORDS = new Set([...Object.keys(ONES), ...Object.keys(TENS), ...Object.keys(SCALES)]);
function wordsToNaira(run) {
  const toks = run.slice();
  let mult = 1;
  if (toks.length > 1 && toks[toks.length - 1] === "k") {
    toks.pop();
    mult = 1000;
  }
  return parseWords(toks.join(" "), toks.join(" ")) * mult;
}
export function extractNairaAmounts(text) {
  const out = [];
  const push = (n) => {
    if (Number.isFinite(n) && n > 0) out.push(n);
  };
  let s = String(text ?? "").toLowerCase().replace(/₦/g, " ");
  s = s.replace(/\bn(?=\d)/g, " "); // "N2,500"
  // One pass in text order: "k"-suffixed digits stand alone ("15k"), bare
  // digits join the number-word run ("8 thousand" = 8000, not 8 + 1100).
  const tokens = s.match(/\d[\d,]*(?:\.\d+)?(?:\s*k\b)?|[a-z]+/g) ?? [];
  let run = [];
  const flush = () => {
    if (run.length > 0) {
      try {
        push(wordsToNaira(run));
      } catch {
        // Not a number run: ignore it.
      }
      run = [];
    }
  };
  for (const tok of tokens) {
    const km = tok.match(/^(\d[\d,]*(?:\.\d+)?)\s*k$/);
    if (km) {
      flush();
      push(Number(km[1].replace(/,/g, "")) * 1000);
      continue;
    }
    if (/^\d/.test(tok)) {
      run.push(tok.replace(/,/g, ""));
      continue;
    }
    if (tok === "and" || NUMBER_WORDS.has(tok) || (tok === "k" && run.length > 0)) run.push(tok);
    else flush();
  }
  flush();
  return [...new Set(out)];
}

// Shorthand spoken amounts ("63" meaning 6,300): one config place. A bare
// one- or two-digit amount under this many naira on a sale or debt of goods
// is ambiguous, so plain code offers both readings and the trader picks.
// Never applies at or above this threshold, or when a currency word or full
// number is spoken ("sixty-three naira", "6,300").
export const SHORTHAND_THRESHOLD_NAIRA = 200;

// Spoken digits transcribed with spaces ("6 3", "6 300", "1 5", "15 000")
// are the single number they sound like (63, 6300, 15, 15000). Join a digit
// run only when the first group is a single digit or every later group is
// exactly 3 digits; a left number with 3+ digits is already complete, so
// "4000 2 bags" and "rice 4000 3 crates" stay untouched. Merging runs before
// any amount check, so the magnitude check, the shorthand choice and the
// second-opinion re-read all see one number. Digit-word boundaries never
// merge ("2 bags of rice" keeps its "2"), and "15k" / "6,300" have no
// separated digits to join. Null-safe.
export function mergeSeparatedDigits(text) {
  if (text === null || text === undefined) return text;
  return String(text).replace(/\d+(?: +\d+)+/g, (run) => {
    const groups = run.split(/ +/);
    if (groups[0].length !== 1 && !groups.slice(1).every((g) => g.length === 3)) return run;
    return groups.join("");
  });
}

// Whole naira from the model to integer kobo. Rejects anything else.
export function nairaToKobo(n) {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new Error(`amount must be whole naira, got: ${String(n)}`);
  }
  if (n < 0) throw new Error(`amount must not be negative, got: ${n}`);
  return n * 100;
}

// Typed decimal naira (a string or number with at most 2 decimals) to
// integer kobo, with string maths only — never floats. Whole-naira numbers
// go through nairaToKobo unchanged.
export function decimalNairaToKobo(value) {
  if (typeof value === "number" && Number.isInteger(value)) return nairaToKobo(value);
  const s = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (/^-/.test(s)) throw new Error(`amount must not be negative, got: ${JSON.stringify(value)}`);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`amount must be a number with at most 2 decimals, got: ${JSON.stringify(value)}`);
  const kobo = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(kobo)) throw new Error(`amount is too large: ${JSON.stringify(value)}`);
  return kobo;
}

// "₦15,000" / "₦0.50" for clarifying questions.
export function formatKobo(kobo) {
  const sign = kobo < 0 ? "-" : "";
  const abs = Math.abs(kobo);
  const grouped = Math.floor(abs / 100).toLocaleString("en-US");
  const k = abs % 100;
  return k === 0 ? `${sign}₦${grouped}` : `${sign}₦${grouped}.${String(k).padStart(2, "0")}`;
}
