# PocketOga

Voice-first AI bookkeeping assistant for Nigerian market traders, on WhatsApp and the web. The trader speaks or types a note, the AI proposes ledger entries, plain code checks them, the trader taps confirm, entries land in a hash-chained ledger.

Backend: Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`, `node:test`) — zero runtime dependencies. Web: React 18 + Vite 5 + Tailwind 4 PWA in `web/`.

Run locally: `node server.mjs` (backend on `PORT`, default 3000); `cd web && npm run dev` for the app (`/api` proxies to the backend). Tests: `npm test`.

## Run it yourself (judges)

Use your own Meta API key. The server starts and the demo shop works with only that key set — Baseten, WhatsApp and feedback settings are optional and never crash the boot. Daily call caps (demo 40, per-shop 200, service 1500 a day) protect your key against runaway use.

1. Clone and install:
   `git clone <this-repo-url> pocketoga`
   `cd pocketoga`
2. Build the web app (needs Node 22+):
   `cd web && npm install && npm run build && cd ..`
3. Copy the settings file and add your key:
   `cp .env.example .env.local` (Windows: `copy .env.example .env.local`; if the example file is missing, create `.env.local` yourself with one line: `META_API_KEY=your-key-here`)
   Open `.env.local` in a text editor and set `META_API_KEY` to your key. The model names already have defaults (`muse-spark-1.3` for text and photos, `muse-spark-1.2` for voice) — you do not need to set them.
   Optional, all safe to leave blank: `BASETEN_API_KEY` + `BASETEN_MODEL` (second-opinion re-read), `WHATSAPP_*` (WhatsApp bot), `FEEDBACK_WEBHOOK_URL` + `FEEDBACK_WEBHOOK_SECRET` (owner inbox), `DAILY_CAP_DEMO` / `DAILY_CAP_SHOP` / `DAILY_CAP_SERVICE` (cap budgets).
4. Start the server (it reads `.env.local` automatically):
   `node server.mjs`
   The start-up lines list which features are on, for example `second opinion: off (no BASETEN_API_KEY)`. Key values are never printed.
5. Open `http://localhost:3000` and tap "Try the demo shop". No login needed; the demo reseeds itself with fake entries.

## Deploy

One Docker web service on the Render free plan serves the API, the WhatsApp webhook and the built web app on a single origin — no CORS, one public URL.

1. Push this repo to GitHub. In the Render dashboard: New → Web Service → this repo. Render picks up `render.yaml`: Runtime Docker (root `Dockerfile`), health check path `/health`, auto-deploy on push, free plan.
2. Set environment variables in the Render dashboard (never committed; see `.env.example` for the full list by name): `META_API_KEY`, `BASETEN_API_KEY`, `BASETEN_MODEL`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ALLOWED_NUMBERS`, `WHATSAPP_SUMMARY_TEMPLATE`. `DATA_DIR` is pre-set to `/app/data` by the Blueprint. Leave `WEBHOOK_PUBLIC_ONLY` unset — one URL serves the app and the webhook together, and every Render request carries a proxy header that the tunnel guard would mistake for tunnelled traffic.
3. Meta webhook: in the Meta app dashboard, set the webhook callback URL to `https://APP-NAME.onrender.com/webhook` (verify token = `WHATSAPP_VERIFY_TOKEN`) and subscribe to messages. Signature checks run on the same single server; the webhook needs no separate port or tunnel.
4. Free services sleep when idle: add an uptime pinger (e.g. UptimeRobot cron) hitting `https://APP-NAME.onrender.com/health` every 10 minutes. It returns 200 `{"ok":true}` and keeps the service awake.
5. Smoke test after deploy: open `https://APP-NAME.onrender.com/` (the app loads, demo shop works with no login); `https://APP-NAME.onrender.com/health` returns `{"ok":true}`; `GET /ledger` with `x-shop-id: demo` lists the 15 seeded demo entries; logging in as a real shop without a token returns 401.

Storage: the free plan has temporary storage — the database resets on restart or redeploy, so the demo shop reseeds itself on every boot that finds it empty, and a 10-minute SQLite backup (`VACUUM INTO`, last 7 kept in `DATA_DIR/backups`) restores automatically when the main file is gone. Real shops work normally while the instance is alive. A paid deployment would mount a persistent disk at `DATA_DIR` so the ledger and backups survive restarts.

Demo judges use the web app; WhatsApp runs on a Meta test number, so the WhatsApp flow is shown in the demo video, not live.

## Credits
- AI models: Meta Model API (muse-spark-1.3 text, muse-spark-1.2 audio); open-weight second opinion muse-spark-open-1026 served on Baseten.
- Landing page images: generated with Muse Image.
- Icons: Lucide (lucide-react), ISC licence.
- Font: Plus Jakarta Sans, SIL Open Font License, loaded from Google Fonts.
- Demo audio and all sample data: recorded or written by the author. No outside datasets.
## Disclosure: what existed before the event

Before the event I had ProfitPocket, a simple bookkeeping and inventory web app for small traders (https://profit-pocket-tviz.vercel.app). You type in your entries, and it calculates profit and loss for a week, a month and a year. It has no voice input and does not use Meta models.

PocketOga was built during the event week as a new project. No code was copied from ProfitPocket; only the idea carried over.

Everything else you see here was built this week: voice and text understanding, WhatsApp, the confirm step, the ledger, offline mode, corrections, reports and the spreadsheet export.

PocketOga was built with Muse Code and Claude Code as coding assistants. I set the design and rules, reviewed the results and tested them.