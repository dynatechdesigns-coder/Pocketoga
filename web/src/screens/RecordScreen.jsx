import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CloudOff, Keyboard, Mic, RotateCcw, ScanSearch, Send, Square, X } from "lucide-react";
import { getProposal, proposeAudio, proposeText } from "../api.js";
import { OFFLINE_MESSAGE, SAVED_MESSAGE, newMeta } from "../offlineQueue.js";
import { READY_EVENT, getShopQueue, popReady } from "../shopQueue.js";
import { MESSAGES, STAGES, VOICE_STAGES, VOICE_STAGE_DELAYS_MS, VOICE_TIMEOUT_MS, canRetry, isEmptyRecording, toWaitError, waitForProposal } from "../recordWait.js";
import { CANCELLED_MESSAGE, CANCELLED_MS, createRunTracker, micAction } from "../cancelRun.js";
import { TIME_UP_MESSAGE, VOICE_HINT, createRecordTimer } from "../recordLimits.js";
import { recordingToWavBase64 } from "../wav.js";
import { plural } from "../format.js";
import { Button, Card, Pill, ScreenHeader, Sheet, cx, rise } from "../ui.jsx";
import ConfirmCard, { inputClass } from "./ConfirmCard.jsx";
import RecordForm from "./RecordForm.jsx";

// What each hint says in the header chip.
const HINT_WORDS = { sale: "a sale", payment: "a payment", purchase: "stock you bought", expense: "an expense" };

// sessionStorage that shrugs when storage is blocked (private mode).
const session = {
  get: (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // the note just is not kept across a reload
    }
  },
  remove: (key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // nothing stored
    }
  },
};

// Record a voice note (or type one), send it to /propose, then check it in
// a bottom sheet. Closing the sheet keeps the note waiting; nothing saves
// without Save. `intent.text` pre-fills the typed note (e.g. "I restock ");
// `intent.hint` (sale, payment, purchase or expense) says what is being
// recorded and goes to the route with the note. `origin` ({ label }) is the
// screen the trader came from: Back returns there, and so does Save
// (`onSaved`). Nothing about the hint or the origin is required.
export default function RecordScreen({ shop, intent, origin, onBack, onSaved, onGo }) {
  const [proposal, setProposal] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [outcome, setOutcome] = useState(null); // { kind: "saved"|"rejected", count?, already? }
  const [busy, setBusy] = useState(null); // current stage text while waiting, or null
  const [error, setError] = useState(null); // { message, retry? }
  const retryRef = useRef(null);
  const [text, setText] = useState(intent?.text ?? "");
  const [hint, setHint] = useState(intent?.hint ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [held, setHeld] = useState(null); // audio kept when the 45 s limit stopped it
  const [cancelled, setCancelled] = useState(false); // the short "Cancelled" note
  const runs = useRef(null);
  if (!runs.current) runs.current = createRunTracker();
  const [queuedNote, setQueuedNote] = useState(null); // "Saved. It will send when you are back online."
  const proposalRef = useRef(null);
  const readyBusy = useRef(false);
  const cancelTimer = useRef(null);
  const recorderRef = useRef(null);
  const toggleRef = useRef(null);
  const textRef = useRef(null);

  // Remember the open note for this browser tab, so a reload does not lose it.
  const pendingKey = `pocketoga.pending.${shop.id}`;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  proposalRef.current = proposal;

  // Notes that were sent from the queue come back as ordinary proposals: the
  // oldest one opens here to be checked, and nothing is saved until Save.
  async function loadReady() {
    if (proposalRef.current || readyBusy.current) return;
    readyBusy.current = true;
    try {
      for (;;) {
        const id = popReady(shop.id, "record");
        if (id === null) return;
        try {
          const p = await getProposal(id);
          if (p.status === "pending") {
            showProposal(p);
            return;
          }
        } catch {
          // expired or gone: try the next one
        }
      }
    } finally {
      readyBusy.current = false;
    }
  }
  const loadReadyRef = useRef(loadReady);
  loadReadyRef.current = loadReady;
  useEffect(() => {
    const onReady = () => loadReadyRef.current();
    window.addEventListener(READY_EVENT, onReady);
    onReady();
    return () => window.removeEventListener(READY_EVENT, onReady);
  }, []);

  useEffect(() => {
    const id = session.get(pendingKey);
    if (!id) return;
    getProposal(id)
      .then((p) => (p.status === "pending" ? setProposal(p) : session.remove(pendingKey)))
      .catch(() => session.remove(pendingKey));
  }, [pendingKey]);

  // Pre-filled: put the cursor at the end, ready to finish the sentence.
  useEffect(() => {
    const box = textRef.current;
    if (!intent?.text || !box) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    box.scrollIntoView({ block: "center" });
  }, [intent]);

  // Stop the microphone if the trader leaves this screen mid-recording.
  useEffect(
    () => () => {
      recorderRef.current?.cleanup();
      runs.current.cancel();
      clearTimeout(cancelTimer.current);
    },
    []
  );

  // Cancelling never saves anything and never shows an error: it throws the
  // audio away, aborts a request in flight, and goes back to idle.
  function flashCancelled() {
    setCancelled(true);
    clearTimeout(cancelTimer.current);
    cancelTimer.current = setTimeout(() => setCancelled(false), CANCELLED_MS);
  }

  function cancelRecording() {
    const rec = recorderRef.current;
    if (!rec) return;
    rec.discarded = true;
    if (rec.state === "recording") rec.stop();
    else rec.cleanup();
    recorderRef.current = null;
    setRecording(false);
    setSeconds(0);
    setHeld(null);
    flashCancelled();
  }

  function cancelProcessing() {
    runs.current.cancel();
    setBusy(null);
    setError(null);
    flashCancelled();
  }



  // Back to idle from a result or an error, ready to record again.
  function recordAgain() {
    setError(null);
    setHeld(null);
    setSeconds(0);
    retryRef.current = null;
  }

  // The centre mic in the tab bar toggles recording while on this screen.
  toggleRef.current = () => {
    // While processing, a tap is Cancel and then a new recording at once.
    for (const step of micAction({ busy, recording, sheetOpen, canRecord })) {
      if (step === "cancel") cancelProcessing();
      else if (step === "start") startRecording();
      else stopRecording();
    }
  };
  useEffect(() => {
    const onMic = () => toggleRef.current();
    window.addEventListener("pocketoga:mic", onMic);
    return () => window.removeEventListener("pocketoga:mic", onMic);
  }, []);

  function showProposal(p) {
    session.set(pendingKey, p.id);
    setProposal(p);
    setOutcome(null);
    setSheetOpen(true);
  }

  function finish(result) {
    session.remove(pendingKey);
    setProposal(null);
    setHint(null);
    if (result.kind === "saved" && origin) {
      // Back to the screen the trader came from, which shows the new numbers.
      setSheetOpen(false);
      onSaved(result);
      return;
    }
    setOutcome(result);
    loadReadyRef.current();
  }

  function closeSheet() {
    setSheetOpen(false);
    if (outcome) setOutcome(null);
  }

  async function startRecording() {
    setError(null);
    setHeld(null);
    setCancelled(false);
    retryRef.current = null;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError({ message: MESSAGES.mic });
      return;
    }
    const chunks = [];
    const rec = new MediaRecorder(stream);
    const started = Date.now();
    let timeUp = false;
    const stopTimer = createRecordTimer({
      onTick: setSeconds,
      onLimit: () => {
        timeUp = true;
        stopRecording();
      },
    });
    rec.cleanup = () => {
      stopTimer();
      stream.getTracks().forEach((t) => t.stop());
    };
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      rec.cleanup();
      if (rec.discarded) return; // cancelled: nothing to send, nothing to say
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType });
      if (Date.now() - started < 1000 || isEmptyRecording(blob)) {
        setError({ message: MESSAGES.empty });
        return;
      }
      if (timeUp) {
        // Keep the audio; the trader decides whether to send it.
        setHeld(blob);
        return;
      }
      sendAudio(blob);
    };
    recorderRef.current = rec;
    setSeconds(0);
    setRecording(true);
    rec.start();
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
  }

  // One place that waits for a proposal: shows the stages, then either the
  // confirm card or a plain message (with Try again when a retry can help).
  // Nothing here saves anything; only Save on the card does.
  // `offline(failed)` keeps the note in the queue (see queueNote). When the
  // phone is offline, or the send fails with a network error, it is used
  // instead of showing an error.
  async function runProposal(call, { startAt = 0, onDone, wait, offline, run = runs.current.begin() } = {}) {
    setError(null);
    setSheetOpen(false);
    setCancelled(false);
    setQueuedNote(null);
    retryRef.current = () => runProposal(call, { startAt, onDone, wait, offline });
    if (offline && navigator.onLine === false) {
      runs.current.end(run);
      setBusy(null);
      await offline(false);
      return;
    }
    try {
      const p = await waitForProposal(call, { onStage: (t) => run.isCurrent() && setBusy(t), startAt, outer: run.signal, ...wait });
      if (!run.isCurrent()) return; // cancelled while waiting: a late answer is ignored
      onDone?.();
      showProposal(p);
    } catch (err) {
      if (!run.isCurrent()) return;
      const e = toWaitError(err);
      if (offline && e.kind === "network") {
        runs.current.end(run);
        setBusy(null);
        await offline(true);
        return;
      }
      setError({ message: e.message, retry: canRetry(e) });
    } finally {
      if (run.isCurrent()) {
        runs.current.end(run);
        setBusy(null);
      }
    }
  }

  async function sendAudio(blob) {
    setBusy(STAGES[0]); // "Listening…" at once, before anything else
    const run = runs.current.begin();
    let wav;
    try {
      wav = await recordingToWavBase64(blob);
    } catch {
      if (!run.isCurrent()) return;
      runs.current.end(run);
      setBusy(null);
      setError({ message: MESSAGES.unreadable });
      return;
    }
    if (!run.isCurrent()) return;
    const meta = newMeta();
    await runProposal((signal) => proposeAudio(wav, "wav", hint ?? undefined, signal, meta), {
      startAt: 0,
      run,
      offline: (failed) => queueNote("audio", { base64: wav }, meta, failed),
      wait: { stages: VOICE_STAGES, delays: VOICE_STAGE_DELAYS_MS, timeoutMs: VOICE_TIMEOUT_MS },
    });
  }

  function sendText(e) {
    e.preventDefault();
    const note = text.trim();
    if (!note) return;
    const meta = newMeta();
    runProposal((signal) => proposeText(note, hint ?? undefined, signal, meta), {
      startAt: 1,
      onDone: () => setText(""),
      offline: async (failed) => {
        if (await queueNote("text", { text: note }, meta, failed)) setText("");
      },
    });
  }

  // Keep a note that could not be sent on this phone. Without IndexedDB the
  // trader is told plainly that they are offline. True when it was kept.
  async function queueNote(kind, payload, meta, failed) {
    const queue = await getShopQueue(shop.id).catch(() => null);
    if (!queue) {
      setError({ message: OFFLINE_MESSAGE });
      return false;
    }
    await queue.enqueue(kind, payload, { hint: hint ?? null, requestId: meta.requestId, spokenAt: meta.spokenAt, failed });
    setQueuedNote(SAVED_MESSAGE);
    return true;
  }

  // The trader corrected the heard text: read it again from that text. No audio
  // goes up again, and the old note is simply left unsaved.
  function rerunFromText(corrected) {
    const note = corrected.trim();
    if (!note) return;
    runProposal((signal) => proposeText(note, proposal?.hint ?? hint ?? undefined, signal), { startAt: 1 });
  }

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <section>
      {origin && (
        <button
          type="button"
          data-part="record-back"
          onClick={onBack}
          className="mb-1 inline-flex min-h-12 items-center gap-1.5 rounded-full pr-3 font-extrabold text-link [&_svg]:size-5"
        >
          <ArrowLeft aria-hidden="true" /> Back to {origin.label}
        </button>
      )}
      <ScreenHeader title="Record" sub="Talk am, check am, save am" />

      {hint && (
        <p data-part="hint-chip" className="mb-3 flex items-center justify-between gap-2 rounded-2xl border border-line bg-lavender px-4 py-1 text-link">
          <span className="py-2 font-bold">Recording {HINT_WORDS[hint]}</span>
          <button type="button" onClick={() => setHint(null)} className="min-h-12 rounded-full px-3 text-sm font-bold underline">
            Not this
          </button>
        </p>
      )}

      {proposal && !sheetOpen && (
        <Card
          as="button"
          onClick={() => setSheetOpen(true)}
          edge="border-accent"
          className="mb-4 flex w-full animate-rise items-center justify-between gap-4 border-[1.5px] text-left"
        >
          <span>
            <strong>A note is waiting for you</strong>
            <span className="block text-sm text-muted">Nothing is saved yet. Tap to check it.</span>
          </span>
          <Pill tone="blue">Open</Pill>
        </Card>
      )}

      {/* Same height idle, recording and busy, so nothing below jumps. */}
      <div {...rise(0, "grid min-h-[300px] content-center justify-items-center gap-4 py-4")}>
        {busy ? (
          <div data-part="waiting" className="grid w-full max-w-xs justify-items-center gap-4 font-bold" role="status">
            {/* A bar that only says "working": no percentage, ever. */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-lavender" aria-hidden="true">
              <div className="h-full w-2/5 rounded-full bg-accent motion-safe:animate-sweep" />
            </div>
            <p data-part="stage" className="text-lg">{busy}</p>
            <Button data-part="cancel-processing" variant="quiet" className="w-auto min-w-40" onClick={cancelProcessing}>
              <X aria-hidden="true" /> Cancel
            </Button>
          </div>
        ) : canRecord ? (
          <>
            <div className="relative">
            <button
              data-part="mic"
              data-recording={recording}
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? "Stop recording and send" : "Start recording a voice note"}
              aria-pressed={recording}
              className="relative grid size-[152px] place-items-center rounded-full bg-hero text-white shadow-lift transition-transform duration-150 active:scale-96"
            >
              {/* Soft pulse rings, only while recording. */}
              <span data-part="mic-ring" aria-hidden="true" className={cx("absolute inset-0 rounded-full bg-accent opacity-0", recording && "animate-ring")} />
              <span aria-hidden="true" className={cx("absolute inset-0 rounded-full bg-accent opacity-0", recording && "animate-ring [animation-delay:0.9s]")} />
              {recording ? <Square aria-hidden="true" fill="currentColor" className="relative size-10" /> : <Mic aria-hidden="true" strokeWidth={2} className="relative size-14" />}
            </button>
            {recording && (
              <button
                type="button"
                data-part="cancel-recording"
                onClick={cancelRecording}
                aria-label="Cancel recording and throw the audio away"
                className="absolute top-1/2 -right-[68px] grid size-12 -translate-y-1/2 place-items-center rounded-full border-[1.5px] border-line bg-card text-ink shadow-soft transition-transform duration-150 active:scale-96 [&_svg]:size-6"
              >
                <X aria-hidden="true" strokeWidth={2.4} />
              </button>
            )}
            </div>
            <p className="inline-flex items-center gap-2 text-lg font-bold tabular-nums" aria-live="polite">
              {recording ? (
                <>
                  <span className="size-2.5 animate-pulse-soft rounded-full bg-coral" aria-hidden="true" /> Recording {mmss} · tap to stop
                </>
              ) : (
                "Tap and talk"
              )}
            </p>
            <p data-part="voice-hint" className="text-center text-sm font-semibold text-muted">{VOICE_HINT}</p>
            <p className="text-center text-sm text-muted">“Mama Bisi buy 2 bags of rice, 15k. She pay 10k, remain 5k.”</p>
            <TypeInstead onOpen={() => setFormOpen(true)} />
          </>
        ) : (
          <>
            <p className="text-center text-muted">Voice recording is not available in this browser here. Type your note below.</p>
            <TypeInstead onOpen={() => setFormOpen(true)} />
          </>
        )}
      </div>

      {queuedNote && (
        <p data-part="queued-note" role="status" className="mb-4 flex items-start gap-2 rounded-2xl border border-line bg-slate px-4 py-3 font-bold">
          <CloudOff aria-hidden="true" className="mt-0.5 size-5 shrink-0" /> {queuedNote}
        </p>
      )}

      {cancelled && (
        <p data-part="cancelled" role="status" className="mb-4 rounded-2xl bg-slate px-4 py-3 text-center font-bold">
          {CANCELLED_MESSAGE}
        </p>
      )}

      {held && !busy && (
        <Card data-part="time-up" role="status" className="mb-4 grid gap-3">
          <p className="font-bold">{TIME_UP_MESSAGE}</p>
          <Button
            data-part="send-held"
            onClick={() => {
              const blob = held;
              setHeld(null);
              sendAudio(blob);
            }}
          >
            <Send aria-hidden="true" /> Send it
          </Button>
          <Button variant="quiet" onClick={startRecording}>
            <Mic aria-hidden="true" /> Record again
          </Button>
        </Card>
      )}

      {error && (
        <Card data-part="record-error" className="mb-4 grid gap-3" role="alert">
          <p>{error.message}</p>
          {error.retry && retryRef.current && (
            <Button data-part="retry" variant="secondary" onClick={() => retryRef.current()}>
              Try again
            </Button>
          )}
          <Button data-part="record-again" variant="quiet" onClick={recordAgain}>
            <RotateCcw aria-hidden="true" /> Record again
          </Button>
        </Card>
      )}

      <Card as="form" onSubmit={sendText} {...rise(1, "grid gap-3")}>
        <label htmlFor="note-text" className="font-bold">
          Or type it
        </label>
        <textarea
          id="note-text"
          ref={textRef}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Chinedu buy 3 cartons Indomie, 27k, he don pay"
          disabled={!!busy || recording}
          className={inputClass}
        />
        <Button calm disabled={!text.trim() || !!busy || recording}>
          <Send aria-hidden="true" /> Send
        </Button>
      </Card>

      <Button data-part="check-alert" variant="quiet" className="mt-4" onClick={() => onGo("alert")}>
        <ScanSearch aria-hidden="true" /> Check alert
      </Button>

      <RecordForm
        key={hint ?? "none"}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        startType={hint ?? "sale"}
        onProposal={(p) => {
          setFormOpen(false);
          showProposal(p);
        }}
      />

      <Sheet open={sheetOpen} onClose={closeSheet} title={outcome ? (outcome.kind === "saved" ? "Saved" : "Not saved") : "Check before you save"}>
        {outcome ? (
          <Outcome outcome={outcome} onAgain={closeSheet} onLedger={() => onGo("ledger")} />
        ) : proposal ? (
          <ConfirmCard proposal={proposal} shopId={shop.id} onRerun={rerunFromText} onUpdate={showProposal} onFinish={finish} onStartOver={() => finish({ kind: "rejected" })} />
        ) : null}
      </Sheet>
    </section>
  );
}

// A small, optional link: the short typed form instead of talking.
function TypeInstead({ onOpen }) {
  return (
    <button
      type="button"
      data-part="type-instead"
      onClick={onOpen}
      className="inline-flex min-h-12 items-center gap-1.5 rounded-full px-4 text-[0.9375rem] font-bold text-link underline [&_svg]:size-4"
    >
      <Keyboard aria-hidden="true" /> Type it instead
    </button>
  );
}

// Fills the (never-shrinking) sheet and sits in its middle.
function Outcome({ outcome, onAgain, onLedger }) {
  const saved = outcome.kind === "saved";
  return (
    <div className="grid flex-1 content-center justify-items-center gap-4 py-2 text-center" aria-live="polite">
      <span
        aria-hidden="true"
        className={cx("grid size-[72px] animate-rise place-items-center rounded-full [&_svg]:size-9", saved ? "bg-hero text-white" : "bg-slate text-muted")}
      >
        {saved ? <Check strokeWidth={3} /> : <X strokeWidth={3} />}
      </span>
      <p className="text-lg font-semibold">
        {!saved
          ? "Nothing was written to your ledger."
          : outcome.already
            ? "This note was already saved. Nothing was added twice."
            : `${plural(outcome.count, "entry", "entries")} added to your ledger.`}
      </p>
      <Button size="lg" onClick={onAgain}>
        Record again
      </Button>
      {saved && (
        <Button variant="quiet" onClick={onLedger}>
          See ledger
        </Button>
      )}
    </div>
  );
}
