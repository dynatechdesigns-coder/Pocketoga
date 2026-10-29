import { useRef } from "react";
import { Pill, cx } from "../ui.jsx";
import { useInView } from "./motion.jsx";

// Tamper detection (on the violet Trust section), shown once when it scrolls into view: three saved entries,
// the links between them draw in one after another, then entry 2 is changed:
// it turns coral and the link after it shows "broken". Transitions only
// (opacity and transform); with reduced motion the final state shows at once.
// The words carry the meaning too (aria-label and caption), not just colour.

const BLOCKS = [
  { title: "Entry 1", hash: "a3f9…", after: null },
  { title: "Entry 2", hash: "7c21…", after: "changed" },
  { title: "Entry 3", hash: "e05b…", after: "no match" },
];
const W = 76; // block width; blocks sit 128 apart, leaving 52 for each link
const x0 = (i) => 4 + i * 128;
const Y = 8; // top of the blocks
const H = 108; // block height
const MID = Y + H / 2; // the links run through the middle

// When each part happens, in ms after the chain is first seen (all under 1.3s).
const T = { link: [0, 300], change: 900, broken: 1150 };

export default function ChainDemo() {
  const ref = useRef(null);
  const play = useInView(ref, { once: true, threshold: 0.5 });
  const later = (ms) => ({ transitionDelay: play ? `${ms}ms` : "0ms" });
  const fade = "transition-opacity duration-[400ms] ease-out-soft";

  return (
    <figure
      ref={ref}
      data-part="hash-chain"
      data-state={play ? "played" : "idle"}
      className="grid h-full content-center gap-5 rounded-[24px] border border-white/15 bg-black/20 p-5 md:p-8"
    >
      {/* The status flips from teal to coral with the chain. */}
      <div className="grid justify-items-start [grid-template-areas:'s'] *:[grid-area:s]">
        <span className={cx(fade, play ? "opacity-0" : "opacity-100")} style={later(T.change)}>
          <Pill tone="teal">Every link matches</Pill>
        </span>
        <span className={cx(fade, play ? "opacity-100" : "opacity-0")} style={later(T.change)}>
          <Pill tone="coral">One entry changed: chain broken</Pill>
        </span>
      </div>

      <svg
        viewBox="0 0 344 124"
        role="img"
        aria-label="Three ledger entries, each linked to the one before. Then entry 2 is changed: it turns red, and the link to entry 3 shows broken. That is how PocketOga spots a changed record."
        className="block h-auto w-full"
      >
        {BLOCKS.map((b, i) => (
          <g key={b.title}>
            {i > 0 && <Link from={x0(i - 1) + W} to={x0(i)} index={i} play={play} />}
            {/* Intact block, and its changed version fading in on top. */}
            <Block x={x0(i)} title={b.title} line={b.hash} ok />
            {b.after && (
              <g className={cx(fade, play ? "opacity-100" : "opacity-0")} style={later(i === 1 ? T.change : T.broken)}>
                <Block x={x0(i)} title={b.title} line={b.after} />
              </g>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="text-base leading-relaxed text-muted">
        Illustration. Change one saved entry and every link after it stops matching, so PocketOga shows it in red.
      </figcaption>
    </figure>
  );
}

function Block({ x, title, line, ok }) {
  return (
    <>
      <rect
        x={x}
        y={Y}
        width={W}
        height={H}
        rx="16"
        strokeWidth="2"
        className={ok ? "fill-teal-soft stroke-teal-ink" : "fill-coral-soft stroke-coral-ink"}
      />
      <text x={x + W / 2} y={MID - 6} textAnchor="middle" className={cx("text-[15px] font-bold", ok ? "fill-teal-ink" : "fill-coral-ink")}>
        {title}
      </text>
      <text x={x + W / 2} y={MID + 18} textAnchor="middle" className={cx("text-[13px]", ok ? "fill-teal-ink" : "fill-coral-ink")}>
        {line}
      </text>
    </>
  );
}

// A link draws from left to right (scale on the x axis from its left edge);
// the second one later fades to a broken, dashed coral link.
function Link({ from, to, index, play }) {
  const y = MID;
  const draw = T.link[index - 1];
  const breaks = index === 2;
  const grow = "origin-left [transform-box:fill-box] transition-[scale,opacity] duration-[400ms] ease-out-soft";
  return (
    <g>
      <g
        className={cx(grow, "stroke-teal-ink", play ? "scale-x-100" : "scale-x-0", breaks && play && "opacity-0")}
        style={{
          transitionDelay: play ? `${draw}ms, ${breaks ? T.broken : 0}ms` : "0ms",
        }}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      >
        <path d={`M${from + 6} ${y} H${to - 4}`} />
        <path d={`M${to - 13} ${y - 8} L${to - 4} ${y} L${to - 13} ${y + 8}`} />
      </g>
      {breaks && (
        <g
          className={cx("transition-opacity duration-[400ms] ease-out-soft", play ? "opacity-100" : "opacity-0")}
          style={{ transitionDelay: play ? `${T.broken}ms` : "0ms" }}
        >
          <path
            d={`M${from + 6} ${y} H${to - 4}`}
            className="stroke-coral-ink"
            strokeWidth="2.5"
            strokeDasharray="4 4"
            strokeLinecap="round"
            fill="none"
          />
          <text x={(from + to) / 2} y={MID - 12} textAnchor="middle" className="fill-coral-ink text-[12px] font-bold">
            broken
          </text>
        </g>
      )}
    </g>
  );
}
