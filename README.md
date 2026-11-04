# PocketOga

## 1. What PocketOga is

PocketOga is a voice-first bookkeeping assistant for Nigerian market traders. She speaks, it writes the sale, the payment and the debt, and nothing is saved until she confirms.

[![PocketOga demo video](https://img.youtube.com/vi/Ia1MkrWCX_0/hqdefault.jpg)](https://www.youtube.com/watch?v=Ia1MkrWCX_0)

Demo video (2:52): https://www.youtube.com/watch?v=Ia1MkrWCX_0

It understands English, Pidgin and money talk like "15k". Entries land in a per-shop ledger where each row is hash-chained to the one before it, so a past entry cannot be quietly changed.

## The problem

Many market traders in Nigeria keep their records in a notebook, in their head, or not at all. That is where money leaks:
- A customer who "will pay tomorrow" is forgotten, so debts go uncollected.
- A wrong figure (₦63 written for ₦6,300) goes unnoticed, so profit is guessed.
- Typing entries is slow in a busy market, and some traders find writing hard. One tester said it plainly: not everyone can write.
- With no clear records, a trader has nothing to show a bank or cooperative.

## Who it is for

A trader or small-shop owner who talks to customers all day, speaks English or Pidgin, and has a phone but no time to type.

## What changes for her

She says what happened, "Paul buy 2 bag of rice, 15k, he pay 10k, remain 5k", and PocketOga writes the sale, the payment and the debt. It shows what it heard and asks when it is unsure. It reminds her who owes her, and gives her a monthly spreadsheet she can show a bank.

## What it does

- **Voice entries:** the trader sends a voice note in English or Pidgin, and PocketOga writes the sale, the payment and the debt.
- **Asks, never guesses:** it shows exactly what it heard, asks "₦63 or ₦6,300?" when an amount could mean two things, and saves nothing until the trader confirms.
- **Two-model check:** Muse Spark understands the note, and an open-weight Muse Spark model on Baseten reads it independently. If the two differ, PocketOga stops and asks.
- **Check alert:** a photo of a transfer alert is read by Muse Spark and stays unconfirmed until the bank confirms it.
- **Debts and reminders:** it tracks who owes what and writes a polite reminder to send.
- **Corrections:** an edited entry keeps the old amount on record.
- **Works offline:** on a phone or a laptop, entries are saved without a network and sync later.
- **Reports:** a monthly spreadsheet (CSV) the trader can show a bank or cooperative.
- **Runs the shop's books from any device:** sales, payments, debts, stock and reports in one place, on a phone or a laptop, so it can serve as a small shop's daily sales record, not only a notebook replacement. It keeps records; it is not a till and does not print receipts.
- **Installs like an app:** add it to a phone's home screen or install it from a laptop browser, and it opens in its own window.

## 2. What existed before vs what I built this week

Before the Meta Global AI Developer Hackathon I had ProfitPocket, a simple bookkeeping app where entries are typed. PocketOga was built from scratch during the event: voice input, Muse Spark understanding, a second-opinion check, check-alert photos, offline sync, reports and the accuracy test. No ProfitPocket code is carried over. Over 15 people tested it live this week, and their feedback shaped optional names, shorthand amounts and editing any entry.

I used Muse Code and Claude Code as coding assistants. I set the design and rules, reviewed the results and tested them.

## 3. Meta AI tooling used

- **Meta Model API, `muse-spark-1.2` (audio):** hears the voice note and works out the entries.
- **Meta Model API, `muse-spark-1.3` (text and photos):** understands typed notes and reads the photo in Check alert.
- **Open-weight second opinion, `meta-models/muse-spark-open-1026` on Baseten:** re-reads the same note in parallel. The main answer waits a short time for it, set by `SECOND_OPINION_WAIT_MS` (default 3000 ms). When the two readings differ on amount, customer, number of entries or promise date, the app stops and asks the trader instead of choosing.
- **Muse Image (`muse-image-1.0`):** generated the landing page art.
- **Proof of real calls:** the server log has one line per call, `model-call kind=audio|text|second-opinion status=ok|failed ms=... rid=...`. Photo calls log the same way. Status can also be `timeout` or `skipped` (for example, no Baseten key set). The lines never contain message text, audio, names or keys.

### Meta models and where they run

| Model | Used for | Where it runs | Runtime or build time |
| --- | --- | --- | --- |
| Muse Spark 1.2 (audio) | Hears the voice note | Meta Model API | Runtime |
| Muse Spark 1.3 (text and vision) | Understands the entry and reads transfer-alert photos | Meta Model API | Runtime |
| Open-weight Muse Spark (`meta-models/muse-spark-open-1026`) | Independent second opinion | Served on Baseten | Runtime, optional (needs `BASETEN_MODEL`) |
| Muse Image | Landing page art | Meta Model API | Build time only, not used at runtime |
| Muse Code | Coding assistant | Used while building | Build time only |

Every model PocketOga calls at runtime is a Meta model.

## 4. Safety design

- The app shows what it heard, so the trader can see a misheard word.
- The AI only proposes. Plain code double-checks every number and money is stored as whole kobo, never decimals.
- Doubtful numbers are asked about, not guessed. "63" is asked as "₦63 or ₦6,300?".
- Nothing is saved until the trader taps Save. Proposals expire after 30 minutes.
- The ledger is append-only. Editing an entry adds a correction with a reason; the original amount stays on record and is shown as corrected.
- A transfer alert photo stays unconfirmed until the trader checks their own bank and taps the bank button. It is never called "verified".
- Raw photos are not stored, only the fields read from them.
- Daily model-call caps protect the API key: `DAILY_CAP_DEMO` (default 40), `DAILY_CAP_SHOP` (default 200), `DAILY_CAP_SERVICE` (default 1500).

## 5. Accuracy

16 spoken notes, 3 runs each, in a new shop and an established one: 96 runs. 72 fully correct, 24 wrong but flagged for the trader to check, 0 wrong without a warning.

The notes are English, Pidgin and one Yoruba, all in the author's own voice. Weak spots: partial payments that do not mention the original sale, totals said with "each", names that sound alike, and Yoruba (experimental). One speaker and a small sample, so treat the numbers as a guide, not a guarantee.

- Accuracy page in the app: https://pocket-oga.onrender.com/accuracy
- Per-note tables: [accuracy-results.md](accuracy-results.md)

Over 15 people tried the live app, and several left written feedback in the app. Those testers are not part of the numbers above, which come from the scripted run only.

## What testers said

- "The app is good, especially for those who have problem with keeping records. The voice record makes it more easier for them." (5 stars)
- "This could actually help my business... it's user friendly. When would it be ready?" (4 stars)
- A tester asked to record sales to unnamed buyers, so names are now optional.

Feedback was collected through the in-app feedback form during the event.

## 6. WhatsApp (honest status)

WhatsApp is built (webhook at /webhook, voice notes, replies), but message delivery is blocked on my test account while my Meta business verification is still in review, so the web app is the full demo. The reminder button uses the shop owner's own WhatsApp (share/contact picker).

## 7. Run it yourself

- **Live demo:** https://pocket-oga.onrender.com (free plan, first load may take a moment)
- **Demo video (2:52):** https://www.youtube.com/watch?v=Ia1MkrWCX_0
- **All demo data is simulated. Please do not enter real names, numbers or bank details.**

### Local setup from a fresh clone

Prerequisites: Node 24. `package.json` does not pin a version; the Dockerfile uses Node 24 and the tests were run on 24. The backend needs `node:sqlite`, which older Node versions lack. There is no root `npm install` step: the backend has zero runtime dependencies.

1. Clone and enter the repo:
   ```
   git clone <this-repo-url> pocketoga
   cd pocketoga
   ```
2. Install and build the web app:
   ```
   cd web
   npm install
   npm run build
   cd ..
   ```
3. Copy the settings file:
   ```
   cp .env.example .env.local
   ```
   (Windows cmd: `copy .env.example .env.local`.) Open `.env.local` and fill in your own values. `.env.local` is gitignored; never commit it. Only `META_API_KEY` is needed to try the demo; every other variable can stay blank.
4. Start the server (it reads `.env.local` itself):
   ```
   node server.mjs
   ```
   The start-up lines say which features are on, for example that the second opinion is off without a Baseten key. Key values are never printed.
5. Open http://localhost:8787 and tap "Try the demo shop". The demo shop needs no login and reseeds itself with fake entries.

Tests: `npm test` (all suites use a mock model, no keys needed).

### Environment variables

Names only. Set values in `.env.local`.

| Variable | Purpose |
| --- | --- |
| `META_API_KEY` | Meta Model API key for audio, text and photo reads. The only one needed for the demo. |
| `BASETEN_API_KEY` | Key for the second-opinion model on Baseten. Blank turns the second opinion off. |
| `BASETEN_MODEL` | Model id the second opinion calls on Baseten. |
| `SECOND_OPINION_WAIT_MS` | How long the main answer waits for the second opinion, in ms (default 3000). |
| `WHATSAPP_TOKEN` | Meta WhatsApp Cloud API access token, used to send replies. |
| `WHATSAPP_PHONE_NUMBER_ID` | Id of the WhatsApp sender number. |
| `WHATSAPP_APP_SECRET` | Secret used to check the signature on incoming webhook calls. |
| `WHATSAPP_VERIFY_TOKEN` | Token for Meta's webhook handshake. |
| `WHATSAPP_ALLOWED_NUMBERS` | Comma-separated list of numbers the WhatsApp bot will serve. |
| `WHATSAPP_SUMMARY_TEMPLATE` | Name of the approved WhatsApp message template for the evening summary. |
| `PORT` | Port the server listens on (default 8787). |
| `WEBHOOK_PORT` | Separate webhook-only port, for a local tunnel. Leave unset otherwise. |
| `WEBHOOK_PUBLIC_ONLY` | Set to 1 to hide non-webhook routes from tunnelled traffic. Leave unset on Render. |
| `DATA_DIR` | Folder for the database and backups (default `./data`). |
| `LEDGER_DB` | Optional path to use for the SQLite file instead of `DATA_DIR/pocketoga.db`. |
| `SHELF_API_URL` | Endpoint for the shelf-counting experiment script only. |
| `SHELF_API_KEY` | Key for that experiment script. |
| `SHELF_MODEL` | Model name for that experiment script. |
| `FEEDBACK_WEBHOOK_URL` | Optional URL that receives in-app feedback as JSON. |
| `FEEDBACK_WEBHOOK_SECRET` | Shared secret sent with each feedback forward. |
| `DAILY_CAP_DEMO` | Daily model-call budget for the demo shop (default 40). |
| `DAILY_CAP_SHOP` | Daily model-call budget per real shop (default 200). |
| `DAILY_CAP_SERVICE` | Daily model-call budget for the whole service (default 1500). |

### Deploying

The repo has a `Dockerfile` and `render.yaml` for one Docker web service on the Render free plan, which serves the API and the built web app from a single URL. Enter the variables above in the Render dashboard (`render.yaml` pre-sets only `DATA_DIR`). The free plan has temporary storage: the database resets on restart or redeploy, the demo shop reseeds itself, and a 10-minute SQLite backup is restored when the database file is missing.

## 8. Tech stack

Node http server, node:sqlite, React and Vite web app, deployed on Render.

## Limitations

- The accuracy test is 16 scripted voice notes with simulated data, so it does not prove performance in a noisy real market.
- The open-weight second opinion needs `BASETEN_MODEL` (and its key, `BASETEN_API_KEY`) to run. Without it, the app shows the first reading and still asks the trader to confirm.
- WhatsApp is built (webhook at /webhook, voice notes, replies), but message delivery is blocked on my test account while my Meta business verification is still in review, so the web app is the full demo.

## What's next (planned, not built yet)

1. **Test with real traders.** Run PocketOga with a small group of market traders for a few weeks, in real noise, and measure accuracy on their own voices, not only on scripted notes.
2. **Warnings in the trader's own language.** Show the confirm and warning cards in Pidgin and Yoruba, then Hausa and Igbo.
3. **WhatsApp.** Finish Meta's business verification so the WhatsApp version I built (webhook, voice notes, replies) can be tested end to end.
4. **Stronger second opinion.** Run more tests on the open-weight second reader and use its disagreements to improve prompts.
5. **Bank and cooperative sharing.** Turn the monthly spreadsheet into a shareable record a bank or cooperative can read.
6. **Daily summary in the web app.** The WhatsApp version is built (a trader turns it on with "summary on", and it is built from the ledger with no model call), but it could not be tested end to end because delivery is blocked. A web version of the same end-of-day note (sales, money collected, who still owes) is not built yet.
7. **Point-of-sale mode.** Extend PocketOga from a bookkeeper into a small shop's till: quick sale entry at the counter and receipts the customer can see, with the same confirm-first safety. Receipts and a counter-style till screen are not built yet. Stock tracking (stock goes down with each sale) and the confirm-first flow already exist.

## Credits

- Icons: Lucide (lucide-react), ISC licence.
- Font: Plus Jakarta Sans, SIL Open Font License, loaded from Google Fonts.
- Demo audio and all sample data: recorded or written by the author. No outside datasets.
