# PocketOga

## 1. What PocketOga is

PocketOga is a voice-first ledger assistant for Nigerian small traders, on WhatsApp and the web, that understands English, Pidgin and Nigerian money talk like 15k.
The trader speaks or types a note and the AI proposes ledger entries from it.
Plain code checks every proposal and the trader taps confirm before anything is saved.

## 2. Built and tested

`npm test` runs `ledger`, `money`, `voice`, `whatsapp` and `messages` suites (105 tests, all passing). Real files:

- `ledger.mjs` — per-shop append-only hash chain: per-shop `seq` from 1, `prev_hash` links, integer kobo only, nullable item/quantity/unit. Hash is SHA-256 over a JSON array of the hashed fields (no ambiguous separators); SQL triggers abort any UPDATE or DELETE; `verifyChain`/`verify` report the first broken entry. Corrections are new entries via `appendCorrection` (same shop, `corrects_id` link). `GET /ledger` returns entries plus verification.
- `proposals.mjs` — drafts live here, never in the ledger: one row per note (`entries_json`, `heard`, `question`, `recorded_ids`, `name_checked`).
- `voice.mjs` — propose / fix / confirm / reject / get. `confirmProposal` is the only path that appends to the ledger and is idempotent (second confirm reports `alreadyConfirmed`). Plain-code checks: model-output validation, price basis (`each`/`total`/`unclear`, each-price maths in code, each-word guard), stated-remainder cross-check against the heard text, similar-name check against the shop's ledger customers. Proposals expire after 30 minutes.
- `money.mjs` — deterministic parser (`parseNaira`: 15k, N2,500, number words), `nairaToKobo`, `formatKobo`.
- `model.mjs` — Meta API client (`muse-spark-1.3` text, `muse-spark-1.2` audio) plus a mock client all tests use.
- `whatsapp.mjs` — webhook processing: signature check and verification handshake, duplicate-delivery dedupe, allowed-numbers list, Save/Fix/Reject button replies, voice notes downloaded and converted with ffmpeg to 16 kHz mono WAV, per-sender fix state, secrets and long digit runs masked in logs.
- `server.mjs` — main API on `PORT` (default 3000): propose, confirm, fix, reject, proposals, ledger, webhook. Separate webhook-only listener on `WEBHOOK_PORT` (default 3001). `WEBHOOK_PUBLIC_ONLY=1` hides non-webhook routes from tunnelled traffic. Every shop route checks `x-shop-id`.
- `messages.mjs` — every user-facing WhatsApp string: clean cards (Save/Fix/Reject) and needs-checking cards (Fix/Reject, arithmetic, question once), saved replies, one-line replies, 1024-char cap, markdown escaping.
- `web/` — React PWA (`App.jsx`, `Home.jsx`, `RecordScreen.jsx`, `ConfirmCard.jsx`, `LedgerScreen.jsx`, `api.js`, `localLedger.js`, `money.js`, `sha256.js`, `wav.js`): record/type notes, confirm card, ledger with chain banner, demo shop with fake data, device ledger mirror, mic audio converted to WAV, `/api` proxy to the backend.
- Helpers: `preview-messages.mjs` (prints all card layouts), `smoke-live.mjs` (manual propose-only run against the real API), `tamper-demo.mjs` (local tamper/restore demo), `audio-test*.mjs`/`baseten-test.mjs` (manual model probes). `test-notes.md` is the manual test log.

## 3. Rules for any tool working here

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

## 4. Known gaps, honestly

- The server trusts the `x-shop-id` header and the web app opens test shops by name with no password. Local testing only.
- WhatsApp token lifecycle is manual; the test log notes an expired temporary token during setup.
- Web ledger details: two comments saying "until the server has a ledger route" are stale (`GET /ledger` exists and is tried first); the device-mirror hash omits `unit` while the server hash includes it; confirmed entries mirrored to the device carry no unit; server flags render as plain text on web, so WhatsApp `*bold*` markers show literally.
- No automated tests for real model accuracy: every suite uses the mock model; `smoke-live.mjs` and the audio probes are manual, and spoken-note accuracy is unmeasured.
- `appendCorrection` has no HTTP route or UI, and the `debt` entry type can't be created through proposals (only sale, payment, restock).
- Two warnings can still repeat one question in slightly different words on a card (minor, noted in the test log).

## 5. Planned, not built

- Debts and promises: promise tracking, chase ranking, reminder drafts.
- Money Leak Report: one number for money lost or at risk this month.
- Alert Guard: screenshot/receipt/SMS checks that only warn and never say verified; payments stay unconfirmed until the trader confirms the credit.
- Offline notes queue with an `occurred_at` field.
- Notebook photo import.
- Accuracy page and red-team report.
- Correct-last-entry option in the app.

## 6. How to run

- Backend: `node server.mjs` (env: `PORT` default 3000, `WEBHOOK_PORT` default 3001, `LEDGER_DB` default `pocketoga.db`, `META_API_KEY` for the real model).
- Web app: `cd web && npm install && npm run dev` (uses `/api` to localhost:3000, or set `VITE_API_BASE`; `BACKEND_URL` moves the proxy target).
- Tests: `npm test`.
- Tunnel: point it at port 3001 (webhook listener) only, never at the main server.
