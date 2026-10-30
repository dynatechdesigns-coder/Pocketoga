import { useState } from "react";
import { ArrowDownLeft, CalendarClock, Check, Info, PackagePlus, Pencil, Receipt, ShoppingBag, TriangleAlert, X } from "lucide-react";
import { confirmProposal, fixProposal, friendlyError, rejectProposal } from "../api.js";
import { formatDueDay, formatKobo, itemText } from "../format.js";
import { canSave as isSaveable, describeEntry, hintLine, problemsOf } from "../entryWords.js";
import { Button, Card, IconCircle, cx, figure, inputClass } from "../ui.jsx";

const TYPE_ICON = { sale: ShoppingBag, payment: ArrowDownLeft, restock: PackagePlus, expense: Receipt };

// Re-exported for the screens that import it from here.
export { inputClass };

// What PocketOga heard and wants to save, shown inside the bottom sheet.
// Save stays locked while anything needs checking.
export default function ConfirmCard({ proposal, shopId, onRerun, onUpdate, onFinish, onStartOver }) {
  const [busy, setBusy] = useState(null); // "save" | "fix" | "reject" | null
  const [error, setError] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [correction, setCorrection] = useState("");
  const [editing, setEditing] = useState(false);
  const [heardDraft, setHeardDraft] = useState("");
  // Only a spoken or typed note can be re-read from corrected text.
  const canEditHeard = !!onRerun && (proposal.source === "voice" || proposal.source === "text") && !proposal.correctionOf && !proposal.photoCheck;

  const problems = problemsOf(proposal);
  const canSave = isSaveable(proposal);
  const hint = hintLine(proposal);

  // Runs one button's action with a loading state and a friendly error.
  async function run(kind, action) {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      const res = await confirmProposal(proposal.id);
      onFinish({ kind: "saved", count: res.recordedIds.length, already: res.alreadyConfirmed });
    });

  const reject = () =>
    run("reject", async () => {
      await rejectProposal(proposal.id);
      onFinish({ kind: "rejected" });
    });

  const sendFix = (e) => {
    e.preventDefault();
    if (!correction.trim()) return;
    run("fix", async () => {
      onUpdate(await fixProposal(proposal.id, correction.trim()));
      setCorrection("");
      setFixing(false);
    });
  };

  const t = proposal.totals;
  const p = proposal.promise;

  return (
    <div data-part="confirm" className="grid gap-3" aria-busy={!!busy}>
      {problems.length > 0 && (
        <div data-part="check-box" role="alert" className="rounded-card border-2 border-amber bg-amber-soft px-[18px] py-4">
          <p className="flex items-center gap-1.5 text-[0.8125rem] font-extrabold tracking-[0.05em] text-amber-ink uppercase [&_svg]:size-[18px]">
            <TriangleAlert aria-hidden="true" /> Check this
          </p>
          <ul className="my-2 grid list-disc gap-1 pl-5 text-[1.0625rem] font-bold">
            {problems.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
          <p className="text-sm">Tap Fix and tell PocketOga the right answer.</p>
        </div>
      )}

      {/* "You said X but it sounds like Y": information, not an error. */}
      {hint && (
        <p data-part="hint-note" className="flex items-start gap-2 rounded-2xl border border-line bg-lavender px-4 py-3 text-link [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:shrink-0">
          <Info aria-hidden="true" /> <span>{hint}</span>
        </p>
      )}

      <figure data-part="heard" className="border-l-[3px] border-lavender py-1 pl-3.5">
        <figcaption className="text-sm font-semibold text-muted">PocketOga heard:</figcaption>
        {editing ? (
          <form
            className="mt-1 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (heardDraft.trim()) onRerun(heardDraft);
            }}
          >
            <label htmlFor="heard-text" className="sr-only">
              What you said, corrected
            </label>
            <textarea id="heard-text" rows={3} autoFocus value={heardDraft} onChange={(e) => setHeardDraft(e.target.value)} className={inputClass} />
            <div className="flex gap-2 *:flex-1">
              <Button type="button" variant="quiet" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button data-part="heard-rerun" disabled={!heardDraft.trim()}>
                Read it again
              </Button>
            </div>
          </form>
        ) : canEditHeard ? (
          <button
            type="button"
            data-part="heard-edit"
            onClick={() => {
              setHeardDraft(proposal.heard);
              setEditing(true);
            }}
            aria-label={`PocketOga heard: ${proposal.heard}. Tap to correct it.`}
            className="mt-0.5 block min-h-11 w-full rounded-lg text-left whitespace-pre-line"
          >
            <blockquote>“{proposal.heard}”</blockquote>
            <span className="inline-flex items-center gap-1 text-sm font-bold text-link underline [&_svg]:size-4">
              <Pencil aria-hidden="true" /> Not right? Tap to correct
            </span>
          </button>
        ) : (
          <blockquote className="mt-0.5 whitespace-pre-line">“{proposal.heard}”</blockquote>
        )}
      </figure>

      {proposal.entries.length > 0 ? (
        <ul className="grid gap-2" aria-label="Entries to save">
          {proposal.entries.map((e, i) => {
            const words = describeEntry(proposal, i);
            return (
            <Card as="li" key={i} className="flex items-start gap-3.5">
              <IconCircle icon={TYPE_ICON[e.type] ?? ShoppingBag} tone={e.type === "restock" ? "slate" : e.type === "payment" ? "blue" : "lavender"} />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="flex flex-wrap justify-between gap-x-2 gap-y-0.5">
                  <span data-part="entry-type" className="text-sm font-semibold text-muted">{words.type}</span>
                  <span className="font-bold">{e.customer === shopId ? "Your shop" : e.customer ?? <em className="text-lg text-amber-ink not-italic">No name</em>}</span>
                </p>
                <p data-part="entry-amount" className={cx(figure, "text-4xl")}>
                  {Number.isInteger(e.amountKobo) ? formatKobo(e.amountKobo) : <em className="text-lg text-amber-ink not-italic">Amount missing</em>}
                </p>
                {itemText(e) && (
                  <p className="text-sm text-muted">
                    {itemText(e)}
                    {e.quantity > 1 && e.priceBasis === "total" && ` · price is for all ${e.quantity}`}
                    {e.quantity > 1 && e.priceBasis === "each" && " · price is for each one"}
                  </p>
                )}
                {words.destination && (
                  <p data-part="entry-destination" className="text-sm font-bold text-link">
                    {words.destination}
                  </p>
                )}
                {words.stock && <p className="text-sm text-muted">{words.stock}</p>}
                {words.notes.map((n) => (
                  <p key={n} className="text-sm font-semibold text-ink">
                    {n}
                  </p>
                ))}
              </div>
            </Card>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted">Nothing to save yet.</p>
      )}

      {t && (
        <dl className="grid grid-cols-3 gap-2">
          {[
            ["Total", t.totalKobo],
            ["Paid", t.paidKobo],
            ["Still owed", t.remainderKobo],
          ].map(([label, kobo]) => (
            <div key={label} className="min-w-0 rounded-2xl border border-line bg-card px-3 py-3 shadow-soft">
              <dt className="text-[0.8125rem] font-semibold text-muted">{label}</dt>
              {/* Sized to the box so ₦118,000 stays on one line at 360px; very
                  long amounts still wrap rather than spill out. */}
              <dd className="text-[clamp(0.8125rem,3.9vw,1rem)] font-extrabold tabular-nums [overflow-wrap:anywhere]">{formatKobo(kobo)}</dd>
            </div>
          ))}
        </dl>
      )}

      {p && (
        <Card className="flex items-center gap-3 px-4 py-3">
          <IconCircle icon={CalendarClock} tone="amber" size="sm" />
          <p>
            {p.customer} will pay {Number.isInteger(p.amountKobo) ? <strong>{formatKobo(p.amountKobo)}</strong> : "the balance"}{" "}
            by <strong>{formatDueDay(p.dueDate)}</strong>
          </p>
        </Card>
      )}

      {error && (
        <div role="alert" className="grid gap-2 rounded-2xl bg-slate px-4 py-3">
          <p>{error}</p>
          {/30 minutes|record it again/i.test(error) && (
            <Button variant="quiet" size="sm" onClick={onStartOver}>
              Record again
            </Button>
          )}
        </div>
      )}

      {fixing ? (
        <form className="grid gap-2.5" onSubmit={sendFix}>
          <label htmlFor="fix-text" className="font-bold">
            What should change?
          </label>
          <textarea
            id="fix-text"
            rows={3}
            autoFocus
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="e.g. Na 3 bags, not 2"
            disabled={!!busy}
            className={inputClass}
          />
          <div className="flex gap-2 *:flex-1">
            <Button type="button" variant="quiet" onClick={() => setFixing(false)} disabled={!!busy}>
              Cancel
            </Button>
            <Button disabled={!correction.trim() || !!busy}>{busy === "fix" ? "Sending…" : "Send fix"}</Button>
          </div>
        </form>
      ) : (
        <div className="mt-1 grid gap-2">
          <Button
            data-part="save"
            size="lg"
            className="text-lg"
            onClick={save}
            disabled={!canSave || !!busy}
            aria-describedby={canSave ? undefined : "save-why"}
          >
            <Check aria-hidden="true" strokeWidth={2.6} /> {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {!canSave && (
            <p id="save-why" className="text-center text-sm text-muted">
              {problems.length > 0 ? "Save is locked until the check above is answered." : "Nothing to save."}
            </p>
          )}
          <div className="flex gap-2 *:flex-1">
            <Button variant="amber" onClick={() => setFixing(true)} disabled={!!busy}>
              <Pencil aria-hidden="true" /> Fix
            </Button>
            <Button variant="quiet" onClick={reject} disabled={!!busy} aria-label="Reject, do not save">
              <X aria-hidden="true" /> {busy === "reject" ? "Rejecting…" : "Reject"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
