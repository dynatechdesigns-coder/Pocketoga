// Shared building blocks: Card, Button, Pill, Avatar, IconCircle, Sheet, plus
// data loading and the loading / error / empty states. Screens are built from
// these so the look stays consistent. Colours, radii and shadows come from the
// theme in index.css. Class strings are written out in full (never pieced
// together) so Tailwind can find them.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { friendlyError } from "./api.js";

// Joins class names, skipping empty ones.
export const cx = (...parts) => parts.filter(Boolean).join(" ");

// Runs an async loader on mount. Returns { data, error, loading, reload }.
export function useLoad(loader) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ loading: false, data: await loader(), error: null });
    } catch (err) {
      setState({ loading: false, data: null, error: friendlyError(err) });
    }
  }, [loader]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { ...state, reload };
}

// Fade and rise in on load, one after another; `i` is the position.
export const rise = (i, className = "") => ({
  className: cx(className, "animate-rise"),
  style: { animationDelay: `${i * 60}ms` },
});

// --- Card ----------------------------------------------------------------------

export function Card({ as: Tag = "div", className, ...props }) {
  return <Tag className={cx("rounded-card bg-card p-5 shadow-soft", className)} {...props} />;
}

// --- Button --------------------------------------------------------------------

// Each variant sets its own border colour: two border colours on one element
// would be decided by stylesheet order, not by the order written here.
const BUTTON_VARIANTS = {
  primary: "border-transparent bg-primary text-white",
  secondary: "border-transparent bg-lavender text-link",
  quiet: "border-line bg-card text-ink",
  amber: "border-amber bg-amber-soft text-amber-ink",
};
const BUTTON_SIZES = {
  sm: "px-3.5 py-2.5 text-[0.9375rem]",
  md: "px-5 py-3 text-base",
  lg: "min-h-14 px-5 py-3 text-[1.0625rem]",
};

// Pill-shaped button. `as="a"` for links. Disabled looks disabled: flat grey
// with a dashed edge; `calm` keeps the edge solid for an empty form.
export function Button({ as: Tag = "button", variant = "primary", size = "md", calm, className, ...props }) {
  return (
    <Tag
      className={cx(
        "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-[1.5px] font-bold no-underline",
        "transition-[transform,background-color] duration-150 ease-out-soft active:scale-96 [&_svg]:size-5",
        "disabled:cursor-not-allowed disabled:border-dashed disabled:border-grey disabled:bg-slate disabled:text-muted disabled:active:scale-100",
        calm && "disabled:border-solid disabled:border-transparent",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...props}
    />
  );
}

// --- Pill ----------------------------------------------------------------------

const PILL_TONES = {
  teal: "bg-teal-soft text-teal-ink", // kept, verified only
  amber: "bg-amber-soft text-amber-ink",
  coral: "bg-coral-soft text-coral-ink",
  slate: "bg-slate text-muted",
};

export function Pill({ tone, children }) {
  return (
    <span data-part="pill" data-tone={tone} className={cx("inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold", PILL_TONES[tone])}>
      {children}
    </span>
  );
}

// --- IconCircle ------------------------------------------------------------------

const ICON_TONES = {
  lavender: "bg-lavender text-link",
  blue: "bg-blue-soft text-blue-ink",
  amber: "bg-amber-soft text-amber-ink",
  coral: "bg-coral-soft text-coral-ink",
  teal: "bg-teal-soft text-teal-ink",
  slate: "bg-slate text-muted",
};
const ICON_SIZES = {
  sm: "size-9 [&_svg]:size-[18px]",
  md: "size-11 [&_svg]:size-[22px]",
  lg: "size-14 [&_svg]:size-[26px]",
};

// A Lucide icon in a tinted circle.
export function IconCircle({ icon: Icon, tone = "lavender", size = "md" }) {
  return (
    <span className={cx("grid shrink-0 place-items-center rounded-full", ICON_TONES[tone], ICON_SIZES[size])} aria-hidden="true">
      <Icon strokeWidth={2} />
    </span>
  );
}

// --- Avatar --------------------------------------------------------------------

const AVATAR_TINTS = [
  "bg-av0 text-av0-ink",
  "bg-av1 text-av1-ink",
  "bg-av2 text-av2-ink",
  "bg-av3 text-av3-ink",
  "bg-av4 text-av4-ink",
  "bg-av5 text-av5-ink",
];
const AVATAR_SIZES = {
  md: "size-11 text-[0.9375rem]",
  btn: "size-12 text-[0.9375rem]",
  lg: "size-14 text-lg",
};

// Initials in a soft tint picked from the name, so a customer always gets
// the same colour.
export function Avatar({ name, size = "md" }) {
  const words = String(name).trim().split(/\s+/);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const ch of String(name).toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span
      data-part="avatar"
      className={cx("grid shrink-0 place-items-center rounded-full font-extrabold tracking-wide", AVATAR_TINTS[hash % 6], AVATAR_SIZES[size])}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

// --- States ----------------------------------------------------------------------

// Placeholder blocks the same size as the real content: nothing jumps.
export function Skeleton({ blocks, label = "Loading" }) {
  return (
    <div className="grid gap-4" role="status" aria-label={label}>
      {blocks.map((h, i) => (
        <div key={i} data-part="skeleton" className="animate-pulse-soft rounded-card bg-skeleton" style={{ height: h }} />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <Card className="grid justify-items-start gap-3 border-[1.5px] border-line p-6" role="alert">
      <p className="text-lg font-extrabold">That did not load</p>
      <p className="text-muted">{message}</p>
      <Button variant="secondary" className="w-auto min-w-42" onClick={onRetry}>
        Retry
      </Button>
    </Card>
  );
}

export function EmptyState({ icon, title, children, action, onAction }) {
  return (
    <Card {...rise(0, "grid justify-items-start gap-3 p-6")}>
      {icon && <IconCircle icon={icon} tone="lavender" />}
      <p className="text-lg font-extrabold">{title}</p>
      {children && <p className="text-muted">{children}</p>}
      {action && (
        <Button className="w-auto min-w-42" onClick={onAction}>
          {action}
        </Button>
      )}
    </Card>
  );
}

export function ScreenHeader({ title, sub }) {
  return (
    <header className="mb-4">
      {sub && <p className="mb-0.5 text-sm font-semibold text-muted">{sub}</p>}
      <h1 className="text-2xl font-extrabold leading-tight tracking-tight">{title}</h1>
    </header>
  );
}

export const SectionTitle = ({ as: Tag = "h2", className, ...props }) => (
  <Tag className={cx("mt-2 text-[1.0625rem] font-extrabold", className)} {...props} />
);

// Money figures: bold tabular numerals that never overflow.
export const figure = "font-extrabold leading-tight tracking-tight tabular-nums [overflow-wrap:anywhere]";

// --- Sheet ----------------------------------------------------------------------

// Bottom sheet: slides up over the screen, closes on the backdrop, the X
// button or Escape, keeps focus inside while open and gives it back after.
export function Sheet({ open, onClose, title, children }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panel = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    if (open) {
      opener.current = document.activeElement;
      setMounted(true);
      // Two frames so the closed position paints before sliding up.
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return;
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 340);
    return () => clearTimeout(t);
  }, [open]);

  // No page scrolling behind an open sheet; focus goes back afterwards.
  useEffect(() => {
    if (!mounted) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      opener.current?.focus?.();
    };
  }, [mounted]);

  useEffect(() => {
    if (shown) panel.current?.focus();
  }, [shown]);

  // While open the sheet may grow but never shrinks, so swapping its
  // content (e.g. the confirm card for "Saved") does not make it jump.
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (!open) {
      el.style.minHeight = "";
      return;
    }
    el.style.minHeight = `${Math.max(el.offsetHeight, parseFloat(el.style.minHeight) || 0)}px`;
  });

  function onKeyDown(e) {
    if (e.key === "Escape") onClose();
    if (e.key !== "Tab") return;
    const items = panel.current.querySelectorAll("button,a[href],textarea,input");
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div data-part="sheet-layer" data-state={shown ? "open" : "closed"} className="fixed inset-0 z-50 flex flex-col justify-end" onKeyDown={onKeyDown}>
      <div className={cx("absolute inset-0 bg-backdrop transition-opacity duration-300 ease-out-soft", shown ? "opacity-100" : "opacity-0")} onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
        className={cx(
          "relative mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-sheet bg-page outline-none",
          "transition-transform duration-[340ms] ease-out-soft md:mb-6 md:max-h-[calc(100vh-48px)] md:rounded-sheet",
          shown ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div className="mx-auto mt-2.5 h-[5px] w-10 rounded-full bg-line" aria-hidden="true" />
        <div className="flex items-center justify-between gap-4 px-5 py-2">
          <h2 className="text-xl font-extrabold">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="grid size-12 place-items-center rounded-full bg-slate text-ink transition-transform active:scale-96 [&_svg]:size-5">
            <X />
          </button>
        </div>
        <div className="flex flex-1 flex-col overflow-y-auto overscroll-contain px-5 pt-2 pb-[calc(24px+env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>,
    document.body
  );
}
