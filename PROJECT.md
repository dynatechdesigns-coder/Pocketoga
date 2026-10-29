# PocketOga

## 1. What PocketOga is

PocketOga is a voice-first ledger assistant for Nigerian small traders, on WhatsApp and the web, that understands English, Pidgin and Nigerian money talk like 15k.
The trader speaks or types a note and the AI proposes ledger entries from it.
Plain code checks every proposal and the trader taps confirm before anything is saved.

## 2. Built and tested

`npm test` runs 10 suites (`ledger`, `money`, `voice`, `whatsapp`, `messages`, `debts`, `server`, `products`, `customers`, `corrections`): 198 tests, all passing. Real files:

- `ledger.mjs` — per-shop append-only hash chain: per-shop `seq` from 1, `prev_hash` links, integer kobo only, nullable item/quantity/unit. SHA-256 over a JSON array of the hashed fields; SQL triggers abort UPDATE/DELETE; `verifyChain`/`verify` report the first broken entry. Corrections are new entries via `appendCorrection` (same shop, `corrects_id` link). Reasons live in `corrections_log`, never in the ledger.
- `proposals.mjs` — drafts live here, never in the ledger: one row per note (`entries_json`, `heard`, `question`, `recorded_ids`, `name_checked`).
- `voice.mjs` — propose / fix / confirm / reject / get. `confirmProposal` is the only path that appends to the ledger and is idempotent (`alreadyConfirmed`); it also auto-creates products and records the proposal's promise. Plain-code checks: model-output validation, price basis (`each`/`total`/`unclear`), stated-remainder cross-check, similar-name check. Entry types are sale/payment/restock only. Proposals expire after 30 minutes.
- `money.mjs` — deterministic parser (`parseNaira`: 15k, N2,500, number words), `nairaToKobo`, `formatKobo`.
- `model.mjs` — Meta API client (`muse-spark-1.3` text, `muse-spark-1.2` audio) plus the mock client all tests use.
- `whatsapp.mjs` — webhook processing: signature check and verification handshake, duplicate-delivery dedupe, allowed-numbers list, Save/Fix/Reject button replies, voice notes via ffmpeg to 16 kHz mono WAV, per-sender fix state, secrets masked in logs. Exact commands before any model call: `who owes`, `chase`, `balance <name>`, `report`, `stock`.
- `server.mjs` — main API on `PORT` (default 3000, see routes below). Separate webhook-only listener on `WEBHOOK_PORT` (default 3001, 404s everything but `/webhook`). `WEBHOOK_PUBLIC_ONLY=1` hides non-webhook routes from tunnelled traffic. `buildDeps(env)` wires all stores without sockets. Every shop route checks `x-shop-id`.
- `messages.mjs` — every user-facing WhatsApp string: clean cards (Save/Fix/Reject) and needs-checking cards (Fix/Reject, arithmetic, question once), usual-price note, saved replies, debt/chase/balance/report/stock renders, 1024-char cap, markdown escaping.
- `debts.mjs` — balances (oldest-first allocation, corrections respected), chase ranking, Lagos-day helpers. `promises.mjs` — promise store, code-resolved due dates, kept/broken resolution, kept-rate. `leak.mjs` — Money Leak Report (owed, 30-day overdue, broken promises, shortfalls, below-cost margin, today's totals).
- `products.mjs` — products catalog (auto-created on confirm, trader-set prices, stock computed from the ledger, low at ≤3). `customers.mjs` — customers directory (phones + consent, never in the ledger).
- `web/` — React PWA (`App.jsx`, `Home.jsx`, `RecordScreen.jsx`, `ConfirmCard.jsx`, `LedgerScreen.jsx`, `api.js`, `localLedger.js`, `money.js`, `sha256.js`, `wav.js`): record/type notes, confirm card, ledger with chain banner, demo shop with fake data, device ledger mirror, mic audio to WAV, `/api` proxy to the backend.
- Helpers: `preview-messages.mjs`, `preview-debts.mjs`, `smoke-live.mjs` (manual propose-only run), `tamper-demo.mjs`, `audio-test*.mjs`/`baseten-test.mjs` (manual model probes). `test-notes.md` is the manual test log.

## 3. Routes (main server only, never the webhook port)

Every route except `/webhook` needs the `x-shop-id` header (400 without it); cross-shop access is 403. Errors are `{ error }`.

| Route | Request body | Response |
|---|---|---|
| POST `/propose` | `{ text }` or `{ audioBase64, audioFormat }` | 201 `{ proposal }` |
| POST `/confirm/:id` | — | `{ proposal, recordedIds, alreadyConfirmed }` |
| POST `/fix/:id` | `{ correctionText }` (or `{ text }`) | `{ proposal }` |
| POST `/reject/:id` | — | `{ proposal }` |
| GET `/proposals/:id` | — | `{ proposal }` |
| GET `/ledger` | — | `{ entries, verify }` |
| GET `/debts` | — | `{ debts, chase }` |
| GET `/promises` | — | `{ promises }` |
| GET `/report` | — | `{ report }` |
| GET `/products` | — | `{ products }` |
| POST `/products/:id` | `{ sellPriceKobo?, costPriceKobo? }` whole kobo ≥ 0 | `{ product }` |
| GET `/customers` | — | `{ customers }` |
| POST `/customers` | `{ name, phone?, consent? }` (phone needs `consent: true`) | `{ customer }` |
| POST `/customers/:id/clear-phone` | — | `{ customer }` (phone gone) |
| POST `/ledger/:id/correct` | `{ amountKobo?, customer?, item?, quantity?, unit?, reason }` | `{ entry, verify }` |
| GET `/webhook` | Meta handshake query | challenge text |
| POST `/webhook` | signed Meta payload | `{ ok: true }` |

Shapes: `proposal` is `{ id, shop_id, status, heard, question, created_at, entries, totals, flags, notes, recorded_ids, name_checked, promise }`; a ledger `entry` is `{ id, shop_id, seq, prev_hash, entry_hash, type, amount_kobo, customer, item, quantity, unit, corrects_id, created_at, correctedById, correctionReason }`; `verify` is `{ ok, count, shopId }`; `debts` items are `{ customer, owedKobo, salesKobo, paidKobo, oldestUnpaidAgeDays, oldestUnpaidAt, lastPaymentAt }`; `chase` items are `{ customer, owedKobo, ageDays, broken, score }`; `promises` are `{ id, shop_id, customer, amount_kobo, due_date, status, created_at, resolved_at, paid_kobo }`; `report` is `{ owed, overdue, broken, shortfalls, noStockRecord, belowCost, today }`; `product` is `{ id, name, unit, sellPriceKobo, costPriceKobo, stockOnHand, lowStock }`; `customer` is `{ id, name, phone, owedKobo, lastActivityAt }` (`id`/`phone` null for ledger-only names).

## 4. Rules for any tool working here

- Never put the AI in the write path: it proposes, code checks, the trader confirms.
- All money maths in code, integer kobo, never floats.
- Never edit or delete ledger entries; corrections are new entries.
- Hashed fields (`HASHED_FIELDS` in `ledger.mjs`, exact, in order):

```js
["shop_id", "seq", "type", "amount_kobo", "customer", "item", "quantity", "unit", "created_at", "corrects_id", "prev_hash"]
```

- Never open or print `.env` files or secrets; keys come from the environment.
- Fake data only; no real trader data while coding.
- Only the webhook port (3001) is ever tunnelled; the main server stays local.
- Per-shop isolation on every route; cross-shop access is 403.
- Commit before and after big tasks.

## 5. Known gaps, honestly

- The server trusts the `x-shop-id` header and the web app opens test shops by name with no password. Local testing only.
- WhatsApp token lifecycle is manual; the test log notes an expired temporary token during setup.
- Web ledger details: two comments saying "until the server has a ledger route" are stale (`GET /ledger` exists and is tried first); the device-mirror hash omits `unit` while the server hash includes it; confirmed entries mirrored to the device carry no unit; server flags render as plain text on web, so WhatsApp `*bold*` markers show literally.
- No automated tests for real model accuracy: every suite uses the mock model; `smoke-live.mjs` and the audio probes are manual, and spoken-note accuracy is unmeasured.
- The `debt` entry type can't be created through proposals (only sale, payment, restock); corrections have an HTTP route but no web UI.
- Kept needs one payment of at least the promised amount: several small payments totalling the promise still resolve as broken.
- Two warnings can still repeat one question in slightly different words on a card (minor, noted in the test log).

## 6. Planned, not built

- Profit and expenses (`/profit`, `/expenses` with periods and series): specified but never built — no code, no routes.
- Alert Guard: screenshot/receipt/SMS checks that only warn and never say verified; payments stay unconfirmed until the trader confirms the credit.
- Offline notes queue with an `occurred_at` field.
- Notebook photo import.
- Accuracy page and red-team report.

## 7. How to run

- Backend: `node server.mjs` (env: `PORT` default 3000, `WEBHOOK_PORT` default 3001, `LEDGER_DB` default `pocketoga.db`, `META_API_KEY` for the real model).
- Web app: `cd web && npm install && npm run dev` (uses `/api` to localhost:3000, or set `VITE_API_BASE`; `BACKEND_URL` moves the proxy target).
- Tests: `npm test`.
- Tunnel: point it at port 3001 (webhook listener) only, never at the main server.
