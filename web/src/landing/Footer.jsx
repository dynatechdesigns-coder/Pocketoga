import { Container } from "./parts.jsx";

const LINK = "inline-flex min-h-12 items-center font-extrabold text-link underline-offset-4 hover:underline";

// Logo, one line, links, the privacy note, and an honest note on the images.
export default function Footer({ onDemo }) {
  return (
    <footer className="border-t border-line bg-surface py-12 md:py-16">
      <Container className="grid gap-10 md:grid-cols-[1.3fr_1fr]">
        <div className="grid content-start gap-4">
          <a href="/" className="flex min-h-12 items-center gap-2.5 text-lg font-extrabold text-ink no-underline">
            <img src="/icon.svg" alt="" width="36" height="36" className="size-9 rounded-[11px]" />
            PocketOga
          </a>
          <p className="max-w-[46ch] text-[1.0625rem] leading-relaxed text-muted">
            PocketOga turns a trader's WhatsApp voice notes into records you confirm, so you always know who owes you and where your money
            goes.
          </p>
          <p id="privacy" className="max-w-[60ch] text-sm leading-relaxed text-muted">
            <strong className="font-extrabold text-ink">Privacy.</strong> The demo shop uses fake data only. For a real shop, PocketOga
            keeps that shop's records and what it heard from your notes so it can show them back to you. A customer's number is stored only
            with their permission. A full privacy policy will be published before launch.
          </p>
        </div>

        <nav aria-label="Footer" className="grid content-start justify-items-start gap-1">
          <button type="button" onClick={onDemo} className={LINK}>
            Try the demo shop
          </button>
          <a href="/accuracy" className={LINK}>
            Accuracy
          </a>
          <a href="#privacy" className={LINK}>
            Privacy
          </a>
        </nav>
      </Container>
      <Container className="mt-10 grid gap-1 border-t border-line pt-6 text-sm text-muted">
        <p>Market images are AI-generated for illustration.</p>
        <p>Built by Dynatech Labs · © {new Date().getFullYear()} PocketOga</p>
      </Container>
    </footer>
  );
}
