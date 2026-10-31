// Shared pieces of the landing page: the section frame, pills, icon tiles,
// photos and photo cards. Every section component builds on these.
import { useEffect, useRef, useState } from "react";
import { cx } from "../ui.jsx";
import { image } from "./images.js";
import { Reveal } from "./motion.jsx";

// Cards and buttons lift a little on hover (hover-capable screens only).
export const LIFT = "transition-[translate,scale] duration-200 ease-out-soft hover:-translate-y-1";

export function Container({ className, children }) {
  return <div className={cx("mx-auto w-full max-w-[1200px] px-5 md:px-8", className)}>{children}</div>;
}

// white and cream sections alternate; one deep violet section for contrast.
// "violet" is a dark island: the dark-mode colour tokens apply inside it.
const TONES = {
  white: "bg-surface text-ink",
  cream: "bg-cream text-ink",
  violet: "dark bg-primary text-white [&_:focus-visible]:outline-white",
};

export function Section({ id, tone = "white", title, intro, className, children }) {
  return (
    <section id={id} aria-labelledby={title ? `${id}-h` : undefined} className={cx("scroll-mt-16 py-16 md:py-24", TONES[tone], className)}>
      <Container>
        {title && (
          <Reveal className="mb-10 max-w-[60ch] md:mb-12">
            <h2 id={`${id}-h`} className="text-[1.875rem] leading-tight font-extrabold tracking-tight md:text-4xl">
              {title}
            </h2>
            {intro && <p className="mt-3 text-[1.0625rem] leading-relaxed text-muted md:text-lg">{intro}</p>}
          </Reveal>
        )}
        {children}
      </Container>
    </section>
  );
}

const PILL_TONES = {
  sunset: "bg-sunset-soft text-sunset-ink",
  marigold: "bg-marigold-soft text-marigold-ink",
  white: "bg-white text-ink shadow-lift",
};

export function Pill({ tone = "sunset", icon: Icon, className, children, ...rest }) {
  return (
    <span
      {...rest}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-extrabold [&_svg]:size-4 [&_svg]:shrink-0",
        PILL_TONES[tone],
        className,
      )}
    >
      {Icon && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

// A lucide icon on a soft warm tile.
const TILE_SIZES = {
  lg: "size-14 [&_svg]:size-7", // 56px
  md: "size-12 [&_svg]:size-6",
  sm: "size-9 rounded-xl [&_svg]:size-[18px]",
};

export function IconTile({ icon: Icon, tone = "sunset", size = "md" }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid shrink-0 place-items-center rounded-2xl",
        tone === "sunset" ? "bg-sunset-soft text-sunset-ink" : "bg-marigold-soft text-marigold-ink",
        TILE_SIZES[size],
      )}
    >
      <Icon strokeWidth={2} />
    </span>
  );
}

// --- Photos ------------------------------------------------------------------------

// One observer for every lazy photo: the file is only requested once its frame
// is within 120px of the screen, so nothing below the fold loads on arrival.
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const waiting = new Map();
let observer = null;
function watch(el, onNear) {
  if (typeof IntersectionObserver === "undefined") return onNear();
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        waiting.get(e.target)?.();
        waiting.delete(e.target);
        observer.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px 120px 0px" },
  );
  waiting.set(el, onNear);
  observer.observe(el);
  return () => {
    waiting.delete(el);
    observer.unobserve(el);
  };
}

// A landing photo (or illustration) in its slot, or nothing if the slot has no
// image. Its box keeps the image's own proportions (or `aspect`) from the first
// paint, so nothing moves when it arrives. `fill`: covers its positioned parent
// instead (the parent sets the size and the rounding).
export function Photo({ slot, alt, eager = false, aspect, rounded = "lg", fill = false, className }) {
  const img = image(slot);
  const ref = useRef(null);
  const [near, setNear] = useState(eager);
  useEffect(() => (near || !ref.current ? undefined : watch(ref.current, () => setNear(true))), [near]);
  if (!img) return null;
  return (
    <img
      ref={ref}
      data-slot={slot}
      data-kind={img.kind}
      src={near ? img.src : BLANK}
      alt={alt}
      width={img.width}
      height={img.height}
      loading={eager ? "eager" : "lazy"}
      fetchpriority={eager ? "high" : undefined}
      decoding="async"
      style={aspect && !fill ? { aspectRatio: aspect } : undefined}
      className={cx(
        "bg-cream object-cover",
        fill ? "absolute inset-0 size-full" : "block h-auto w-full ring-1 ring-ink/10",
        !fill && (rounded === "lg" ? "rounded-[24px]" : "rounded-[16px]"),
        className,
      )}
    />
  );
}

// A photo with a short caption in trader language. Nothing at all if the slot
// has no image (no empty boxes).
export function ImageCard({ slot, alt, caption, aspect = "4 / 5", rounded = "lg", className }) {
  if (!image(slot)) return null;
  return (
    <figure data-part="image-card" className={cx("grid gap-3", LIFT, className)}>
      <Photo slot={slot} alt={alt} aspect={aspect} rounded={rounded} />
      {caption && <figcaption className="text-[1.0625rem] font-extrabold">{caption}</figcaption>}
    </figure>
  );
}

// Cards side by side: a sideways snap-scroll row on phones, a grid of `cols`
// from md up. The row can take keyboard focus so it can be scrolled with arrow
// keys.
const GRID_COLS = { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" };
export function CardRow({ label, cols = 4, className, children }) {
  return (
    <div
      role="group"
      aria-label={label}
      tabIndex={0}
      data-part="card-row"
      className={cx(
        "-mx-5 flex snap-x snap-mandatory scroll-px-5 gap-4 overflow-x-auto px-5 pb-2 [scrollbar-width:thin]",
        "md:mx-0 md:grid md:snap-none md:overflow-visible md:px-0 md:pb-0",
        GRID_COLS[cols],
        "*:w-[72%] *:shrink-0 *:snap-start sm:*:w-[44%] md:*:w-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}
