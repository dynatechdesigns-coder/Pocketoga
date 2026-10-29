import { useState } from "react";
import { BarChart3, HandCoins, Link2, MessageCircle, Mic, ShieldAlert, ShieldCheck, WifiOff } from "lucide-react";
import { DEMO_SHOP_ID } from "../api.js";
import { waNumber } from "../reminders.js";
import { Button, Card, IconCircle, Pill, ThemeToggle, cx, inputClass, rise } from "../ui.jsx";

// The page a visitor sees when no shop is open. Violet-to-blue gradient from
// the app, real screenshots of the demo shop (public/screens/*.webp, fake data
// only), no stock photos. Mobile first; the pictures below the first screen
// load lazily so the first paint stays light.

// "Chat on WhatsApp" goes to the number in VITE_WHATSAPP_NUMBER (digits, set at
// build time). Without one, WhatsApp opens its contact picker with the message
// ready, so the button never points at a made-up number.
const WA_TEXT = "Hi PocketOga, I want to try it for my shop.";
const WA_LINK = `https://wa.me/${waNumber(import.meta.env.VITE_WHATSAPP_NUMBER) ?? ""}?text=${encodeURIComponent(WA_TEXT)}`;

const DEMO_SHOP = { id: DEMO_SHOP_ID, name: "Mama Nkechi Provisions", demo: true };

export default function Landing({ onOpen }) {
  const demo = () => onOpen(DEMO_SHOP);

  return (
    <div data-part="landing" className="overflow-x-clip">
      {/* Masthead: nav and the first screen, on the brand gradient (money in). */}
      <header className="relative isolate overflow-hidden bg-hero text-white after:absolute after:-top-[120px] after:-right-[100px] after:-z-10 after:size-[360px] after:rounded-full after:bg-white/8 after:content-['']">
        <div className="mx-auto max-w-[1080px] px-5">
          <div className="flex items-center justify-between gap-3 pt-[calc(14px+env(safe-area-inset-top))]">
            <a href="/" className="flex min-h-12 items-center gap-2.5 text-lg font-extrabold tracking-tight text-white no-underline">
              <img src="/icon.svg" alt="" width="36" height="36" className="size-9 rounded-[11px]" />
              PocketOga
            </a>
            <div className="flex items-center gap-2">
              <Button data-part="nav-demo" variant="light" size="sm" className="w-auto whitespace-nowrap" onClick={demo}>
                Try demo
              </Button>
              <ThemeToggle />
            </div>
          </div>

          <div className="grid gap-8 pt-9 md:grid-cols-[1.15fr_0.85fr] md:items-center md:gap-10 md:pt-14 md:pb-16">
            <div className="grid content-start gap-5">
              <h1 {...rise(0, "text-[2.5rem] leading-[1.08] font-extrabold tracking-tight md:text-[3.5rem]")}>Find the money your shop is losing</h1>
              <p {...rise(1, "max-w-[34rem] text-[1.125rem] font-medium md:text-xl")}>
                Say your sales in English or Pidgin. PocketOga keeps the records, chases who owes you, and shows where money leaks.
              </p>
              <div {...rise(2, "grid gap-3 sm:flex sm:flex-wrap")}>
                <Button data-part="hero-demo" variant="light" size="lg" className="sm:w-auto sm:min-w-56" onClick={demo}>
                  Try the demo shop
                </Button>
                <Button as="a" data-part="hero-whatsapp" variant="frost" size="lg" className="sm:w-auto sm:min-w-56" href={WA_LINK} target="_blank" rel="noopener noreferrer">
                  <MessageCircle aria-hidden="true" /> Chat on WhatsApp
                </Button>
              </div>
              <p className="text-sm font-semibold">No signup. No password. The demo shop uses fake data only.</p>
            </div>

            {/* The phone is cut off by the bottom of the masthead on small
                screens, so it looks tucked in; whole on wide ones. */}
            <div {...rise(1, "mx-auto h-[280px] w-[min(66vw,248px)] overflow-hidden md:h-auto md:w-[290px] md:overflow-visible")}>
              <PhoneFrame
                src="/screens/money.webp"
                alt="The Money screen of the demo shop: ₦27,000 sold and collected today, ₦213,000 owed by 5 customers, and 3 things that need attention."
                eager
              />
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* How it works */}
        <Section id="how" title="How it works" intro="Three steps. Nothing is saved until you say so.">
          <ol className="grid gap-4 md:grid-cols-3">
            <Step n={1} title="Talk or type">
              <p>Say it the way you talk, in English or Pidgin.</p>
              <p data-part="bubble" className="mt-3 flex items-start gap-3 rounded-[20px_20px_20px_6px] bg-lavender px-4 py-3 text-ink">
                <Mic aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-link" />
                <span>“Mama Bisi buy 2 bags of rice, 118k total. She pay 100k, remain 18k.”</span>
              </p>
            </Step>
            <Step n={2} title="Check the card">
              <p>PocketOga shows what it heard: who, how much, what is still owed. Wrong? Tap Fix and say what to change.</p>
              <PhoneFrame
                className="mx-auto mt-4 max-w-[240px]"
                src="/screens/confirm.webp"
                alt="The confirm card: the note PocketOga heard, a sale of ₦118,000 and a payment of ₦100,000 for Mama Bisi, ₦18,000 still owed, and the buttons Save, Fix and Reject."
              />
            </Step>
            <Step n={3} title="Tap Save">
              <p>Only then is it written to your ledger. You can always see it, and nobody can edit it.</p>
              <PhoneFrame
                className="mx-auto mt-4 max-w-[240px]"
                src="/screens/ledger.webp"
                alt="The Ledger screen: a teal banner saying Records verified, and the day's entries."
              />
            </Step>
          </ol>
        </Section>

        {/* Features */}
        <Section id="features" title="What PocketOga does">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Feature icon={Mic} title="Voice notes in Pidgin">
              Say “Chinedu buy 3 cartons Indomie, he don pay” and PocketOga writes it down. You can type it too.
            </Feature>
            <Feature icon={HandCoins} title="Debts and promises">
              See who owes you, who promised to pay and who broke a promise. Reminders are ready to send from your own WhatsApp.
            </Feature>
            <Feature icon={BarChart3} title="Money check">
              Sold more than you bought? Selling below cost? Broken promises? See where money leaks, and your estimated profit.
            </Feature>
            <Feature icon={ShieldAlert} title="Alert Guard" soon>
              Checks payment screenshots, receipts and SMS alerts, and only warns. It never says a payment is verified: you confirm
              the credit.
            </Feature>
            <Feature icon={WifiOff} title="Offline notes" soon>
              No network? Record anyway. Notes wait on your phone and are sent when you are back online.
            </Feature>
          </ul>

          <div className="mt-8 grid grid-cols-2 gap-4 md:mx-auto md:max-w-[640px] md:gap-8">
            <figure className="grid gap-2">
              <PhoneFrame src="/screens/debts.webp" alt="The Debts screen: customers who owe money, most urgent first, with Broken, Due and Kept labels." />
              <figcaption className="text-center text-sm font-bold">Debts and promises</figcaption>
            </figure>
            <figure className="grid gap-2">
              <PhoneFrame src="/screens/reports.webp" alt="The Reports screen: sales, collected, cost of goods, expenses and estimated profit, with a bar chart." />
              <figcaption className="text-center text-sm font-bold">Reports and Money check</figcaption>
            </figure>
          </div>
        </Section>

        {/* Trust */}
        <section aria-labelledby="trust-h" className="bg-lavender py-14">
          <div className="mx-auto max-w-[1080px] px-5">
            <h2 id="trust-h" className="text-[1.75rem] font-extrabold tracking-tight md:text-4xl">
              You stay in charge
            </h2>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <Card as="article" className="grid content-start gap-3">
                <IconCircle icon={ShieldCheck} tone="lavender" />
                <h3 className="text-xl font-extrabold">The AI only proposes. You confirm.</h3>
                <p className="text-muted">
                  PocketOga’s AI reads your note and suggests entries. Plain code checks every number. Nothing is saved until you tap
                  Save, and you can fix or reject any suggestion.
                </p>
              </Card>
              <Card as="article" className="grid content-start gap-3">
                <IconCircle icon={Link2} tone="lavender" />
                <h3 className="text-xl font-extrabold">A ledger that cannot be edited</h3>
                <p className="text-muted">
                  Each saved entry carries the fingerprint of the one before it. Change one, and every link after it stops matching,
                  and PocketOga warns you in red. Mistakes are fixed by adding a correction, never by editing.
                </p>
                <HashChain />
              </Card>
            </div>
          </div>
        </section>

        {/* Proof: a placeholder until the accuracy page exists */}
        <Section id="proof" title="Proof">
          <Card as="article" data-part="proof" className="grid justify-items-start gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-xl font-extrabold">How accurate is it?</h3>
              <Pill tone="slate">Coming soon</Pill>
            </div>
            <p className="text-muted">
              We will publish how well PocketOga understands real notes: what it got right, what it got wrong, and how it was tested.
              Nothing is published yet, so there are no accuracy numbers here.
            </p>
            <Button as="a" href="/accuracy" variant="quiet" className="w-auto min-w-56">
              Accuracy page (coming soon)
            </Button>
          </Card>
        </Section>

        {/* Final call */}
        <section aria-labelledby="try-h" className="mx-auto max-w-[1080px] px-5 pb-14">
          <div className="grid justify-items-start gap-4 rounded-3xl bg-hero p-6 text-white shadow-lift md:grid-cols-[1fr_auto] md:items-center md:p-8">
            <div className="grid gap-1">
              <h2 id="try-h" className="text-2xl font-extrabold md:text-3xl">
                See it with a demo shop
              </h2>
              <p className="font-medium">Fake data, no signup. Record a note and watch the confirm card.</p>
            </div>
            <Button variant="light" size="lg" className="w-full md:w-auto md:min-w-56" onClick={demo}>
              Try the demo shop
            </Button>
          </div>
        </section>
      </main>

      <Footer onOpen={onOpen} />
    </div>
  );
}

// --- Pieces ------------------------------------------------------------------------

function Section({ id, title, intro, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mx-auto max-w-[1080px] px-5 py-14">
      <h2 id={`${id}-h`} className="text-[1.75rem] font-extrabold tracking-tight md:text-4xl">
        {title}
      </h2>
      {intro && <p className="mt-2 text-lg text-muted">{intro}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Step({ n, title, children }) {
  return (
    <li>
      <Card as="article" className="h-full">
        <div className="mb-3 flex items-center gap-3">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary text-base font-extrabold text-white">
            {n}
          </span>
          <h3 className="text-xl font-extrabold">
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
        </div>
        <div className="text-muted [&_p:first-child]:text-ink">{children}</div>
      </Card>
    </li>
  );
}

// A feature that does not exist yet says so, in words, not only in styling.
function Feature({ icon, title, soon, children }) {
  return (
    <li>
      <Card as="article" edge={soon ? "border-line border-dashed" : "border-line"} data-part="feature" data-soon={!!soon} className="grid h-full content-start gap-3">
        <div className="flex items-start justify-between gap-3">
          <IconCircle icon={icon} tone={soon ? "slate" : "lavender"} />
          {soon && <Pill tone="slate">Coming soon</Pill>}
        </div>
        <h3 className="text-lg font-extrabold">{title}</h3>
        <p className="text-muted">{children}</p>
      </Card>
    </li>
  );
}

// A real screenshot in a phone-shaped frame. Only the first screen loads
// eagerly; the rest wait until they are near the viewport.
function PhoneFrame({ src, alt, eager, className }) {
  return (
    <div className={cx("overflow-hidden rounded-[2rem] border-[6px] border-bezel bg-bezel shadow-lift ring-1 ring-line", className)}>
      <img
        src={src}
        alt={alt}
        width="576"
        height="1248"
        loading={eager ? "eager" : "lazy"}
        fetchpriority={eager ? "high" : undefined}
        decoding="async"
        className="block h-auto w-full rounded-[1.5rem]"
      />
    </div>
  );
}

// Three linked entries, intact and then with one changed. Decorative: the
// meaning is in the heading and the sentence above, and in the label here.
function HashChain() {
  return (
    <figure data-part="hash-chain" className="mt-1 grid gap-4 rounded-2xl border border-line bg-page p-4">
      <ChainRow
        label="Every link matches"
        tone="teal"
        description="Three ledger entries in a row, each linked to the one before. All links match."
        blocks={[
          { title: "Entry 1", hash: "a3f9…", ok: true },
          { title: "Entry 2", hash: "7c21…", ok: true },
          { title: "Entry 3", hash: "e05b…", ok: true },
        ]}
      />
      <ChainRow
        label="One entry changed"
        tone="coral"
        description="The same three entries after entry 2 was changed. Its fingerprint no longer matches, so the link to entry 3 is broken."
        blocks={[
          { title: "Entry 1", hash: "a3f9…", ok: true },
          { title: "Entry 2", hash: "changed", ok: false },
          { title: "Entry 3", hash: "no match", ok: false, cut: true },
        ]}
      />
      <figcaption className="text-sm text-muted">Illustration: the first row is how your ledger looks; the second is what PocketOga would warn you about.</figcaption>
    </figure>
  );
}

function ChainRow({ label, tone, description, blocks }) {
  return (
    <div className="grid gap-2">
      <Pill tone={tone}>{label}</Pill>
      <svg viewBox="0 0 336 64" role="img" aria-label={description} className="block h-auto w-full">
        {blocks.map((b, i) => {
          const x = i * 124; // blocks are 84 wide with a 40 gap; 2 spare each side for the stroke
          return (
            <g key={b.title}>
              {i > 0 && (
                <g className={blocks[i - 1].ok && b.ok ? "stroke-teal-ink" : "stroke-coral-ink"} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeDasharray={b.cut ? "4 4" : undefined}>
                  <path d={`M${x - 34} 32 H${x - 2}`} />
                  {!b.cut && <path d={`M${x - 8} 26 L${x - 2} 32 L${x - 8} 38`} />}
                </g>
              )}
              <rect
                x={x + 2}
                y="2"
                width="84"
                height="60"
                rx="12"
                strokeWidth="2"
                className={b.ok ? "fill-teal-soft stroke-teal-ink" : "fill-coral-soft stroke-coral-ink"}
              />
              <text x={x + 44} y="27" textAnchor="middle" className={cx("text-[13px] font-bold", b.ok ? "fill-teal-ink" : "fill-coral-ink")}>
                {b.title}
              </text>
              <text x={x + 44} y="46" textAnchor="middle" className={cx("text-[12px]", b.ok ? "fill-teal-ink" : "fill-coral-ink")}>
                {b.hash}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Footer({ onOpen }) {
  const [name, setName] = useState("");

  // Testing only: opens a shop by name. No password yet; real auth comes later.
  function openNamed(e) {
    e.preventDefault();
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (id) onOpen({ id, name: name.trim(), demo: false });
  }

  return (
    <footer className="border-t border-line bg-card">
      <div className="mx-auto grid max-w-[1080px] gap-8 px-5 py-10 md:grid-cols-[1.4fr_1fr]">
        <section aria-labelledby="privacy-h" data-part="privacy" className="grid content-start gap-2">
          <h2 id="privacy-h" className="text-lg font-extrabold">
            Privacy note (draft)
          </h2>
          <p className="text-muted">
            The demo shop uses fake data only. For a real shop, PocketOga keeps that shop’s records and what it heard from your notes
            so it can show them back to you. A customer’s phone number is stored only when you tick that they gave permission.
            PocketOga never sends messages for you: reminders open in your own WhatsApp. A full privacy policy will be published
            before launch.
          </p>
        </section>

        <nav aria-label="Footer" className="grid content-start gap-1">
          <a href="/accuracy" className="inline-flex min-h-12 items-center font-bold text-link">
            Accuracy (coming soon)
          </a>
          <a href={WA_LINK} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center font-bold text-link">
            Chat on WhatsApp
          </a>
          <details className="border-t border-line pt-1">
            <summary className="flex min-h-12 cursor-pointer items-center font-semibold text-muted">For testers: open a shop by name</summary>
            <form onSubmit={openNamed} className="grid gap-3 pb-2">
              <label htmlFor="shop-name" className="font-bold">
                Shop name
              </label>
              <input id="shop-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Test Shop 1" autoComplete="off" className={inputClass} />
              <Button variant="secondary" disabled={!name.trim()}>
                Open shop
              </Button>
            </form>
          </details>
        </nav>
      </div>
      <p className="border-t border-line px-5 py-5 text-center text-sm text-muted">© {new Date().getFullYear()} PocketOga</p>
    </footer>
  );
}
