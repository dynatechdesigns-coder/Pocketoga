import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, CheckCircle2, CloudOff, ImageOff, ImagePlus, ShieldAlert, X } from "lucide-react";
import { getProposal, getUnconfirmed, proposePhoto, rejectProposal } from "../api.js";
import { FILE_MESSAGES, ALERT_STAGES, ALERT_STAGE_DELAYS_MS, ALERT_TIMEOUT_MS, FIXED_LINE, checkAgeDays, describeCheck, markSeenSafely, prepareAlertPhoto, saveAlert } from "../alertCheck.js";
import { OFFLINE_MESSAGE, SAVED_MESSAGE, newMeta } from "../offlineQueue.js";
import { canRetry, toWaitError, waitForProposal } from "../recordWait.js";
import { READY_EVENT, getShopQueue, popReady } from "../shopQueue.js";
import { ageText, formatKobo } from "../format.js";
import AiDetails from "../AiDetails.jsx";
import LimitNotice from "../LimitNotice.jsx";
import { Button, Card, ErrorState, IconCircle, Pill, ScreenHeader, SectionTitle, Skeleton, cx, rise, useLoad } from "../ui.jsx";

// Check a payment alert before handing over goods: pick or take a photo, wait
// calmly, then a card of warning signs. The photo is shrunk in the browser,
// sent once, and dropped: only the small thumbnail during the check is kept,
// and it is released the moment the result shows.
// Two equal buttons: same height, rounded rectangles, icon above a one-line label.
const PHOTO_BUTTON = "min-h-24 min-w-0 flex-col gap-2 rounded-2xl! px-2 py-3 text-center text-base whitespace-nowrap [&_svg]:size-7";

export default function AlertCheckScreen({ shop }) {
  const [phase, setPhase] = useState("idle"); // idle | waiting | result | done
  const [stage, setStage] = useState("");
  const [thumb, setThumb] = useState(null);
  const [problem, setProblem] = useState(null); // { message, retry? }
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(null); // "seen" | "save" | "reject" while an action runs
  const [done, setDone] = useState(null); // { kind, message }
  const photoRef = useRef(null); // prepared photo, kept only for Try again
  const abortRef = useRef(null);
  const fileRef = useRef(null); // the camera input
  const galleryRef = useRef(null);
  const headingRef = useRef(null);
  const list = useLoad(getUnconfirmed);
  const [queuedNote, setQueuedNote] = useState(null);
  const metaRef = useRef(null); // request id and time of the photo being checked
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // A photo sent from the queue comes back as an ordinary result card.
  useEffect(() => {
    let busy = false;
    async function loadReady() {
      if (busy || phaseRef.current === "waiting" || phaseRef.current === "result") return;
      busy = true;
      try {
        for (;;) {
          const id = popReady(shop.id, "alert");
          if (id === null) return;
          try {
            const p = await getProposal(id);
            if (p.status === "pending") {
              setProposal(p);
              setQueuedNote(null);
              setPhase("result");
              return;
            }
          } catch {
            // expired or gone: try the next one
          }
        }
      } finally {
        busy = false;
      }
    }
    window.addEventListener(READY_EVENT, loadReady);
    loadReady();
    return () => window.removeEventListener(READY_EVENT, loadReady);
  }, [shop.id]);

  useEffect(() => () => abortRef.current?.abort(), []);
  // After the photo is gone, move focus to the result for screen readers.
  useEffect(() => {
    if (phase === "result" || phase === "done") headingRef.current?.focus();
  }, [phase]);

  function dropPhoto() {
    if (photoRef.current?.thumbUrl) URL.revokeObjectURL(photoRef.current.thumbUrl);
    photoRef.current = null;
    setThumb(null);
  }

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // picking the same photo again must still fire
    if (!file) return;
    setProblem(null);
    setDone(null);
    setProposal(null);
    dropPhoto();
    let photo;
    try {
      photo = await prepareAlertPhoto(file);
    } catch (err) {
      setProblem({ message: err?.message === "type" ? FILE_MESSAGES.type : FILE_MESSAGES.read });
      return;
    }
    photoRef.current = photo;
    metaRef.current = newMeta();
    setThumb(photo.thumbUrl);
    run();
  }

  async function run() {
    const photo = photoRef.current;
    if (!photo) return;
    setProblem(null);
    setQueuedNote(null);
    if (navigator.onLine === false) return queuePhoto(false);
    setPhase("waiting");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const p = await waitForProposal((signal) => proposePhoto(photo.base64, photo.format, signal, metaRef.current), {
        onStage: setStage,
        stages: ALERT_STAGES,
        delays: ALERT_STAGE_DELAYS_MS,
        timeoutMs: ALERT_TIMEOUT_MS,
        outer: controller.signal,
      });
      if (controller.signal.aborted) return;
      dropPhoto();
      setProposal(p);
      setPhase("result");
    } catch (err) {
      if (controller.signal.aborted) return;
      const e = toWaitError(err);
      if (e.kind === "network") return queuePhoto(true);
      setProblem({ message: e.message, retry: canRetry(e), limit: e.kind === "limit" });
      setPhase("idle");
    }
  }

  // No connection: keep the photo on this phone (it is dropped from the
  // screen at once) and send it when the phone is back online.
  async function queuePhoto(failed) {
    const photo = photoRef.current;
    const queue = await getShopQueue(shop.id).catch(() => null);
    dropPhoto();
    setPhase("idle");
    if (!queue) {
      setProblem({ message: OFFLINE_MESSAGE });
      return;
    }
    await queue.enqueue("photo", { base64: photo.base64, format: photo.format }, { ...metaRef.current, failed });
    setQueuedNote(SAVED_MESSAGE);
  }

  function cancel() {
    abortRef.current?.abort();
    dropPhoto();
    setPhase("idle");
  }

  function again() {
    dropPhoto();
    setProposal(null);
    setDone(null);
    setProblem(null);
    setPhase("idle");
    fileRef.current?.click();
  }

  async function save(markSeen) {
    setBusy(markSeen ? "seen" : "save");
    setProblem(null);
    try {
      const res = await saveAlert(proposal, { markSeen });
      setDone({
        kind: res.seen ? "seen" : "saved",
        checkId: res.checkId,
        error: res.seenMessage ? `Saved as unconfirmed, but it was not marked as seen. ${res.seenMessage}` : null,
        message: res.seen
          ? "This transfer is confirmed in your bank."
          : res.already
            ? "Already saved. Nothing was added twice."
            : "Saved as unconfirmed. Mark it when you see it in your bank.",
      });
      setProposal(null);
      setPhase("done");
    } catch (err) {
      const e = toWaitError(err);
      setProblem({ message: e.message, limit: e.kind === "limit" });
    } finally {
      setBusy(null);
    }
  }

  // From the Saved card: the bank tap for the check just saved, or Try again.
  async function markDone() {
    setBusy("seen");
    const out = await markSeenSafely(done.checkId);
    setBusy(null);
    setDone(out.seen ? { kind: "seen", message: "This transfer is confirmed in your bank." } : { ...done, error: out.seenMessage });
    list.reload();
  }

  async function reject() {
    setBusy("reject");
    try {
      await rejectProposal(proposal.id);
    } catch {
      // an old or already-closed check: nothing was saved either way
    }
    setBusy(null);
    setProposal(null);
    setDone({ kind: "rejected", message: "Rejected. Nothing was saved." });
    setPhase("done");
    list.reload();
  }

  const card = proposal ? describeCheck(proposal) : null;

  return (
    <section>
      <ScreenHeader title="Check alert" sub="Before you hand over goods" />

      {/* Two ways in, one flow: both inputs call onPick, which checks type and size. */}
      <input ref={fileRef} data-part="photo-camera" type="file" accept="image/*" capture="environment" onChange={onPick} className="sr-only" tabIndex={-1} aria-hidden="true" />
      <input ref={galleryRef} data-part="photo-gallery" type="file" accept="image/*" onChange={onPick} className="sr-only" tabIndex={-1} aria-hidden="true" />

      {phase === "waiting" && (
        <Card data-part="alert-waiting" className="mb-4 grid justify-items-center gap-4 py-6 text-center" role="status">
          {thumb && <img src={thumb} alt="" className="size-16 rounded-xl border border-line object-cover" />}
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-lavender" aria-hidden="true">
            <div className="h-full w-2/5 rounded-full bg-accent motion-safe:animate-sweep" />
          </div>
          <p data-part="stage" className="text-lg font-bold">{stage}</p>
          <Button variant="quiet" className="w-auto min-w-40" onClick={cancel}>
            <X aria-hidden="true" /> Cancel
          </Button>
        </Card>
      )}

      {phase === "idle" && (
        <Card {...rise(0, "mb-4 grid gap-3")}>
          <div data-part="photo-buttons" className="grid min-w-0 grid-cols-1 gap-3 min-[340px]:grid-cols-2">
            <Button size="lg" data-part="take-photo" className={PHOTO_BUTTON} onClick={() => fileRef.current?.click()}>
              <Camera aria-hidden="true" /> <span>Take a photo</span>
            </Button>
            <Button size="lg" data-part="pick-photo" className={PHOTO_BUTTON} onClick={() => galleryRef.current?.click()}>
              <ImagePlus aria-hidden="true" />
              {/* One line, always: the short word fits two columns on 340 to 399px phones. */}
              <span className="min-[340px]:max-[399px]:hidden">Choose from gallery</span>
              <span className="hidden min-[340px]:max-[399px]:inline">Gallery</span>
            </Button>
          </div>
          <p className="text-center text-sm text-muted">A bank SMS or a transfer screenshot. JPEG, PNG or WebP. The photo is not kept.</p>
        </Card>
      )}

      {queuedNote && (
        <p data-part="queued-note" role="status" className="mb-4 flex items-start gap-2 rounded-2xl border border-line bg-slate px-4 py-3 font-bold">
          <CloudOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" /> {queuedNote}
        </p>
      )}

      {problem?.limit && <LimitNotice message={problem.message} onOk={() => setProblem(null)} className="mb-4" />}

      {problem && !problem.limit && (
        <Card data-part="alert-problem" edge="border-coral" className="mb-4 grid gap-3" role="alert">
          <p className="flex items-start gap-2 font-semibold">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-coral-ink" /> {problem.message}
          </p>
          {problem.retry && photoRef.current && (
            <Button data-part="retry" variant="secondary" onClick={run}>
              Try again
            </Button>
          )}
        </Card>
      )}

      {card && phase === "result" && (
        <>
          <ResultCard card={card} busy={busy} headingRef={headingRef} onSeen={() => save(true)} onSave={() => save(false)} onReject={reject} onAgain={again} />
          <AiDetails proposal={proposal} photo className="mb-4" />
        </>
      )}

      {phase === "done" && done && (
        <Card data-part="alert-done" data-kind={done.kind} edge={done.kind === "seen" ? "border-teal" : "border-line"} role="status" className="mb-4 grid gap-3">
          <p ref={headingRef} tabIndex={-1} className="flex items-center gap-2 text-lg font-extrabold outline-none">
            <IconCircle icon={done.kind === "seen" ? CheckCircle2 : done.kind === "rejected" ? X : ShieldAlert} tone={done.kind === "seen" ? "teal" : "slate"} size="sm" />
            {done.kind === "seen" ? "Confirmed in your bank" : done.kind === "rejected" ? "Rejected" : "Saved, not confirmed"}
          </p>
          <p>{done.message}</p>
          {done.error && (
            <p data-part="mark-error" role="alert" className="flex items-start gap-2 font-semibold text-coral-ink">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" /> {done.error}
            </p>
          )}
          {done.kind === "saved" && done.checkId != null && (
            <Button data-part="mark-seen" disabled={busy === "seen"} onClick={markDone}>
              <CheckCircle2 aria-hidden="true" /> {busy === "seen" ? "Saving…" : done.error ? "Try again" : "I saw it in my bank"}
            </Button>
          )}
          <Button variant="secondary" onClick={again}>
            <Camera aria-hidden="true" /> Check another alert
          </Button>
        </Card>
      )}

      <SectionTitle className="mt-6">Unconfirmed transfers</SectionTitle>
      <Unconfirmed list={list} />
    </section>
  );
}

const TONE = {
  clean: { edge: "border-line", icon: ShieldAlert, circle: "slate", pill: "slate", word: "No warning signs" },
  warned: { edge: "border-amber", icon: AlertTriangle, circle: "amber", pill: "amber", word: "Warning signs" },
  unreadable: { edge: "border-line", icon: ImageOff, circle: "slate", pill: "slate", word: "Not read" },
  notAlert: { edge: "border-coral", icon: ImageOff, circle: "coral", pill: "coral", word: "Not an alert" },
};

function ResultCard({ card, busy, headingRef, onSeen, onSave, onReject, onAgain }) {
  const tone = TONE[card.kind];
  const serious = card.warnings.some((w) => w.severity === "serious");
  const Icon = tone.icon;
  return (
    <Card data-part="alert-result" data-kind={card.kind} edge={serious ? "border-coral" : tone.edge} className="mb-4 grid gap-4" role="region" aria-label="Alert check result">
      <div className="flex items-start gap-3">
        <IconCircle icon={Icon} tone={serious ? "coral" : tone.circle} />
        <div className="grid min-w-0 gap-1">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-extrabold leading-tight outline-none">
            {card.title}
          </h2>
          {card.detail && <p className="text-muted">{card.detail}</p>}
        </div>
      </div>

      {card.rows.length > 0 && (
        <dl data-part="alert-fields" className="grid gap-2">
          {card.rows.map((r) => (
            <div key={r.key} className="flex flex-wrap items-baseline justify-between gap-x-4 border-b border-line pb-2 last:border-b-0 last:pb-0">
              <dt className="text-sm font-semibold text-muted">{r.label}</dt>
              <dd className={cx("min-w-0 font-bold [overflow-wrap:anywhere]", r.value === "Not shown" && "font-medium text-muted")}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {card.warnings.length > 0 && (
        <ul data-part="alert-warnings" className="grid gap-2">
          {card.warnings.map((w) => (
            <li
              key={w.text}
              data-severity={w.severity}
              className={cx("flex items-start gap-2.5 rounded-2xl border px-3.5 py-2.5", w.severity === "serious" ? "border-coral bg-coral-soft text-coral-ink" : "border-amber bg-amber-soft text-amber-ink")}
            >
              {w.severity === "serious" ? <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />}
              <span>
                <strong>{w.severity === "serious" ? "Serious: " : "Be careful: "}</strong>
                {w.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p data-part="alert-fixed" className="rounded-2xl bg-slate px-3.5 py-2.5 text-sm font-semibold">
        {FIXED_LINE}
      </p>

      {card.canSave ? (
        <div className="grid gap-2">
          <Button data-part="seen" size="lg" disabled={!!busy} onClick={onSeen}>
            <CheckCircle2 aria-hidden="true" /> {busy === "seen" ? "Saving…" : "I saw it in my bank"}
          </Button>
          <Button data-part="save" variant="secondary" disabled={!!busy} onClick={onSave}>
            {busy === "save" ? "Saving…" : "Save as unconfirmed"}
          </Button>
          <Button data-part="reject" variant="quiet" disabled={!!busy} onClick={onReject}>
            <X aria-hidden="true" /> Reject
          </Button>
        </div>
      ) : (
        <Button data-part="again" size="lg" onClick={onAgain}>
          <Camera aria-hidden="true" /> Take another photo
        </Button>
      )}
    </Card>
  );
}

function Unconfirmed({ list }) {
  const [rowErr, setRowErr] = useState({}); // per-row failure of the bank tap
  const [rowBusy, setRowBusy] = useState(null);
  if (list.loading && !list.data) return <Skeleton blocks={[72, 72]} label="Loading unconfirmed transfers" />;
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  const items = list.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Card className="text-muted">
        <p>No unconfirmed transfers. Alerts you save without seeing them in your bank wait here.</p>
      </Card>
    );
  }
  async function seen(item) {
    setRowBusy(item.id);
    const out = await markSeenSafely(item.id);
    setRowBusy(null);
    setRowErr((m) => ({ ...m, [item.id]: out.seen ? null : out.seenMessage }));
    list.reload();
  }
  return (
    <ul data-part="unconfirmed" className="grid gap-3">
      {items.map((item) => {
        const key = item.id;
        return (
          <li key={key}>
            <Card className="grid gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0">
                  <span className="font-extrabold tabular-nums">{formatKobo(item.amountKobo)}</span>
                  <span className="min-w-0 text-sm text-muted [overflow-wrap:anywhere]">
                    {item.customer ?? "Sender not shown"} · {ageText(checkAgeDays(item.createdAt))}
                  </span>
                </div>
                {item.warned && (
                  <Pill tone="amber">
                    <AlertTriangle aria-hidden="true" className="mr-1 size-3.5" /> Had warning signs
                  </Pill>
                )}
              </div>
              <Button variant="secondary" size="sm" disabled={rowBusy === item.id} onClick={() => seen(item)} aria-label={`I saw it in my bank: ${formatKobo(item.amountKobo)} from ${item.customer ?? "unknown sender"}`}>
                <CheckCircle2 aria-hidden="true" /> {rowBusy === item.id ? "Saving…" : rowErr[item.id] ? "Try again" : "I saw it in my bank"}
              </Button>
              {rowErr[item.id] && (
                <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-coral-ink">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> {rowErr[item.id]}
                </p>
              )}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
