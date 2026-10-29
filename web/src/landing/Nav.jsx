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
export default function Nav({ onDemo }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menu = useRef(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The menu closes on Escape or a tap outside it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    const onDown = (e) => !menu.current?.contains(e.target) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
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
      <Container className="flex h-16 items-center justify-between gap-2">
        <a
          href="/"
          aria-label="PocketOga home"
          className="flex min-h-12 min-w-12 items-center gap-2.5 text-lg font-extrabold tracking-tight text-ink no-underline"
        >
          <img src="/icon.svg" alt="" width="36" height="36" className="size-9 rounded-[11px]" />
          <span className="max-[399px]:sr-only">PocketOga</span>
        </a>

        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
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

        <div className="flex items-center gap-2">
          <div ref={menu} className="relative md:hidden">
            <button
              data-part="menu-button"
              aria-expanded={open}
              aria-controls="landing-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
              className="grid size-12 place-items-center rounded-full border border-line bg-card text-ink [&_svg]:size-[22px]"
            >
              {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
            </button>
            {open && (
              <nav
                id="landing-menu"
                aria-label="Sections"
                className="absolute right-0 mt-2 grid w-52 rounded-2xl border border-line bg-card p-2 shadow-lift"
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
              </nav>
            )}
          </div>
          <ThemeToggle />
          <Button data-part="nav-demo" variant="gradient" size="sm" className="w-auto whitespace-nowrap max-[399px]:px-3" onClick={onDemo}>
            Try the demo shop
          </Button>
        </div>
      </Container>
    </header>
  );
}
