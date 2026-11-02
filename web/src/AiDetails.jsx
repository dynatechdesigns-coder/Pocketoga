import { AI_TITLE, aiRows } from "./aiDetails.js";
import { cx } from "./ui.jsx";

// "How the AI did this": a compact section, open by default, with one short row
// per step. Nothing here is ever a button that saves or locks anything. `photo`
// is for an alert photo ("Read the photo"). Shows nothing when the proposal
// carries no ai details.
export default function AiDetails({ proposal, photo = false, className }) {
  const rows = aiRows(proposal, { photo });
  if (rows.length === 0) return null;
  return (
    <details data-part="ai-details" open className={cx("min-w-0 rounded-2xl border border-line bg-card px-4 text-sm", className)}>
      <summary className="flex min-h-11 cursor-pointer items-center font-bold">{AI_TITLE}</summary>
      <dl className="grid gap-1.5 pb-3">
        {rows.map((r) => (
          <div
            key={r.key}
            data-part={`ai-${r.key}`}
            data-warn={r.warn}
            className={cx("flex min-w-0 flex-wrap gap-x-1.5 rounded-lg [overflow-wrap:anywhere]", r.warn && "border border-amber bg-amber-soft px-2 py-1 font-bold text-amber-ink")}
          >
            <dt className={r.warn ? "" : "text-muted"}>{r.label}:</dt>
            <dd className="min-w-0">{r.text}</dd>
            {r.sub && (
              <dd data-part={`ai-${r.key}-model`} className={cx("basis-full text-xs", r.warn ? "font-semibold" : "text-muted")}>
                {r.sub}
              </dd>
            )}
          </div>
        ))}
      </dl>
    </details>
  );
}
