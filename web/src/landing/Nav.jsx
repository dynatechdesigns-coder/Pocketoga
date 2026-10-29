import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";
import { Button, ThemeToggle, cx } from "../ui.jsx";
import { Container } from "./parts.jsx";

const LINKS = [
  ["#how", "How it works"],
  ["#whatsapp", "WhatsApp"],
  ["#trust", "Trust"],
];

// Sticky nav: clear at the very top, white with a light blur once the page
// scrolls. Phones get the logo, theme toggle and button, with the section
// links behind a small menu button.
export default function Nav({ onDemo, onLogin }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The menu closes on Escape, a tap outside it, or any scroll.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e) => e.key === "Escape" && close();
    const onDown = (e) => !menu.current?.contains(e.target) && close();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", close, { passive: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", close);
    };
  }, [open]);

  return (
    <header
      data-part="nav"
      data-scrolled={scrolled}
      className={cx(
        "sticky top-0 z-40 border-b transition-[background-color,border-color] duration-200",
        scrolled ? "border-line bg-surface/85 backdrop-blur-md" : "border-transparent bg-surface",
      )}
    >
      <Container className="flex h-16 items-center justify-between gap-2 max-[399px]:gap-1.5">
        <a
          href="/"
          aria-label="PocketOga home"
          className="flex min-h-12 shrink-0 items-center gap-2 max-[399px]:gap-1.5 text-lg font-extrabold tracking-tight text-ink no-underline max-[399px]:text-base"
        >
          <img src="/icon.svg" alt="" width="36" height="36" className="size-9 shrink-0 rounded-[11px]" />
          <span>PocketOga</span>
        </a>

        <nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">
          {LINKS.map(([href, label]) => (
            <a
              key={href}
              href={href}
              className="inline-flex min-h-12 items-center rounded-full px-4 font-extrabold text-ink no-underline hover:bg-ink/5"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2 max-[399px]:gap-1.5">
          <div ref={menu} className="lg:hidden">
            <button
              data-part="menu-button"
              aria-expanded={open}
              aria-controls="landing-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
              className="grid size-12 place-items-center rounded-full border border-line bg-card text-ink max-[399px]:size-11 [&_svg]:size-[22px]"
            >
              {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
            {open && (
              <>
                {/* Dims the page below the header; a tap on it closes the menu. */}
                <div aria-hidden="true" data-part="menu-backdrop" onClick={() => setOpen(false)} className="absolute inset-x-0 top-full h-dvh bg-black/40" />
                {/* Inside the page gutter, full width, below the header. */}
                <nav
                  id="landing-menu"
                  aria-label="Sections"
                  className="absolute inset-x-5 top-full mt-2 md:inset-x-8 grid max-h-[calc(100dvh-5rem)] overflow-y-auto rounded-2xl border border-line bg-card p-2 shadow-lift"
                >
                {LINKS.map(([href, label]) => (
                  <a
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-12 items-center rounded-xl px-3 font-extrabold text-ink no-underline hover:bg-ink/5"
                  >
                    {label}
                  </a>
                ))}
                <button
                  type="button"
                  data-part="menu-login"
                  onClick={() => {
                    setOpen(false);
                    onLogin();
                  }}
                  className="flex min-h-12 items-center rounded-xl px-3 text-left font-extrabold text-link hover:bg-ink/5"
                >
                  Open my shop
                </button>
                </nav>
              </>
            )}
          </div>
          <ThemeToggle className="max-[399px]:size-11" />
          <button
            type="button"
            data-part="nav-login"
            onClick={onLogin}
            className="hidden min-h-12 items-center rounded-full px-3 font-extrabold whitespace-nowrap text-link no-underline hover:bg-ink/5 lg:inline-flex"
          >
            Open my shop
          </button>
          <Button
            data-part="nav-demo"
            variant="gradient"
            size="sm"
            className="w-auto whitespace-nowrap max-[399px]:px-2.5 max-[399px]:text-sm"
            onClick={onDemo}
          >
            <span className="max-[399px]:hidden">Try the demo shop</span>
            <span className="min-[400px]:hidden">Try demo</span>
          </Button>
        </div>
      </Container>
    </header>
  );
}
