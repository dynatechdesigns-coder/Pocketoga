import { useState } from "react";
import { confirmProposal, fixProposal, friendlyError, rejectProposal } from "../api.js";
import { formatDueDay, formatKobo, itemText, typeLabel } from "../format.js";

// Server flags are written for developers ("entry 1: missing customer name").
// Make them read like plain words, and drop repeats.
function plainFlag(flag) {
  const s = flag
    .replace(/^needs clarification:\s*/i, "")
    .replace(/^entry (\d+):\s*/i, "Line $1: ")
    .replace(/^remainder:\s*/i, "Still owed: ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Shows what PocketOga heard and what it wants to save. Nothing is saved
// until the trader taps Save, and Save stays locked while anything needs
// checking.
export default function ConfirmCard({ proposal, shopId, onUpdate, onFinish, onStartOver }) {
  const [busy, setBusy] = useState(null); // "save" | "fix" | "reject" | null
  const [error, setError] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [correction, setCorrection] = useState("");

  const problems = [...new Set(proposal.flags.map(plainFlag))];
  if (problems.length === 0 && proposal.question) problems.push(proposal.question);
  const canSave = proposal.status === "pending" && problems.length === 0 && proposal.entries.length > 0;

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
    <section className="confirm" aria-busy={!!busy}>
      <header className="screen-header">
        <h1>Check before you save</h1>
      </header>

      {problems.length > 0 && (
        <div className="check-box" role="alert">
          <p className="check-title">Check this</p>
          <ul>
            {problems.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
          <p className="small">Tap Fix and tell PocketOga the right answer.</p>
        </div>
      )}

      <figure className="heard">
        <figcaption className="card-label">PocketOga heard</figcaption>
        <blockquote>“{proposal.heard}”</blockquote>
      </figure>

      {proposal.entries.length > 0 ? (
        <ul className="list" aria-label="Entries to save">
          {proposal.entries.map((e, i) => (
            <li key={i} className={`card entry kind-${e.type}`}>
              <div className="entry-top">
                <span className="card-label">{typeLabel(e.type)}</span>
                <span className="entry-who">
                  {e.customer === shopId ? "Your shop" : e.customer ?? <em className="missing">No name</em>}
                </span>
              </div>
              <p className="figure">
                {Number.isInteger(e.amountKobo) ? formatKobo(e.amountKobo) : <em className="missing">Amount missing</em>}
              </p>
              {itemText(e) && (
                <p className="muted">
                  {itemText(e)}
                  {e.quantity > 1 && e.priceBasis === "total" && ` · price is for all ${e.quantity}`}
                  {e.quantity > 1 && e.priceBasis === "each" && " · price is for each one"}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="state">Nothing to save yet.</p>
      )}

      {t && (
        <dl className="card facts facts-3">
          <div>
            <dt>Total</dt>
            <dd>{formatKobo(t.totalKobo)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{formatKobo(t.paidKobo)}</dd>
          </div>
          <div>
            <dt>Still owed</dt>
            <dd>{formatKobo(t.remainderKobo)}</dd>
          </div>
        </dl>
      )}

      {p && (
        <div className="card promise-line">
          <span className="card-label">Promise</span>
          <p>
            {p.customer} will pay {Number.isInteger(p.amountKobo) ? <strong>{formatKobo(p.amountKobo)}</strong> : "the balance"}{" "}
            by <strong>{formatDueDay(p.dueDate)}</strong>
          </p>
        </div>
      )}

      {error && (
        <div className="state state-error" role="alert">
          <p>{error}</p>
          {/30 minutes|record it again/i.test(error) && (
            <button className="btn btn-secondary" onClick={onStartOver}>
              Record again
            </button>
          )}
        </div>
      )}

      {fixing ? (
        <form className="card stack" onSubmit={sendFix}>
          <label htmlFor="fix-text">What should change?</label>
          <textarea
            id="fix-text"
            className="input"
            rows={3}
            autoFocus
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            placeholder="e.g. Na 3 bags, not 2"
            disabled={!!busy}
          />
          <div className="row">
            <button type="button" className="btn btn-quiet" onClick={() => setFixing(false)} disabled={!!busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!correction.trim() || !!busy}>
              {busy === "fix" ? "Sending…" : "Send fix"}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button
            className="btn btn-primary btn-lg"
            onClick={save}
            disabled={!canSave || !!busy}
            aria-describedby={canSave ? undefined : "save-why"}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </button>
          {!canSave && (
            <p id="save-why" className="save-why">
              {problems.length > 0 ? "Save is locked until the check above is answered." : "Nothing to save."}
            </p>
          )}
          <div className="row">
            <button className="btn btn-check" onClick={() => setFixing(true)} disabled={!!busy}>
              Fix
            </button>
            <button className="btn btn-quiet" onClick={reject} disabled={!!busy} aria-label="Reject, do not save">
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
