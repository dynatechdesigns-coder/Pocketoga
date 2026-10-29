// Dev-only stand-in for backend routes that are still being built. Fake data
// only, kept in memory (restarting the mock resets it). Never used in a build.
//
//   npm run mock:contract          (listens on MOCK_PORT, default 3999)
//   MOCK_CONTRACT=1 npm run dev    (Vite then sends /api here instead)
//
// New routes are answered here as PROJECT.md section 10 (Route contract) and the
// real server.mjs describe them: integer ids (null for names that exist only in
// the ledger), phones as digits with a country code, from/to as YYYY-MM-DD,
// chart labels written the way profit.mjs writes them, the real validation
// rules and error texts:
//   GET  /profit?period=today|week|month|year
//   GET  /expenses?period=...
//   GET  /products            POST /products/:id   { sellPriceKobo?, costPriceKobo? }
//   GET  /customers           POST /customers      { name, phone?, consent? }  (a phone needs consent: true)
//                             POST /customers/:id/clear-phone
//   POST /ledger/:id/correct  { amountKobo?, customer?, item?, quantity?, unit?, reason }
// GET /ledger is fetched from the real backend and each entry gains
// `correctedById` (null when not corrected). Corrections made here exist only
// in this mock's memory: the real ledger is never written. Everything else
// (/debts, /promises, /report, propose/confirm/fix/reject) is forwarded to
// BACKEND_URL unchanged. Once the real routes exist, drop MOCK_CONTRACT.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 3999);
const BACKEND_URL = new URL(process.env.BACKEND_URL ?? "http://localhost:3000");
const LAGOS_OFFSET_MS = 60 * 60 * 1000; // Africa/Lagos is UTC+1, no daylight saving

const DAY = 86400000;
const PERIODS = ["today", "week", "month", "year"];

// --- Fake data, one copy per shop -----------------------------------------------

function seedShop() {
  const now = Date.now();
  const ago = (days, hours = 0) => new Date(now - days * DAY - hours * 3600000).toISOString();
  return {
    products: [
      { id: 1, name: "Rice", unit: "bag", sellPriceKobo: 5900000, costPriceKobo: 5200000, stockOnHand: 7 },
      { id: 2, name: "Beans", unit: "bag", sellPriceKobo: 6500000, costPriceKobo: 6000000, stockOnHand: 2 },
      { id: 3, name: "Indomie", unit: "carton", sellPriceKobo: 900000, costPriceKobo: 900000, stockOnHand: 0 },
      // Negative on purpose: the real route returns it when more was sold than bought.
      { id: 4, name: "Groundnut oil", unit: "tin", sellPriceKobo: 4500000, costPriceKobo: null, stockOnHand: -2 },
      { id: 5, name: "Sugar", unit: "bag", sellPriceKobo: 7200000, costPriceKobo: 6600000, stockOnHand: 4 },
    ],
    // Clearly fake numbers (0803 000 00xx).
    customers: [
      { id: 1, name: "Mama Bisi", phone: "2348030000011", lastActivityAt: ago(1) },
      { id: 2, name: "Chinedu", phone: "2348030000012", lastActivityAt: ago(0, 2) },
      { id: 3, name: "Aunty Ngozi", phone: "2348030000013", lastActivityAt: ago(2) },
      { id: 4, name: "Ada", phone: null, lastActivityAt: ago(3) },
      { id: 5, name: "Tunde", phone: "447700900123", lastActivityAt: ago(2) },
      { id: 6, name: "Alhaji Musa", phone: "2348030000016", lastActivityAt: ago(40) },
    ],
    expenses: [
      { id: "e1", createdAt: ago(0, 3), category: "Transport", payee: "Keke to Mile 12", amountKobo: 250000 },
      { id: "e2", createdAt: ago(0, 1), category: "Food", payee: "Lunch for shop boy", amountKobo: 150000 },
      { id: "e3", createdAt: ago(2), category: "Market levy", payee: "Market association", amountKobo: 500000 },
      { id: "e4", createdAt: ago(4), category: "Transport", payee: "Bus to Alaba", amountKobo: 300000 },
      { id: "e5", createdAt: ago(12), category: "Rent", payee: "Shop rent (part)", amountKobo: 2500000 },
      { id: "e6", createdAt: ago(20), category: "Electricity", payee: "Prepaid meter", amountKobo: 800000 },
      { id: "e7", createdAt: ago(75), category: "Repairs", payee: "Shelf carpenter", amountKobo: 1200000 },
      { id: "e8", createdAt: ago(160), category: "Rent", payee: "Shop rent (part)", amountKobo: 2500000 },
    ],
    corrections: [], // ledger corrections made through this mock
    nextId: 100,
  };
}

const shops = new Map();
const shopData = (id) => {
  if (!shops.has(id)) shops.set(id, seedShop());
  return shops.get(id);
};

// --- Periods (Lagos calendar) ------------------------------------------------------

// Start of the period as a UTC instant, by the Lagos calendar.
function periodStart(period, now = Date.now()) {
  const l = new Date(now + LAGOS_OFFSET_MS); // Lagos wall clock read through UTC getters
  let y = l.getUTCFullYear(), m = l.getUTCMonth(), d = l.getUTCDate();
  if (period === "week") d -= (l.getUTCDay() + 6) % 7; // back to Monday
  if (period === "month") d = 1;
  if (period === "year") (m = 0), (d = 1);
  return Date.UTC(y, m, d) - LAGOS_OFFSET_MS;
}

// Chart buckets as profit.mjs writes them (Lagos calendar): "00".."23" for
// today, "YYYY-MM-DD" for each day of the week (Monday to Sunday) and of the
// month, "YYYY-MM" for each month of the year. from/to are YYYY-MM-DD, inclusive.
// Buckets after now stay at zero, like the real route.
function buckets(period, now = Date.now()) {
  const l = new Date(now + LAGOS_OFFSET_MS);
  const y = l.getUTCFullYear(), m = l.getUTCMonth(), d = l.getUTCDate(), h = l.getUTCHours();
  const pad = (n) => String(n).padStart(2, "0");
  const day = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd)).toISOString().slice(0, 10);
  if (period === "today") {
    const t = day(y, m, d);
    return { from: t, to: t, labels: Array.from({ length: 24 }, (_, i) => pad(i)), live: (i) => i <= h && i >= 8 && i <= 18 };
  }
  if (period === "week") {
    const since = (l.getUTCDay() + 6) % 7;
    return { from: day(y, m, d - since), to: day(y, m, d - since + 6), labels: Array.from({ length: 7 }, (_, i) => day(y, m, d - since + i)), live: (i) => i <= since };
  }
  if (period === "month") {
    const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return { from: day(y, m, 1), to: day(y, m, n), labels: Array.from({ length: n }, (_, i) => day(y, m, i + 1)), live: (i) => i + 1 <= d };
  }
  return { from: `${y}-01-01`, to: `${y}-12-31`, labels: Array.from({ length: 12 }, (_, i) => `${y}-${pad(i + 1)}`), live: (i) => i <= m };
}
// Typical sales for one bucket, in kobo (whole naira).
const BUCKET_KOBO = { today: 3000000, week: 12000000, month: 9000000, year: 220000000 };
const COLLECTED_PERCENT = { today: 74, week: 81, month: 86, year: 90 };
// Integer kobo only: a whole-number share, rounded down to the kobo.
const percentOf = (kobo, pct) => (kobo * pct - ((kobo * pct) % 100)) / 100;
const wholeNaira = (kobo) => kobo - (kobo % 100);
// A steady, made-up wobble from 400 to 1100 per thousand.
const wobble = (i) => 400 + ((i * 7919) % 700);

function profit(period, shop) {
  const bk = buckets(period);
  const series = bk.labels.map((label, i) => {
    const salesKobo = bk.live(i) ? wholeNaira(Math.floor((BUCKET_KOBO[period] * wobble(i)) / 1000)) : 0;
    const cogsKobo = percentOf(salesKobo, 78);
    const expensesKobo = salesKobo > 0 && i % 5 === 2 ? 250000 : 0;
    return { label, salesKobo, cogsKobo, expensesKobo, profitKobo: salesKobo - cogsKobo - expensesKobo };
  });
  const sum = (k) => series.reduce((t, b) => t + b[k], 0);
  const salesKobo = sum("salesKobo");
  const cogsKobo = sum("cogsKobo");
  const expensesKobo = sum("expensesKobo");
  return {
    period,
    from: bk.from,
    to: bk.to,
    salesKobo,
    collectedKobo: percentOf(salesKobo, COLLECTED_PERCENT[period]),
    cogsKobo,
    expensesKobo,
    estimatedProfitKobo: salesKobo - cogsKobo - expensesKobo,
    itemsWithoutCost: shop.products.filter((p) => p.costPriceKobo == null).length,
    series,
  };
}

function expenses(shop, period) {
  const from = periodStart(period);
  const list = shop.expenses.filter((e) => Date.parse(e.createdAt) >= from).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const totals = new Map();
  for (const e of list) totals.set(e.category, (totals.get(e.category) ?? 0) + e.amountKobo);
  const byCategory = [...totals].map(([category, amountKobo]) => ({ category, amountKobo })).sort((a, b) => b.amountKobo - a.amountKobo);
  return { expenses: list, byCategory };
}

const productOut = (p) => ({ ...p, lowStock: p.stockOnHand <= 3 });

// --- Forwarding to the real backend ---------------------------------------------------

function forward(req, res, body) {
  const out = http.request(
    { hostname: BACKEND_URL.hostname, port: BACKEND_URL.port, path: req.url, method: req.method, headers: { ...req.headers, host: BACKEND_URL.host } },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    }
  );
  out.on("error", () => send(res, 502, { error: "backend not reachable" }));
  out.end(body);
}

// GET a JSON route from the real backend as this shop.
function backendJson(path, shopId) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: BACKEND_URL.hostname, port: BACKEND_URL.port, path, headers: { "x-shop-id": shopId } }, (r) => {
        let s = "";
        r.on("data", (d) => (s += d));
        r.on("end", () => (r.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`${path} ${r.statusCode}`))));
      })
      .on("error", reject);
  });
}

// The real ledger plus this mock's corrections, each entry with correctedById.
async function ledger(shopId) {
  const shop = shopData(shopId);
  const real = await backendJson("/ledger", shopId);
  const entries = [...real.entries, ...shop.corrections];
  const by = new Map();
  for (const e of entries) if (e.corrects_id != null) by.set(e.corrects_id, e.id);
  return { entries: entries.map((e) => ({ ...e, correctedById: by.get(e.id) ?? null })), verify: real.verify };
}

// --- HTTP -------------------------------------------------------------------------------

const send = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const isKobo = (v) => Number.isInteger(v) && v >= 0;
const periodError = (period) => `unknown period "${period}" (want today, week, month or year)`;

// customers.mjs normalizePhone: digits with a country code.
function normalizePhone(phone) {
  if (typeof phone !== "string") throw new Error("phone must be text with a country code");
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7) throw new Error("phone must have at least 7 digits");
  if (digits.startsWith("0")) return `234${digits.replace(/^0+/, "")}`;
  if (digits.startsWith("234")) return digits;
  if (digits.length === 10) return `234${digits}`;
  return digits;
}
const cleanText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://mock");
    const parts = url.pathname.split("/").filter(Boolean);
    const shopId = req.headers["x-shop-id"];
    const route = `${req.method} /${parts[0] ?? ""}${parts.length > 1 ? "/:id" : ""}${parts[2] ? "/" + parts[2] : ""}`;
    const mine = ["GET /profit", "GET /expenses", "GET /products", "POST /products/:id", "GET /customers", "POST /customers", "POST /customers/:id/clear-phone", "GET /ledger", "POST /ledger/:id/correct"];
    if (!mine.includes(route)) return forward(req, res, raw);
    if (!shopId) return send(res, 400, { error: "missing x-shop-id" });

    let body = {};
    if (req.method === "POST") {
      try {
        body = raw.length ? JSON.parse(raw) : {};
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }
    }
    const shop = shopData(shopId);
    const period = url.searchParams.get("period") ?? "today";

    try {
      switch (route) {
        case "GET /profit":
          if (!PERIODS.includes(period)) return send(res, 400, { error: periodError(period) });
          return send(res, 200, profit(period, shop));

        case "GET /expenses":
          if (!PERIODS.includes(period)) return send(res, 400, { error: periodError(period) });
          return send(res, 200, expenses(shop, period));

        case "GET /products":
          return send(res, 200, { products: shop.products.map(productOut) });

        case "POST /products/:id": {
          const p = shop.products.find((x) => x.id === Number(parts[1]));
          if (!p) return send(res, 404, { error: "product not found" });
          const { sellPriceKobo, costPriceKobo } = body;
          if (sellPriceKobo === undefined && costPriceKobo === undefined) return send(res, 400, { error: "pass sellPriceKobo and/or costPriceKobo" });
          for (const [field, value] of [["sellPriceKobo", sellPriceKobo], ["costPriceKobo", costPriceKobo]])
            if (value !== undefined && !isKobo(value)) return send(res, 400, { error: `${field} must be a non-negative integer (kobo)` });
          if (sellPriceKobo !== undefined) p.sellPriceKobo = sellPriceKobo;
          if (costPriceKobo !== undefined) p.costPriceKobo = costPriceKobo;
          return send(res, 200, { product: productOut(p) });
        }

        case "GET /customers": {
          // Amounts owed come from the real /debts, so they match the Debts tab.
          const debts = await backendJson("/debts", shopId).then((d) => d.debts).catch(() => []);
          const owed = (name) => debts.find((d) => d.customer.trim().toLowerCase() === name.trim().toLowerCase())?.owedKobo ?? 0;
          // Names that exist only in the ledger have no id yet (null); anyone who owes nothing is left out.
          const extra = debts.filter((d) => d.owedKobo > 0 && !shop.customers.some((c) => c.name.toLowerCase() === d.customer.trim().toLowerCase()));
          const customers = [
            ...shop.customers.map((c) => ({ ...c, owedKobo: owed(c.name) })),
            ...extra.map((d) => ({ id: null, name: d.customer, phone: null, owedKobo: d.owedKobo, lastActivityAt: d.lastPaymentAt ?? null })),
          ];
          return send(res, 200, { customers });
        }

        case "POST /customers": {
          // Create or update by name. A phone needs consent: true and is stored as
          // digits with a country code; with no phone no consent is needed, and a
          // missing phone leaves the stored one alone (as server.mjs does).
          const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
          if (!name) return send(res, 400, { error: "customer name is required" });
          const hasPhone = body.phone !== undefined && body.phone !== null;
          if (hasPhone && body.consent !== true) return send(res, 400, { error: "consent: true is required to store a phone number" });
          let phone = null;
          if (hasPhone) {
            try {
              phone = normalizePhone(body.phone);
            } catch (err) {
              return send(res, 400, { error: err.message });
            }
          }
          const debts = await backendJson("/debts", shopId).then((d) => d.debts).catch(() => []);
          let c = shop.customers.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (c) {
            if (hasPhone) c.phone = phone;
            c.lastActivityAt = new Date().toISOString();
          } else shop.customers.push((c = { id: shop.nextId++, name, phone, lastActivityAt: new Date().toISOString() }));
          const owedKobo = debts.find((d) => d.customer.trim().toLowerCase() === name.toLowerCase())?.owedKobo ?? 0;
          return send(res, 200, { customer: { ...c, owedKobo } });
        }

        case "POST /customers/:id/clear-phone": {
          const c = shop.customers.find((x) => x.id === Number(parts[1]));
          if (!c) return send(res, 404, { error: "customer not found" });
          c.phone = null;
          return send(res, 200, { customer: { ...c, owedKobo: 0 } });
        }

        case "GET /ledger":
          return send(res, 200, await ledger(shopId));

        case "POST /ledger/:id/correct": {
          const { entries, verify } = await ledger(shopId);
          const id = Number(parts[1]);
          const original = entries.find((e) => e.id === id);
          if (!original) return send(res, 404, { error: "entry not found" });
          if (original.correctedById != null) return send(res, 409, { error: "entry already corrected" });
          const reason = cleanText(body.reason);
          if (!reason) return send(res, 400, { error: "reason is required" });
          if (body.amountKobo !== undefined && !(Number.isInteger(body.amountKobo) && body.amountKobo > 0)) return send(res, 400, { error: "amount must be whole kobo" });
          if (body.quantity !== undefined && body.quantity !== null && !(Number.isInteger(body.quantity) && body.quantity > 0)) return send(res, 400, { error: "quantity must be a whole number" });
          const maxSeq = Math.max(0, ...entries.map((e) => e.seq));
          const maxId = Math.max(0, ...entries.map((e) => e.id));
          const entry = {
            id: maxId + 1,
            shop_id: shopId,
            seq: maxSeq + 1,
            type: "correction",
            amount_kobo: body.amountKobo ?? original.amount_kobo,
            customer: body.customer !== undefined ? cleanText(body.customer) : original.customer,
            item: body.item !== undefined ? cleanText(body.item) : original.item,
            quantity: body.quantity !== undefined ? body.quantity : original.quantity,
            unit: body.unit !== undefined ? cleanText(body.unit) : original.unit,
            created_at: new Date().toISOString(),
            corrects_id: id,
            reason,
          };
          shop.corrections.push(entry);
          return send(res, 200, { entry: { ...entry, correctedById: null }, verify });
        }
      }
    } catch (err) {
      return send(res, 502, { error: `mock could not reach the backend: ${err.message}` });
    }
  })
  .listen(PORT, () => console.log(`mock-contract on :${PORT} (fake data; forwards other routes to ${BACKEND_URL.origin})`));
