import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatKobo } from "./format.js";
import { cx } from "./ui.jsx";

// Estimated profit per bucket from GET /profit `series`, as plain SVG bars on
// a zero baseline: brand blue above (a profit), coral below (a loss). One
// series, so no legend; the title names it. Tap a bar, or use the arrows, to
// see that bucket's sales, cost of goods and expenses. Every number comes
// from the server; nothing is added up here.
const H = 168; // plot height in px
const LABEL_H = 22;

export default function ProfitChart({ series, title }) {
  const box = useRef(null);
  // 0 until measured: the SVG must never set the card's width, only follow it.
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState(defaultPick(series));

  // Draw at the real pixel width so text and 4px corners stay crisp.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setPicked(defaultPick(series)), [series]);

  const n = Math.max(1, series.length);
  const max = Math.max(1, ...series.map((b) => Math.abs(b.profitKobo)));
  const hasLoss = series.some((b) => b.profitKobo < 0);
  // Zero line: near the bottom when there is no loss, else in proportion.
  const minVal = hasLoss ? Math.min(...series.map((b) => b.profitKobo)) : 0;
  const top = 8;
  const span = max - Math.min(0, minVal) || 1;
  const y = (v) => top + ((max - v) / span) * (H - top - 4);
  const zero = y(0);
  const slot = width / n;
  const barW = Math.max(6, Math.min(36, slot - 2 - slot * 0.35));
  const b = series[picked];

  return (
    <div className="grid min-w-0 gap-3" data-part="chart">
      <div ref={box} className="w-full min-w-0 overflow-hidden" style={{ height: H + LABEL_H }}>
        {width > 0 && (
          <svg
            width={width}
            height={H + LABEL_H}
            role="img"
            aria-label={`${title}. Bar chart; the table below has every value.`}
            className="block overflow-visible"
          >
            {/* Recessive guides: the zero line and the top value. */}
            <line x1="0" x2={width} y1={zero} y2={zero} className="stroke-line" strokeWidth="1" />
            {series.map((s, i) => {
              const x = i * slot + (slot - barW) / 2;
              const v = s.profitKobo;
              const h = Math.abs(y(v) - zero);
              const up = v >= 0;
              return (
                <g key={s.label} onClick={() => setPicked(i)} onMouseEnter={() => setPicked(i)} className="cursor-pointer">
                  {/* Hit area larger than the bar. */}
                  <rect x={i * slot} y="0" width={slot} height={H + LABEL_H} fill="transparent" />
                  {v !== 0 && (
                    <path
                      data-part="bar"
                      data-tone={up ? "profit" : "loss"}
                      d={bar(x, up ? zero - h : zero, barW, h, up)}
                      className={cx(up ? "fill-accent" : "fill-coral", i === picked ? "opacity-100" : "opacity-80")}
                    />
                  )}
                  {i === picked && <rect x={i * slot + 1} y="0" width={slot - 2} height={H} rx="8" className="fill-ink/5" />}
                  <text
                    x={i * slot + slot / 2}
                    y={H + 16}
                    textAnchor="middle"
                    className={cx("text-[11px]", i === picked ? "fill-ink font-bold" : "fill-muted")}
                  >
                    {s.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>

      {b && (
        <div data-part="chart-detail" className="flex items-center gap-2" aria-live="polite">
          <button
            onClick={() => setPicked((picked - 1 + n) % n)}
            aria-label="Previous"
            className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-card text-ink [&_svg]:size-5"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <dl className="grid flex-1 grid-cols-2 gap-x-3 gap-y-0.5 text-sm">
            <dt className="col-span-2 font-extrabold text-ink">{b.label}</dt>
            <dt className="text-muted">Sales</dt>
            <dd className="text-right font-bold tabular-nums">{formatKobo(b.salesKobo)}</dd>
            <dt className="text-muted">Cost of goods</dt>
            <dd className="text-right font-bold tabular-nums">{formatKobo(b.cogsKobo)}</dd>
            <dt className="text-muted">Expenses</dt>
            <dd className="text-right font-bold tabular-nums">{formatKobo(b.expensesKobo)}</dd>
            <dt className="text-muted">Est. profit</dt>
            <dd className={cx("text-right font-extrabold tabular-nums", b.profitKobo < 0 && "text-coral-ink")}>
              {formatKobo(b.profitKobo)}
            </dd>
          </dl>
          <button
            onClick={() => setPicked((picked + 1) % n)}
            aria-label="Next"
            className="grid size-12 shrink-0 place-items-center rounded-full border border-line bg-card text-ink [&_svg]:size-5"
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      )}

      {/* A table cannot shrink to sr-only's 1px (it keeps its content width
          and would widen the page), so a div does the hiding. */}
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Sales</th>
              <th scope="col">Cost of goods</th>
              <th scope="col">Expenses</th>
              <th scope="col">Estimated profit</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => (
              <tr key={s.label}>
                <th scope="row">{s.label}</th>
                <td>{formatKobo(s.salesKobo)}</td>
                <td>{formatKobo(s.cogsKobo)}</td>
                <td>{formatKobo(s.expensesKobo)}</td>
                <td>{formatKobo(s.profitKobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The latest bucket with any trading, else the last one.
function defaultPick(series) {
  for (let i = series.length - 1; i >= 0; i--) if (series[i].salesKobo || series[i].expensesKobo) return i;
  return Math.max(0, series.length - 1);
}

// A bar with 4px rounded ends away from the baseline, square at the baseline.
function bar(x, y, w, h, up) {
  const r = Math.min(4, w / 2, h);
  if (up) return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  return `M${x},${y} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w - r} Q${x + w},${y + h} ${x + w},${y + h - r} V${y} Z`;
}
