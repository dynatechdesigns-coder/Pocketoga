import { ArrowLeft } from "lucide-react";
import { ACCURACY_DATE, ACCURACY_TITLE, FIELDS, FLAGGED, LIMITS, REAL_WORLD, RESULTS, SETUPS, SPEED, STRUGGLES, SUMMARY, TESTED } from "../accuracyData.js";
import { Button, Card, ThemeToggle, cx } from "../ui.jsx";

// Swatch and bar colours per part. The same tokens as the rest of the app, so
// light and dark mode both stay readable; the numbers are written beside it.
const PART_COLOR = { correct: "bg-teal", flagged: "bg-amber", silent: "bg-coral" };

function Bullets({ items }) {
  return (
    <ul className="grid list-disc gap-2 pl-5 [overflow-wrap:anywhere]">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

// The public, static accuracy page: a dated test result in plain words. One CSS
// bar, no chart library. Every number comes from accuracyData.js.
export default function AccuracyPage() {
  const shown = RESULTS.parts.filter((p) => p.count > 0);
  return (
    <main data-part="accuracy" className="mx-auto grid min-w-0 max-w-[640px] gap-6 px-5 pt-[calc(24px+env(safe-area-inset-top))] pb-12">
      <div className="flex items-center justify-between gap-3">
        <a href="/" className="inline-flex min-h-12 items-center gap-2 font-bold text-link no-underline [&_svg]:size-5">
          <ArrowLeft aria-hidden="true" /> PocketOga
        </a>
        <ThemeToggle />
      </div>

      <header className="grid gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight [overflow-wrap:anywhere]">{ACCURACY_TITLE}</h1>
        <p className="text-muted">Tested on {ACCURACY_DATE}. In plain words.</p>
      </header>

      <section className="grid gap-2" aria-labelledby="tested-title">
        <h2 id="tested-title" className="text-xl font-extrabold tracking-tight">
          {TESTED.heading}
        </h2>
        <p className="[overflow-wrap:anywhere]">{TESTED.text}</p>
      </section>

      <Card as="section" data-part="accuracy-results" aria-labelledby="results-title" className="grid min-w-0 gap-4">
        <h2 id="results-title" className="text-xl font-extrabold tracking-tight">
          {RESULTS.heading}
        </h2>
        <div
          data-part="accuracy-bar"
          role="img"
          aria-label={SUMMARY}
          className="flex h-8 w-full min-w-0 overflow-hidden rounded-full border border-line bg-slate"
        >
          {shown.map((p) => (
            <span key={p.key} data-segment={p.key} className={cx("h-full", PART_COLOR[p.key])} style={{ width: `${p.percent}%` }} />
          ))}
        </div>
        <ul className="grid gap-3">
          {RESULTS.parts.map((p) => (
            <li key={p.key} data-part={`accuracy-${p.key}`} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3">
              <span aria-hidden="true" className={cx("mt-1.5 size-4 rounded-full border border-line", PART_COLOR[p.key])} />
              <span className="grid min-w-0">
                <span className="font-extrabold tabular-nums">
                  {p.label}: {p.count} of {RESULTS.total} ({p.percent}%)
                </span>
                <span className="text-sm text-muted [overflow-wrap:anywhere]">{p.note}</span>
              </span>
            </li>
          ))}
        </ul>
        <dl className="grid gap-2 border-t border-line pt-3">
          {SETUPS.rows.map((r) => (
            <div key={r.label} className="flex min-w-0 flex-wrap justify-between gap-x-3">
              <dt className="font-bold">{r.label}</dt>
              <dd className="tabular-nums">
                {r.correct} correct, {r.flagged} flagged, {r.silent} silent
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <section className="grid gap-2" aria-labelledby="fields-title">
        <h2 id="fields-title" className="text-xl font-extrabold tracking-tight">
          {FIELDS.heading}
        </h2>
        <dl className="grid gap-2">
          {FIELDS.rows.map((r) => (
            <div key={r.label} className="flex min-w-0 flex-wrap justify-between gap-x-3 border-b border-line pb-2 last:border-b-0">
              <dt className="font-bold">{r.label}</dt>
              <dd className="tabular-nums">
                {r.right} of {FIELDS.of}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-2" aria-labelledby="flagged-title">
        <h2 id="flagged-title" className="text-xl font-extrabold tracking-tight">
          {FLAGGED.heading}
        </h2>
        <p>{FLAGGED.text}</p>
      </section>

      <section className="grid gap-2" aria-labelledby="struggles-title">
        <h2 id="struggles-title" className="text-xl font-extrabold tracking-tight">
          {STRUGGLES.heading}
        </h2>
        <Bullets items={STRUGGLES.items} />
      </section>

      <section className="grid gap-2" aria-labelledby="speed-title">
        <h2 id="speed-title" className="text-xl font-extrabold tracking-tight">
          {SPEED.heading}
        </h2>
        <Bullets items={SPEED.items} />
      </section>

      <section className="grid gap-2" aria-labelledby="limits-title">
        <h2 id="limits-title" className="text-xl font-extrabold tracking-tight">
          {LIMITS.heading}
        </h2>
        <Bullets items={LIMITS.items} />
      </section>

      <section data-part="real-world" className="grid gap-2" aria-labelledby="real-world-title">
        <h2 id="real-world-title" className="text-xl font-extrabold tracking-tight">
          {REAL_WORLD.heading}
        </h2>
        <p className="[overflow-wrap:anywhere]">{REAL_WORLD.text}</p>
      </section>

      <Button as="a" href="/" variant="secondary" className="w-auto min-w-42 justify-self-start">
        Back to the home page
      </Button>
    </main>
  );
}
