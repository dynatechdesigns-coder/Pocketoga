// Landing-page motion: IntersectionObserver plus CSS transitions on opacity and
// transform only (no layout is ever animated), no animation library. With
// prefers-reduced-motion, everything shows in its final state at once.
import { useEffect, useRef, useState } from "react";
import { cx } from "../ui.jsx";

const canObserve = typeof window !== "undefined" && "IntersectionObserver" in window;

const REDUCED = "(prefers-reduced-motion: reduce)";

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(REDUCED).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCED);
    const sync = () => setReduced(query.matches);
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

// Whether the element is on screen. `once`: stays true after the first time.
// Without IntersectionObserver it reports true, so nothing stays hidden.
export function useInView(ref, { once = false, threshold = 0.2, rootMargin = "0px" } = {}) {
  const [inView, setInView] = useState(!canObserve);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canObserve) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setInView(entry.isIntersecting);
        if (entry.isIntersecting && once) io.disconnect();
      },
      { threshold, rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, once, threshold, rootMargin]);
  return inView;
}

// Fades and rises in the first time it scrolls into view. `delay` staggers
// siblings (kept short: content is never held back more than 600ms).
export function Reveal({ as: Tag = "div", delay = 0, className, style, children, ...props }) {
  const ref = useRef(null);
  const seen = useInView(ref, {
    once: true,
    threshold: 0.12,
    rootMargin: "0px 0px -8% 0px",
  });
  const reduced = useReducedMotion();
  // With reduced motion everything is simply there, scrolled to or not.
  const shown = seen || reduced;
  return (
    <Tag
      ref={ref}
      data-reveal={shown ? "shown" : "hidden"}
      className={cx(
        "transition-[opacity,translate] duration-[400ms] ease-out-soft",
        shown ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
        className,
      )}
      style={{
        transitionDelay: shown ? `${Math.min(delay, 300)}ms` : "0ms",
        ...style,
      }}
      {...props}
    >
      {children}
    </Tag>
  );
}
