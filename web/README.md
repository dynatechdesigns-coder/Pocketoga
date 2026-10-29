# PocketOga web app

The PocketOga PWA: a landing page for visitors, and for a signed-in shop the Money, Debts, Record, Reports, Ledger, Sales,
Products, Expenses, Customers and Settings screens. React 18, Vite 5, Tailwind CSS 4, plain JavaScript (no TypeScript).

The app only suggests. Nothing is saved until the trader taps Save on the confirm card, and saved records are never edited:
fixes are added as corrections. See `../PROJECT.md` for the backend and the rules for working in this repo.

## Run it

You need the backend running first (from the repo root), then the web app.

```
# Terminal 1, repo root
node --env-file=.env.local server.mjs          # API on http://localhost:3000

# Terminal 2
cd web
npm install
npm run seed:demo                              # fills the "demo" shop with fake data; safe to run twice
npm run dev                                    # https dev server, see below
```

`npm run seed:demo` goes through the real propose, then confirm path, so it needs the backend's model key. It skips notes that
are already saved. Promises can only be dated today or later, so a *broken* promise only appears the day after seeding.

Open **https://localhost:5173** on the PC and tap **Try the demo shop**. All data in the demo shop is fake.

### Open it on a phone (https)

The dev server uses https (`@vitejs/plugin-basic-ssl`, development only) because phones only allow the microphone on secure
pages. `host: true` makes it reachable on your Wi-Fi.

1. Put the phone on the **same Wi-Fi** as the PC (turn mobile data off for a moment; avoid "Guest" networks).
2. Run `npm run dev` and read the **Network:** line, for example `https://192.168.1.198:5173/`. The address can change whenever
   the router restarts; on Windows `ipconfig` shows the current one (the Wi-Fi adapter's IPv4 address).
3. Open that address on the phone, exactly as printed, starting with `https://`. The certificate is self-signed, so the phone
   warns once:
   - **Android Chrome:** tap **Advanced**, then **Proceed to (address) (unsafe)**. Allow the microphone when asked.
   - **iPhone Safari:** tap **Show Details**, then **visit this website**, then **Visit Website**. Allow the microphone when asked.

Installing the app to the home screen and offline mode need a trusted certificate, so test those on a properly hosted copy.
The backend stays plain http on port 3000: only the phone-to-Vite hop is https, and Vite forwards `/api` to the backend.

## The mock server (development only)

Some backend routes are still being built: `GET /profit`, `GET /expenses`, `GET/POST /products`, `GET/POST /customers`, and
`POST /ledger/:id/correct` (plus `correctedById` on `GET /ledger` entries). Until they exist, `scripts/mock-contract.mjs`
answers them with **fake data** (clearly fake: names like "Keke to Mile 12", numbers like 0803 000 0011) and forwards every
other route to the real backend. Corrections made through it live only in its memory, so the real ledger is never written.

It is used **only when you ask for it**, in the dev server:

```
npm run dev:mock                     # starts the mock and Vite together, with the flag on (one terminal)
```

or by hand, in two terminals:

```
npm run mock:contract                # mock on http://localhost:3999
MOCK_CONTRACT=1 npm run dev          # PowerShell: $env:MOCK_CONTRACT="1"; npm run dev
```

While it is on, a dark strip across the top of the app says **"Mock server on"**, so fake numbers can't be mistaken for real
ones. Without the flag, a route the backend doesn't have yet shows **"Not available yet"** on that screen. The app never shows
placeholder numbers.

Production builds never use it. `MOCK_CONTRACT` is read only for `npm run dev`; `vite build` and `vite preview` ignore it. To
prove that, run:

```
npm run check:build
```

It builds the app with the flag switched on, then fails if the build (or `src/`) contains the mock's name, flag, address,
banner text or fake records, and checks that the "Not available yet" state is in the build. Run it before shipping.

When the real routes are live, just stop using the flag. Every call is in `src/api.js`.

## Settings you can change

| Variable | Used by | What it does |
| --- | --- | --- |
| `BACKEND_URL` | dev server | Where `/api` is forwarded. Default `http://localhost:3000`. |
| `MOCK_CONTRACT=1` | dev server only | Sends `/api` to the mock (see above). |
| `MOCK_URL` | dev server | Mock address. Default `http://localhost:3999`. |
| `MOCK_PORT` | mock | Port the mock listens on. Default `3999`. |
| `VITE_API_BASE` | build | API address for a production build. Default `/api`. |

## Build and preview

```
npm run build        # production build into dist/
npm run preview      # serves dist/ (plain http)
```

The signed-in app is its own chunk, so the landing page never downloads the app screens. A first visit to the landing page is
6 requests: the page, its CSS (about 11 KB with gzip), its JavaScript (about 65 KB with gzip), the icon, the manifest and the
hero photo. Every other photo loads only when the visitor scrolls near it. `/accuracy` is a "coming soon" placeholder: a host
serving `dist/` needs to send `index.html` for unknown paths so that address works.

## The landing page

`src/screens/Landing.jsx` shows when no shop is open. It only lists the sections; each one is a component in `src/landing/`
(`Nav`, `Hero`, `Market`, `HowItWorks`, `WhatsAppWeb`, `Features`, `Shops`, `Trust`, `FinalCta`, `Footer`), built from
shared pieces in `parts.jsx` (`Section`, `Pill`, `IconTile`, `Photo`, `ImageCard`, `CardRow`). Copy is plain trader language,
sections alternate white and warm cream with one deep violet section (Trust), and the violet-to-blue gradient stays the
primary button colour.

**Images.** The photos are AI-generated and live in `public/landing/` (they come from outside this repo's code, so don't edit
that folder from here). Each slot is filled at build time by `scripts/landing-images.mjs`: `public/landing/photos/<slot>.webp`
if it exists, else `public/landing/illustrations/<slot>.svg` (not for `shop-*` slots), else the slot is left out. Nothing asks
the browser for a file that isn't there. Slots: `hero-trader`, `goods-rice`, `goods-eggs`, `goods-cartons`, `goods-measure`,
`hands-notebook`, `market-lane`, `voice-note`, `shop-provision`, `shop-kiosk`, `shop-counter`, `shop-wholesale`. A new or
replaced image needs only the right file name, and its size is read from the file. The footer says the images are
AI-generated; keep that line, and don't present them as real customers or shops.

```
npm run check:images   # shows which slots use a photo, an illustration, or nothing, and tests the fallback rules
npm run check:copy     # the WhatsApp mockup says exactly what the real bot says (messages.mjs)
```

**Motion** is gentle and uses only CSS transitions, CSS keyframes and IntersectionObserver (`src/landing/motion.jsx`): sections
fade and rise once as they scroll in, the hero chips bob slowly, the WhatsApp demo plays while it is on screen and stops
off screen, and the hash chain draws and then shows a change being caught. With `prefers-reduced-motion` everything is still
and shows its final state.

Alert Guard and offline notes are not built yet (`../PROJECT.md`, section 5), so the landing page doesn't mention them. The
privacy note and the accuracy page are placeholders: Trust ends with a plain "Accuracy results will be published here." line, and
the footer's Accuracy link goes to the "coming soon" page. There is no link to a WhatsApp number: the bot runs on a test number, so
"See it on WhatsApp" scrolls to the demo instead.

## Look and feel

- Light mode is the default on a first visit, whatever the phone's setting is. Dark mode only after the Sun/Moon button is tapped;
  the choice is kept on the device.
- Colour means something: the brand gradient is money in, amber is money owed, coral/rose is losses, teal is kept and verified
  (no green anywhere). All tokens are in `src/index.css` (`@theme`).
- Touch targets are at least 48px, and text meets WCAG AA contrast in both themes.

## Where things are

```
src/api.js              every call to the backend (nothing else talks to it)
src/Root.jsx            landing page when signed out, the app when signed in
src/App.jsx             top bar, five-slot dock, More sheet
src/screens/            one file per screen
src/ui.jsx              shared pieces: Card, Button, Pill, Sheet, NotAvailable...
src/ProfitChart.jsx     the profit bar chart (plain SVG, no chart library)
scripts/seed-demo.mjs   fills the demo shop through propose -> confirm
scripts/mock-contract.mjs, dev-mock.mjs, check-no-mock.mjs   see "The mock server"
scripts/landing-images.mjs, check-landing-images.mjs, check-landing-copy.mjs   see "The landing page"
public/                 icons, manifest, service worker, landing/ (photos)
src/landing/            one component per landing section, plus shared parts and motion
```
