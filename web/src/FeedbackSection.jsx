import { Component, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Check, CloudOff, Lightbulb, Mic, Send, Square, Star, Trash2, TriangleAlert, X } from "lucide-react";
import { sendFeedback } from "./api.js";
import { CANCELLED_MESSAGE, CANCELLED_MS, createRunTracker } from "./cancelRun.js";
import { connection, isOffline } from "./connection.js";
import { FEEDBACK_AUDIO_MAX_SECONDS, FEEDBACK_TEXT_MAX, PRIVACY_NOTE, THANKS, TYPE_OPTIONS, counterText, emptyFeedback, feedbackReducer, runSubmit, validateFeedback } from "./feedback.js";
import { createRecordTimer } from "./recordLimits.js";
import { MESSAGES, isEmptyRecording } from "./recordWait.js";
import { recordingToWavBase64 } from "./wav.js";
import { Button, cx, inputClass } from "./ui.jsx";

const TYPE_ICON = { suggestion: Lightbulb, problem: TriangleAlert, review: Star };
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Feedback must never take the rest of Settings down: if this section breaks,
// it says so plainly and everything else on the page keeps working.
class FeedbackBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <p data-part="feedback-broken" role="alert" className="rounded-2xl bg-slate px-4 py-3 font-bold">
        Feedback is not working right now. The rest of Settings is fine.
      </p>
    );
  }
}

// The Feedback section of Settings: its own card, title and form.
export default function FeedbackSection({ sectionRef }) {
  return (
    <article id="feedback" ref={sectionRef} data-part="feedback-section" aria-labelledby="feedback-title" className="grid scroll-mt-4 gap-4 rounded-card border border-line bg-card p-5 shadow-soft">
      <h2 id="feedback-title" tabIndex={-1} className="text-[1.0625rem] font-extrabold outline-none">
        Feedback
      </h2>
      <FeedbackBoundary>
        <FeedbackForm />
      </FeedbackBoundary>
    </article>
  );
}

function FeedbackForm() {
  const [form, dispatch] = useReducer(feedbackReducer, undefined, emptyFeedback);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [micNote, setMicNote] = useState(null); // a short plain line about the microphone
  const [cancelled, setCancelled] = useState(false);
  const conn = useSyncExternalStore(connection.subscribe, connection.get);
  const recorderRef = useRef(null);
  const cancelTimer = useRef(null);
  const runs = useRef(null);
  if (!runs.current) runs.current = createRunTracker();
  const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const sending = form.status === "sending";

  // Leaving the screen stops the microphone and drops a send in flight.
  useEffect(
    () => () => {
      recorderRef.current?.cleanup();
      runs.current.cancel();
      clearTimeout(cancelTimer.current);
    },
    []
  );

  function flashCancelled() {
    setCancelled(true);
    clearTimeout(cancelTimer.current);
    cancelTimer.current = setTimeout(() => setCancelled(false), CANCELLED_MS);
  }

  async function startRecording() {
    setMicNote(null);
    setCancelled(false);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setMicNote(MESSAGES.mic);
      return;
    }
    const chunks = [];
    const rec = new MediaRecorder(stream);
    const started = Date.now();
    const stopTimer = createRecordTimer({
      onTick: setSeconds,
      onLimit: () => stopRecording(), // 45 seconds: stops by itself and keeps the audio
      limitSeconds: FEEDBACK_AUDIO_MAX_SECONDS,
    });
    rec.cleanup = () => {
      stopTimer();
      stream.getTracks().forEach((t) => t.stop());
    };
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      rec.cleanup();
      if (rec.discarded) return; // cancelled: nothing kept, nothing said
      setRecording(false);
      const blob = new Blob(chunks, { type: rec.mimeType });
      const length = Math.min(FEEDBACK_AUDIO_MAX_SECONDS, Math.round((Date.now() - started) / 1000));
      if (Date.now() - started < 1000 || isEmptyRecording(blob)) {
        setMicNote(MESSAGES.empty);
        return;
      }
      dispatch({ type: "audio", blob, seconds: length });
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

  // Same as on Record: throws the audio away, says "Cancelled", no error.
  function cancelRecording() {
    const rec = recorderRef.current;
    if (!rec) return;
    rec.discarded = true;
    if (rec.state === "recording") rec.stop();
    else rec.cleanup();
    recorderRef.current = null;
    setRecording(false);
    setSeconds(0);
    flashCancelled();
  }

  async function submit(e) {
    e.preventDefault();
    if (sending || recording) return;
    const checked = validateFeedback(form);
    if (!checked.ok) return dispatch({ type: "error", message: checked.error });
    dispatch({ type: "sending" });
    const run = runs.current.begin();
    const action = await runSubmit(form, {
      online: () => !isOffline(connection.get()),
      toWav: recordingToWavBase64,
      send: (req) => sendFeedback(req, run.signal),
    });
    if (!run.isCurrent()) return; // cancelled meanwhile: what they typed is still there
    runs.current.end(run);
    dispatch(action);
  }

  function cancelSending() {
    runs.current.cancel();
    dispatch({ type: "failed", message: null });
    flashCancelled();
  }

  if (form.status === "sent") {
    return (
      <div data-part="feedback-thanks" role="status" className="grid gap-3">
        <p className="flex items-center gap-2 text-xl font-extrabold [&_svg]:size-6 [&_svg]:text-teal-ink">
          <Check aria-hidden="true" strokeWidth={3} /> {THANKS}
        </p>
        {form.heard && (
          <figure className="border-l-[3px] border-lavender py-1 pl-3.5">
            <figcaption className="text-sm font-semibold text-muted">We heard:</figcaption>
            <blockquote className="whitespace-pre-line [overflow-wrap:anywhere]">“{form.heard}”</blockquote>
          </figure>
        )}
        <Button variant="quiet" onClick={() => dispatch({ type: "reset" })}>
          Send more feedback
        </Button>
      </div>
    );
  }

  const offline = isOffline(conn);
  const hasAudio = !!form.audio;

  return (
    <>
      <form data-part="feedback-form" onSubmit={submit} className="grid gap-5" aria-busy={sending}>
        {offline && (
          <p data-part="feedback-offline" role="status" className="flex items-start gap-2 rounded-2xl border border-line bg-slate px-4 py-3 font-bold [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:shrink-0">
            <CloudOff aria-hidden="true" /> You are offline. You can write it now and send it when you are back online.
          </p>
        )}

        <fieldset className="grid gap-2">
          <legend className="mb-1 font-bold">What kind of feedback?</legend>
          {TYPE_OPTIONS.map((t) => {
            const Icon = TYPE_ICON[t.key];
            return (
              <button
                key={t.key}
                type="button"
                data-part="feedback-type"
                data-type={t.key}
                aria-pressed={form.type === t.key}
                disabled={sending}
                onClick={() => dispatch({ type: "type", value: t.key })}
                className="flex min-h-16 w-full items-center gap-3 rounded-card border-[1.5px] border-line bg-card px-4 py-2.5 text-left shadow-soft transition-colors aria-pressed:border-accent aria-pressed:bg-lavender [&_svg]:size-6 [&_svg]:shrink-0 [&_svg]:text-link"
              >
                <Icon aria-hidden="true" />
                <span className="grid min-w-0">
                  <span className="font-bold">{t.label}</span>
                  <span className="text-sm text-muted">{t.hint}</span>
                </span>
                {form.type === t.key && <Check aria-hidden="true" strokeWidth={3} className="ml-auto" />}
              </button>
            );
          })}
        </fieldset>

        <div className="grid gap-2">
          <label htmlFor="feedback-text" className="font-bold">
            Your message
          </label>
          {hasAudio ? (
            <div data-part="feedback-audio" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-[1.5px] border-line bg-slate px-4 py-3">
              <span className="font-bold">Voice message ready · {mmss(form.audio.seconds)}</span>
              <button type="button" data-part="remove-audio" disabled={sending} onClick={() => dispatch({ type: "removeAudio" })} className="inline-flex min-h-12 items-center gap-1.5 rounded-full px-3 text-sm font-bold text-link underline">
                <Trash2 aria-hidden="true" className="size-4" /> Remove, type instead
              </button>
            </div>
          ) : (
            <>
              <textarea
                id="feedback-text"
                rows={5}
                maxLength={FEEDBACK_TEXT_MAX}
                value={form.text}
                disabled={sending || recording}
                onChange={(e) => dispatch({ type: "text", value: e.target.value })}
                aria-describedby="feedback-count feedback-privacy"
                placeholder="Tell us what you think"
                className={inputClass}
              />
              <p id="feedback-count" data-part="feedback-count" className={cx("text-right text-sm tabular-nums", form.text.length >= FEEDBACK_TEXT_MAX ? "font-bold text-coral-ink" : "text-muted")}>
                {counterText(form.text)}
              </p>
            </>
          )}

          {canRecord && !hasAudio && (
            <div className="grid gap-2">
              {recording ? (
                <div className="flex gap-2">
                  <Button type="button" data-part="feedback-stop" variant="secondary" className="flex-1" onClick={stopRecording} aria-label="Stop recording">
                    <Square aria-hidden="true" fill="currentColor" /> <span className="tabular-nums">Recording {mmss(seconds)}</span>
                  </Button>
                  <Button type="button" data-part="feedback-cancel-recording" variant="quiet" className="w-auto shrink-0 px-4" onClick={cancelRecording} aria-label="Cancel recording and throw the audio away">
                    <X aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <Button type="button" data-part="feedback-mic" variant="quiet" disabled={sending} onClick={startRecording}>
                  <Mic aria-hidden="true" /> Record instead (up to {FEEDBACK_AUDIO_MAX_SECONDS} seconds)
                </Button>
              )}
            </div>
          )}
          {micNote && (
            <p role="status" className="text-sm font-semibold text-muted">
              {micNote}
            </p>
          )}
          {cancelled && (
            <p data-part="cancelled" role="status" className="rounded-2xl bg-slate px-4 py-2 text-center font-bold">
              {CANCELLED_MESSAGE}
            </p>
          )}
        </div>

        <div role="group" aria-labelledby="feedback-rating-label" className="grid gap-1.5">
          <p id="feedback-rating-label" className="font-bold">
            Rating <span className="font-normal text-muted">(optional)</span>
          </p>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                data-part="feedback-star"
                aria-pressed={form.rating === n}
                aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
                disabled={sending}
                onClick={() => dispatch({ type: "rating", value: n })}
                className="grid size-12 shrink-0 place-items-center rounded-full text-grey transition-transform active:scale-96 data-[on=true]:text-amber-ink [&_svg]:size-8"
                data-on={form.rating !== null && n <= form.rating}
              >
                <Star aria-hidden="true" fill={form.rating !== null && n <= form.rating ? "currentColor" : "none"} strokeWidth={1.8} />
              </button>
            ))}
          </div>
        </div>

        <p id="feedback-privacy" data-part="feedback-privacy" className="rounded-2xl border border-line bg-lavender px-4 py-3 text-sm font-semibold">
          {PRIVACY_NOTE}
        </p>

        {form.error && (
          <p data-part="feedback-error" role="alert" className="rounded-2xl bg-slate px-4 py-3 font-bold [overflow-wrap:anywhere]">
            {form.error}
          </p>
        )}

        <div className="grid gap-2">
          <Button data-part="feedback-send" size="lg" disabled={sending || recording}>
            <Send aria-hidden="true" /> {sending ? "Sending…" : "Send"}
          </Button>
          {sending && (
            <Button type="button" data-part="feedback-cancel" variant="quiet" onClick={cancelSending}>
              <X aria-hidden="true" /> Cancel
            </Button>
          )}
        </div>
      </form>
    </>
  );
}
