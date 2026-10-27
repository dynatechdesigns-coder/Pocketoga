import { useEffect, useRef, useState } from "react";
import { ApiError, friendlyError, getProposal, proposeAudio, proposeText } from "../api.js";
import { recordingToWavBase64 } from "../wav.js";
import ConfirmCard from "./ConfirmCard.jsx";

const MAX_SECONDS = 120; // keeps the upload well under the server's 12 MB limit

// Record a voice note (or type one), send it to /propose, then show the
// confirm card. After Save or Reject, shows the outcome.
export default function RecordScreen({ shop, onSeeLedger }) {
  const [proposal, setProposal] = useState(null);
  const [outcome, setOutcome] = useState(null); // { kind: "saved"|"rejected", count? }
  const [busy, setBusy] = useState(null); // loading message, or null
  const [error, setError] = useState(null);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);

  // Remember the open note for this browser tab, so a reload does not lose it.
  const pendingKey = `pocketoga.pending.${shop.id}`;
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  useEffect(() => {
    const id = sessionStorage.getItem(pendingKey);
    if (!id) return;
    getProposal(id)
      .then((p) => (p.status === "pending" ? setProposal(p) : sessionStorage.removeItem(pendingKey)))
      .catch(() => sessionStorage.removeItem(pendingKey));
  }, [pendingKey]);

  // Stop the microphone if the trader leaves this screen mid-recording.
  useEffect(() => () => recorderRef.current?.cleanup(), []);

  function showProposal(p) {
    sessionStorage.setItem(pendingKey, p.id);
    setProposal(p);
  }

  function finish(result) {
    sessionStorage.removeItem(pendingKey);
    setProposal(null);
    setOutcome(result);
  }

  function startOver() {
    sessionStorage.removeItem(pendingKey);
    setProposal(null);
    setOutcome(null);
    setError(null);
    setText("");
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
        setError("That was too short. Hold on and talk, then tap Stop.");
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
      showProposal(await proposeAudio(wav, "wav"));
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
      showProposal(await proposeText(text.trim()));
      setText("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  }

  // --- What to show ---

  if (outcome) {
    return (
      <section className="outcome">
        {outcome.kind === "saved" ? (
          <>
            <div className="outcome-icon ok" aria-hidden="true">✓</div>
            <h2>Saved</h2>
            <p>
              {outcome.already
                ? "This note was already saved before. Nothing was added twice."
                : `${outcome.count} ${outcome.count === 1 ? "entry" : "entries"} added to your ledger.`}
            </p>
            <button className="btn btn-secondary" onClick={onSeeLedger}>
              See ledger
            </button>
          </>
        ) : (
          <>
            <div className="outcome-icon no" aria-hidden="true">✕</div>
            <h2>Not saved</h2>
            <p>Nothing was written to your ledger.</p>
          </>
        )}
        <button className="btn btn-primary" onClick={startOver}>
          Record another
        </button>
      </section>
    );
  }

  if (proposal) {
    return <ConfirmCard proposal={proposal} shopId={shop.id} onUpdate={showProposal} onFinish={finish} onStartOver={startOver} />;
  }

  return (
    <section className="record">
      <h2 className="screen-title">Tell PocketOga what happened</h2>
      <p className="hint">Example: “Mama Bisi buy 2 bags of rice, 15k, she pay 10k, remain 5k.”</p>

      {busy ? (
        <div className="loading" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>{busy}</p>
        </div>
      ) : canRecord ? (
        <div className="mic-wrap">
          <button
            className={recording ? "mic recording" : "mic"}
            onClick={recording ? stopRecording : startRecording}
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            <span className="mic-symbol" aria-hidden="true">{recording ? "■" : "🎤"}</span>
          </button>
          <p className="mic-label">
            {recording ? `Recording… ${seconds}s — tap to stop` : "Tap to talk"}
          </p>
        </div>
      ) : (
        <p className="notice">Voice recording does not work in this browser here. Type your note below.</p>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      <form className="type-box" onSubmit={sendText}>
        <label htmlFor="note-text">Or type it</label>
        <textarea
          id="note-text"
          className="input"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Chinedu buy 3 cartons Indomie, 27k, he don pay"
          disabled={!!busy || recording}
        />
        <button className="btn btn-secondary" disabled={!text.trim() || !!busy || recording}>
          Send
        </button>
      </form>
    </section>
  );
}
