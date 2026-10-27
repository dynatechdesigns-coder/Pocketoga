import { useState } from "react";
import { confirmProposal, fixProposal, friendlyError, rejectProposal } from "../api.js";
import { mirrorConfirmed } from "../localLedger.js";
import { formatKobo, typeLabel } from "../money.js";

// Server flags are written for developers ("entry 1: missing customer name").
// Make them read like plain words.
function plainFlag(flag) {
  const s = flag
    .replace(/^needs clarification:\s*/i, "")
    .replace(/^entry (\d+):\s*/i, "Line $1: ")
    .replace(/^(total|paid|remainder):\s*/i, (_, w) => `${w === "remainder" ? "Still owed" : w}: `);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Shows what PocketOga heard and what it wants to save. Nothing is saved
// until the trader taps Save.
export default function ConfirmCard({ proposal, shopId, onUpdate, onFinish, onStartOver }) {
  const [busy, setBusy] = useState(null); // "save" | "fix" | "reject" | null
  const [error, setError] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [correction, setCorrection] = useState("");

  const problems = proposal.flags.map(plainFlag);
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
      if (!res.alreadyConfirmed) mirrorConfirmed(shopId, res.proposal, res.recordedIds);
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

  return (
    <section className="confirm" aria-busy={!!busy}>
      <h2 className="screen-title">Check am before you save</h2>

      <div className="heard">
        <div className="label">PocketOga heard</div>
        <blockquote>“{proposal.heard}”</blockquote>
      </div>

      {proposal.entries.length > 0 ? (
        <ul className="entries">
          {proposal.entries.map((e, i) => (
            <li key={i} className={`entry entry-${e.type}`}>
              <div className="entry-top">
                <span className="entry-type">{typeLabel(e.type)}</span>
                <span className="entry-who">
                  {e.customer === shopId ? "Your shop" : e.customer ?? <em className="missing">No name</em>}
                </span>
              </div>
              <div className="amount">
                {e.amountKobo === null ? <em className="missing">Amount missing</em> : formatKobo(e.amountKobo)}
              </div>
              {(e.item || e.quantity) && (
                <div className="entry-item">
                  {e.quantity ? `${e.quantity} × ` : ""}
                  {e.item ?? "item not named"}
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="notice">No entries yet.</p>
      )}

      {t && (
        <dl className="totals">
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

      {problems.length > 0 && (
        <div className="alert alert-warn" role="status">
          <strong>Please check:</strong>
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <p className="small">Tap Fix and tell PocketOga the right answer.</p>
        </div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          {/expired|too old|record it again/i.test(error) && (
            <button className="btn-link" onClick={onStartOver}>
              Record again
            </button>
          )}
        </div>
      )}

      {fixing ? (
        <form className="fix-box" onSubmit={sendFix}>
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
            <button type="button" className="btn btn-ghost" onClick={() => setFixing(false)} disabled={!!busy}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!correction.trim() || !!busy}>
              {busy === "fix" ? "Sending…" : "Send fix"}
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <button className="btn btn-save" onClick={save} disabled={!canSave || !!busy}>
            {busy === "save" ? "Saving…" : "✓ Save"}
          </button>
          <div className="row">
            <button className="btn btn-fix" onClick={() => setFixing(true)} disabled={!!busy}>
              ✎ Fix
            </button>
            <button className="btn btn-reject" onClick={reject} disabled={!!busy}>
              {busy === "reject" ? "…" : "✕ Reject"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
