import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Keyboard, Mic, Send, Square, X } from "lucide-react";
import { ApiError, friendlyError, getProposal, proposeAudio, proposeText } from "../api.js";
import { recordingToWavBase64 } from "../wav.js";
import { plural } from "../format.js";
import { Button, Card, Pill, ScreenHeader, Sheet, cx, rise } from "../ui.jsx";
import ConfirmCard, { inputClass } from "./ConfirmCard.jsx";
import RecordForm from "./RecordForm.jsx";

// What each hint says in the header chip.
const HINT_WORDS = { sale: "a sale", payment: "a payment", purchase: "stock you bought", expense: "an expense" };

const MAX_SECONDS = 120; // keeps the upload well under the server's 12 MB limit

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
  const [busy, setBusy] = useState(null); // loading message, or null
  const [error, setError] = useState(null);
  const [text, setText] = useState(intent?.text ?? "");
  const [hint, setHint] = useState(intent?.hint ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);
  const toggleRef = useRef(null);
  const textRef = useRef(null);

  // Remember the open note for this browser tab, so a reload does not lose it.
  const pendingKey = `pocketoga.pending.${shop.id}`;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

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
  useEffect(() => () => recorderRef.current?.cleanup(), []);

  // The centre mic in the tab bar toggles recording while on this screen.
  toggleRef.current = () => {
    if (busy || sheetOpen || !canRecord) return;
    recording ? stopRecording() : startRecording();
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
  }

  function closeSheet() {
    setSheetOpen(false);
    if (outcome) setOutcome(null);
  }

  async function startRecording() {
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("PocketOga needs your microphone. Allow it in your browser settings, or type the note below.");
      return;
    }
    const chunks = [];
    const rec = new MediaRecorder(stream);
    const started = Date.now();
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stopRecording();
    }, 250);
    rec.cleanup = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
    };
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      rec.cleanup();
      setRecording(false);
      if (Date.now() - started < 1000) {
        setError("That was too short. Tap the mic, talk, then tap again to stop.");
        return;
      }
      sendAudio(new Blob(chunks, { type: rec.mimeType }));
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

  async function sendAudio(blob) {
    setBusy("Getting your note ready…");
    try {
      const wav = await recordingToWavBase64(blob);
      setBusy("PocketOga is listening…");
      showProposal(await proposeAudio(wav, "wav", hint ?? undefined));
    } catch (err) {
      setError(err instanceof ApiError ? friendlyError(err) : "Could not read that recording. Try again, or type it.");
    } finally {
      setBusy(null);
    }
  }

  async function sendText(e) {
    e.preventDefault();
    if (!text.trim()) return;
    setError(null);
    setBusy("PocketOga is reading…");
    try {
      showProposal(await proposeText(text.trim(), hint ?? undefined));
      setText("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
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
          <div className="grid justify-items-center gap-4 font-bold" role="status">
            <div className="size-11 animate-spin rounded-full border-4 border-lavender border-t-accent" aria-hidden="true" />
            <p>{busy}</p>
          </div>
        ) : canRecord ? (
          <>
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
            <p className="inline-flex items-center gap-2 text-lg font-bold tabular-nums" aria-live="polite">
              {recording ? (
                <>
                  <span className="size-2.5 animate-pulse-soft rounded-full bg-coral" aria-hidden="true" /> Recording {mmss} · tap to stop
                </>
              ) : (
                "Tap and talk"
              )}
            </p>
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

      {error && (
        <Card className="mb-4" role="alert">
          <p>{error}</p>
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
          <ConfirmCard proposal={proposal} shopId={shop.id} onUpdate={showProposal} onFinish={finish} onStartOver={() => finish({ kind: "rejected" })} />
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
        Record another
      </Button>
      {saved && (
        <Button variant="quiet" onClick={onLedger}>
          See ledger
        </Button>
      )}
    </div>
  );
}
