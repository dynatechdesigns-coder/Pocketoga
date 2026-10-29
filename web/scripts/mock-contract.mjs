// Dev-only stand-in for backend routes that are still being built. Fake data
// only, kept in memory (restarting the mock resets it). Never used in a build.
//
//   npm run mock:contract          (listens on MOCK_PORT, default 3999)
//   MOCK_CONTRACT=1 npm run dev    (Vite then sends /api here instead)
//
// New routes are answered here, exactly as the contract describes:
//   GET  /profit?period=today|week|month|year
//   GET  /expenses?period=...
//   GET  /products            POST /products/:id   { sellPriceKobo?, costPriceKobo? }
//   GET  /customers           POST /customers      { name, phone, consent: true }
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
      { id: "p1", name: "Rice", unit: "bag", sellPriceKobo: 5900000, costPriceKobo: 5200000, stockOnHand: 7, lowStockAt: 3 },
      { id: "p2", name: "Beans", unit: "bag", sellPriceKobo: 6500000, costPriceKobo: 6000000, stockOnHand: 2, lowStockAt: 3 },
      { id: "p3", name: "Indomie", unit: "carton", sellPriceKobo: 900000, costPriceKobo: 900000, stockOnHand: 0, lowStockAt: 2 },
      { id: "p4", name: "Groundnut oil", unit: "tin", sellPriceKobo: 4500000, costPriceKobo: null, stockOnHand: 5, lowStockAt: 2 },
      { id: "p5", name: "Sugar", unit: "bag", sellPriceKobo: 7200000, costPriceKobo: 6600000, stockOnHand: 4, lowStockAt: 2 },
    ],
    // Clearly fake numbers (0803 000 00xx).
    customers: [
      { id: "c1", name: "Mama Bisi", phone: "08030000011", lastActivityAt: ago(1) },
      { id: "c2", name: "Chinedu", phone: "08030000012", lastActivityAt: ago(0, 2) },
      { id: "c3", name: "Aunty Ngozi", phone: "08030000013", lastActivityAt: ago(2) },
      { id: "c4", name: "Ada", phone: null, lastActivityAt: ago(3) },
      { id: "c5", name: "Tunde", phone: "08030000015", lastActivityAt: ago(2) },
      { id: "c6", name: "Alhaji Musa", phone: "08030000016", lastActivityAt: ago(40) },
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
    nextId: 1,
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

// Fake buckets for the chart. Integer kobo throughout; profit is worked out
// here, server-side, as the real route will.
const SERIES = {
  today: { labels: ["8am", "10am", "12pm", "2pm", "4pm", "6pm"], sales: [1800000, 4200000, 2700000, 0, 5900000, 3100000], cogs: [1500000, 3600000, 2400000, 0, 5200000, 2600000], exp: [250000, 0, 150000, 0, 0, 0] },
  week: { labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], sales: [9400000, 12800000, 7600000, 15100000, 11800000, 0, 0], cogs: [8200000, 11000000, 6900000, 13100000, 10200000, 0, 0], exp: [300000, 0, 500000, 0, 400000, 0, 0] },
  month: { labels: ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5"], sales: [61000000, 58200000, 66400000, 56700000, 0], cogs: [53500000, 51800000, 58000000, 50100000, 0], exp: [3300000, 800000, 2500000, 1200000, 0] },
  year: { labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], sales: [210000000, 198000000, 225000000, 240000000, 231000000, 205000000, 219000000, 236000000, 228000000, 242300000, 0, 0], cogs: [184000000, 176000000, 197000000, 209000000, 204000000, 196000000, 192000000, 206000000, 201000000, 213300000, 0, 0], exp: [6200000, 5900000, 7100000, 6800000, 7400000, 12500000, 6600000, 7000000, 6900000, 7800000, 0, 0] },
};
const COLLECTED_PERCENT = { today: 74, week: 81, month: 86, year: 90 };
// Integer kobo only: a whole-number share, rounded down to the kobo.
const percentOf = (kobo, pct) => (kobo * pct - ((kobo * pct) % 100)) / 100;

function profit(period) {
  const s = SERIES[period];
  const series = s.labels.map((label, i) => ({
    label,
    salesKobo: s.sales[i],
    cogsKobo: s.cogs[i],
    expensesKobo: s.exp[i],
    profitKobo: s.sales[i] - s.cogs[i] - s.exp[i],
  }));
  const sum = (k) => series.reduce((t, b) => t + b[k], 0);
  const salesKobo = sum("salesKobo");
  const cogsKobo = sum("cogsKobo");
  const expensesKobo = sum("expensesKobo");
  return {
    period,
    from: new Date(periodStart(period)).toISOString(),
    to: new Date().toISOString(),
    salesKobo,
    collectedKobo: percentOf(salesKobo, COLLECTED_PERCENT[period]),
    cogsKobo,
    expensesKobo,
    estimatedProfitKobo: salesKobo - cogsKobo - expensesKobo,
    itemsWithoutCost: 1, // groundnut oil has no cost price
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

const productOut = ({ lowStockAt, ...p }) => ({ ...p, lowStock: p.stockOnHand <= lowStockAt });

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
    const mine = ["GET /profit", "GET /expenses", "GET /products", "POST /products/:id", "GET /customers", "POST /customers", "GET /ledger", "POST /ledger/:id/correct"];
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
          if (!PERIODS.includes(period)) return send(res, 400, { error: "period must be today, week, month or year" });
          return send(res, 200, profit(period));

        case "GET /expenses":
          if (!PERIODS.includes(period)) return send(res, 400, { error: "period must be today, week, month or year" });
          return send(res, 200, expenses(shop, period));

        case "GET /products":
          return send(res, 200, { products: shop.products.map(productOut) });

        case "POST /products/:id": {
          const p = shop.products.find((x) => x.id === parts[1]);
          if (!p) return send(res, 404, { error: "product not found" });
          const { sellPriceKobo, costPriceKobo } = body;
          if (sellPriceKobo === undefined && costPriceKobo === undefined) return send(res, 400, { error: "nothing to change" });
          if ((sellPriceKobo !== undefined && !isKobo(sellPriceKobo)) || (costPriceKobo !== undefined && !isKobo(costPriceKobo)))
            return send(res, 400, { error: "prices must be whole kobo" });
          if (sellPriceKobo !== undefined) p.sellPriceKobo = sellPriceKobo;
          if (costPriceKobo !== undefined) p.costPriceKobo = costPriceKobo;
          return send(res, 200, { product: productOut(p) });
        }

        case "GET /customers": {
          // Amounts owed come from the real /debts, so they match the Debts tab.
          const debts = await backendJson("/debts", shopId).then((d) => d.debts).catch(() => []);
          const owed = (name) => debts.find((d) => d.customer.trim().toLowerCase() === name.trim().toLowerCase())?.owedKobo ?? 0;
          // Anyone else who owes money (suppliers, owed nothing, are left out).
          const extra = debts.filter((d) => d.owedKobo > 0 && !shop.customers.some((c) => c.name.toLowerCase() === d.customer.trim().toLowerCase()));
          const customers = [
            ...shop.customers.map((c) => ({ ...c, owedKobo: owed(c.name) })),
            ...extra.map((d) => ({ id: `d-${d.customer}`, name: d.customer, phone: null, owedKobo: d.owedKobo, lastActivityAt: d.lastPaymentAt ?? null })),
          ];
          return send(res, 200, { customers });
        }

        case "POST /customers": {
          // Contract has one write route for customers; the mock treats it as
          // add-or-update by name.
          const name = cleanText(body.name);
          const phone = cleanText(body.phone);
          if (!name) return send(res, 400, { error: "name is required" });
          if (body.consent !== true) return send(res, 400, { error: "consent is required to store a phone number" });
          if (phone && !/^\+?\d[\d ]{6,18}$/.test(phone)) return send(res, 400, { error: "phone number looks wrong" });
          let c = shop.customers.find((x) => x.name.toLowerCase() === name.toLowerCase());
          if (c) Object.assign(c, { phone, lastActivityAt: new Date().toISOString() });
          else shop.customers.push((c = { id: `c${100 + shop.nextId++}`, name, phone, lastActivityAt: new Date().toISOString() }));
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
