import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Globe, Keyboard, Link2, MessageCircle, Mic, MousePointerClick, Play } from "lucide-react";
import { formatKobo, plural } from "../format.js";
import { cx } from "../ui.jsx";
import { Reveal, useInView, useReducedMotion } from "./motion.jsx";
import { IconTile, Section } from "./parts.jsx";
import { CARD_BUTTONS, CARD_TEXT, SAVED_TEXT, VOICE_NOTE_LENGTH, WEB_AFTER, WEB_BEFORE } from "./whatsappDemo.js";

// "Talk on WhatsApp. See it on the web." One note on WhatsApp, the bot's real
// reply, Save, and the same numbers arriving on the web. The chat is drawn in
// PocketOga's own style (no WhatsApp logo, icons or interface); its text is
// exactly what the bot sends (whatsappDemo.js, checked by npm run check:copy).
//
// While on screen the demo plays as a loop (see TIMELINE); off screen it stops.
// With prefers-reduced-motion it shows the finished state and never moves.

// Steps: 0 empty, 1 voice note, 2 "listening", 3 reply card, 4 Save pressed,
// 5 Saved and the web numbers count up.
const FINAL = 5;
const TIMELINE = [
  [300, 1],
  [1000, 2],
  [2100, 3],
  [3300, 4],
  [3700, 5],
];
const COUNT_MS = 900;
const HOLD_MS = 3000; // after the count, before the loop restarts
const LOOP_MS = 3700 + COUNT_MS + HOLD_MS;

function useDemoLoop(playing, reduced) {
  const [step, setStep] = useState(reduced ? FINAL : 0);
  const [run, setRun] = useState(0); // bumps on every pass, to replay one-shot animations
  useEffect(() => {
    if (reduced) {
      setStep(FINAL);
      return;
    }
    if (!playing) {
      setStep(0); // off screen: stop, and start from the top next time
      return;
    }
    let timers = [];
    const pass = () => {
      setStep(0);
      setRun((r) => r + 1);
      timers = TIMELINE.map(([at, s]) => setTimeout(() => setStep(s), at));
      timers.push(setTimeout(pass, LOOP_MS));
    };
    pass();
    return () => timers.forEach(clearTimeout);
  }, [playing, reduced]);
  return { step, run };
}

export default function WhatsAppWeb() {
  const box = useRef(null);
  const inView = useInView(box, { threshold: 0.35 });
  const reduced = useReducedMotion();
  const { step, run } = useDemoLoop(inView, reduced);

  return (
    // content-visibility: the browser skips rendering this section until it is
    // near the screen, so the first paint doesn't wait for two phones that are
    // below the fold. The sizes are its real heights (stacked, then side by
    // side), so nothing jumps when it renders.
    <Section
      id="whatsapp"
      tone="cream"
      title="Talk on WhatsApp. See it on the web."
      intro="Send a voice note, tap Save, and the same record is on your web Money screen."
      className="[contain-intrinsic-size:auto_2050px] [content-visibility:auto] md:[contain-intrinsic-size:auto_1800px] lg:[contain-intrinsic-size:auto_1120px]"
    >
      <div
        ref={box}
        data-part="wa-demo"
        data-step={step}
        className="mx-auto grid items-center justify-items-center gap-2 lg:max-w-[920px] lg:grid-cols-[300px_minmax(10rem,1fr)_300px] lg:gap-0"
      >
        <Phone label="On WhatsApp" icon={MessageCircle} part="chat-phone">
          <Chat step={step} run={run} />
        </Phone>
        <Connector active={step >= FINAL} run={run} reduced={reduced} />
        <Phone label="On the web" icon={Globe} part="web-phone">
          <WebMoney updated={step >= FINAL} run={run} reduced={reduced} />
        </Phone>
      </div>

      <ul className="mt-12 grid gap-4 sm:grid-cols-3">
        {[
          [Mic, "Send a voice note in Pidgin", "sunset"],
          [MousePointerClick, "Tap Save, Fix or Reject", "marigold"],
          [Keyboard, "Type who owes, chase or report", "sunset"],
        ].map(([icon, text, tone], i) => (
          <Reveal
            as="li"
            key={text}
            delay={i * 80}
            data-part="wa-feature"
            className="flex items-center gap-3 rounded-[16px] border border-line bg-surface p-4"
          >
            <IconTile icon={icon} tone={tone} size="sm" />
            <span className="font-extrabold">{text}</span>
          </Reveal>
        ))}
      </ul>
      <Reveal as="p" delay={240} data-part="no-app" className="mt-6 text-center text-lg font-extrabold">
        No app to download. Your records also open on the web.
      </Reveal>
    </Section>
  );
}

// --- Phones ------------------------------------------------------------------------

function Phone({ label, icon: Icon, part, children }) {
  return (
    <figure className="grid w-full max-w-[300px] gap-3" data-part={part}>
      <figcaption className="flex items-center justify-center gap-2 font-extrabold [&_svg]:size-5 [&_svg]:text-link">
        <Icon aria-hidden="true" /> {label}
      </figcaption>
      <PhoneScreen>{children}</PhoneScreen>
    </figure>
  );
}

// A phone-shaped frame, 300 wide. Also used, scaled down, in the hero.
// `height`: the screen's height in px (the hero uses a shorter one).
export function PhoneScreen({ height = 520, children }) {
  return (
    <div className="overflow-hidden rounded-[2rem] border-[6px] border-bezel bg-bezel shadow-lift ring-1 ring-line">
      <div className="relative flex flex-col overflow-hidden rounded-[1.5rem] bg-page" style={{ height }}>
        {children}
      </div>
    </div>
  );
}

// Shown when a step is reached: fades and rises into a space that is always
// reserved, so nothing below ever moves.
const appear = (on, from = "translate-y-3") =>
  cx("transition-[opacity,translate] duration-[420ms] ease-out-soft", on ? "translate-y-0 opacity-100" : cx(from, "opacity-0"));

function Chat({ step, run }) {
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line bg-card px-3.5 py-2.5">
        <img src="/icon.svg" alt="" width="32" height="32" className="size-8 rounded-[10px]" />
        <span className="grid leading-tight">
          <span className="text-[0.9375rem] font-extrabold">PocketOga</span>
          <span className="text-xs text-muted">Your shop assistant</span>
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2.5 p-3 text-[0.8125rem] leading-snug">
        {/* The trader's voice note */}
        <div
          data-part="wa-voice"
          className={cx(
            "flex max-w-[86%] items-center gap-2.5 self-end rounded-[18px_18px_6px_18px] bg-primary px-3 py-2.5 text-white",
            appear(step >= 1),
          )}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/20 [&_svg]:size-4" aria-hidden="true">
            <Play fill="currentColor" />
          </span>
          <Waveform />
          <span className="text-xs font-semibold tabular-nums">
            <span className="sr-only">Voice note, </span>
            {VOICE_NOTE_LENGTH}
          </span>
        </div>

        {/* "Listening" and the reply card share one reserved space. */}
        <div className="relative">
          <div
            data-part="wa-typing"
            aria-hidden="true"
            className={cx(
              "absolute top-0 left-0 flex items-center gap-2 rounded-[18px_18px_18px_6px] border border-line bg-card px-3 py-2 text-muted",
              appear(step === 2, "translate-y-1"),
            )}
          >
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <i
                  key={i}
                  className={cx("size-1.5 rounded-full bg-muted", step === 2 && "animate-typing")}
                  style={{ animationDelay: `${i * 160}ms` }}
                />
              ))}
            </span>
            <span className="text-xs font-semibold">PocketOga is listening…</span>
          </div>

          <div data-part="wa-card" className={cx("grid max-w-[92%] gap-2", appear(step >= 3, "translate-y-6"))}>
            <div className="rounded-[18px_18px_18px_6px] border border-line bg-card px-3 py-2.5 text-ink">
              <WaText text={CARD_TEXT} />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {CARD_BUTTONS.map((b) => (
                <span
                  key={b === "Save" ? `${b}-${run}` : b}
                  data-part={b === "Save" ? "wa-save" : undefined}
                  className={cx(
                    "grid min-h-8 place-items-center rounded-full border text-xs font-bold",
                    b === "Save" ? "border-transparent bg-primary text-white" : "border-line bg-card text-link",
                    b === "Save" && step >= 4 && "animate-press",
                  )}
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* The bot's saved reply */}
        <div
          data-part="wa-saved"
          className={cx("max-w-[92%] rounded-[18px_18px_18px_6px] border border-line bg-card px-3 py-2.5 text-ink", appear(step >= 5))}
        >
          <WaText text={SAVED_TEXT} />
        </div>
      </div>
    </>
  );
}

// A static waveform: bar heights in px, drawn with transform only.
const BARS = [6, 12, 18, 10, 20, 14, 8, 16, 22, 12, 7, 15, 19, 9, 13, 6];
export function Waveform() {
  return (
    <span className="flex h-6 flex-1 items-center gap-[2px]" aria-hidden="true">
      {BARS.map((h, i) => (
        <i key={i} className="w-[3px] rounded-full bg-white/80" style={{ height: `${h}px` }} />
      ))}
    </span>
  );
}

// WhatsApp markup as the trader sees it: *bold*, _italic_, blank lines between
// blocks. Emoji are shown in greyscale so the page stays free of green.
function WaText({ text }) {
  return text.split("\n").map((line, i) =>
    line === "" ? (
      <span key={i} className="block h-2" aria-hidden="true" />
    ) : (
      <span key={i} className="block">
        {line.split(/(\*[^*\n]+\*|_[^_\n]+_)/).map((part, j) =>
          /^\*.+\*$/.test(part) ? (
            <strong key={j}>{emoji(part.slice(1, -1))}</strong>
          ) : /^_.+_$/.test(part) ? (
            <em key={j} className="text-muted">
              {emoji(part.slice(1, -1))}
            </em>
          ) : (
            <span key={j}>{emoji(part)}</span>
          ),
        )}
      </span>
    ),
  );
}

const emoji = (s) =>
  s.split(/(\p{Extended_Pictographic}️?)/u).map((p, i) =>
    /\p{Extended_Pictographic}/u.test(p) ? (
      <span key={i} data-part="emoji" className="grayscale">
        {p}
      </span>
    ) : (
      p
    ),
  );

// --- The web side ------------------------------------------------------------------

// Counts from the old figure to the new one, in whole naira, integer kobo only.
function useCount(from, to, on, reduced, run) {
  const [value, setValue] = useState(on ? to : from);
  useEffect(() => {
    if (!on) return setValue(from);
    if (reduced) return setValue(to);
    let frame;
    const start = performance.now();
    const tick = (now) => {
      const k = Math.min(1000, Math.round(((now - start) * 1000) / COUNT_MS)); // 0..1000
      const eased = 1000 - Math.floor(((1000 - k) * (1000 - k)) / 1000); // ease-out
      const v = from + Math.floor(((to - from) * eased) / 1000);
      setValue(v - (v % 100));
      if (k < 1000) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [from, to, on, reduced, run]);
  return value;
}

export function WebMoney({ updated, run, reduced }) {
  const sold = useCount(WEB_BEFORE.soldKobo, WEB_AFTER.soldKobo, updated, reduced, run);
  const collected = useCount(WEB_BEFORE.collectedKobo, WEB_AFTER.collectedKobo, updated, reduced, run);
  const owed = useCount(WEB_BEFORE.owedKobo, WEB_AFTER.owedKobo, updated, reduced, run);
  const owing = updated ? WEB_AFTER.owing : WEB_BEFORE.owing;

  return (
    <div className="flex flex-1 flex-col gap-3 p-3.5">
      <p className="sr-only">
        The web Money screen. Before the note: sold today {formatKobo(WEB_BEFORE.soldKobo)}, customers owe {formatKobo(WEB_BEFORE.owedKobo)}
        . After Save: sold today {formatKobo(WEB_AFTER.soldKobo)}, collected today {formatKobo(WEB_AFTER.collectedKobo)}, customers owe{" "}
        {formatKobo(WEB_AFTER.owedKobo)}.
      </p>
      <div aria-hidden="true" className="contents">
        <div className="flex items-center justify-between gap-2">
          <span className="grid min-w-0 leading-tight">
            <span className="text-xs text-muted">Good morning,</span>
            <span className="truncate text-[0.9375rem] font-extrabold">Mama Nkechi Provisions</span>
          </span>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-av4 text-xs font-extrabold text-av4-ink">MN</span>
        </div>

        {/* Money in: the brand gradient */}
        <div data-part="web-hero" className="grid grid-cols-[1fr_1px_1fr] gap-x-3 rounded-2xl bg-hero p-3.5 text-white shadow-lift">
          <div className="grid gap-0.5">
            <span className="text-xs font-semibold">Sold today</span>
            <span data-part="web-sold" className="text-lg leading-tight font-extrabold tabular-nums">
              {formatKobo(sold)}
            </span>
          </div>
          <span className="bg-white/35" />
          <div className="grid gap-0.5">
            <span className="text-xs font-semibold">Collected today</span>
            <span data-part="web-collected" className="text-lg leading-tight font-extrabold tabular-nums">
              {formatKobo(collected)}
            </span>
          </div>
        </div>

        {/* Money owed: amber */}
        <div className="relative grid gap-1 overflow-hidden rounded-2xl border border-line bg-card p-3.5 pl-5 shadow-soft">
          <span className="absolute inset-y-0 left-0 w-1.5 bg-amber" />
          <span className="text-sm font-bold">Customers owe you</span>
          <span data-part="web-owed" className="text-[1.75rem] leading-tight font-extrabold tracking-tight tabular-nums">
            {formatKobo(owed)}
          </span>
          <span className="mt-1 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-ink/6 px-2.5 py-1 text-xs font-semibold">{plural(owing, "customer")} owing</span>
            <span className="rounded-full bg-ink/6 px-2.5 py-1 text-xs font-semibold">None overdue 30+ days</span>
          </span>
        </div>

        {/* What just arrived from WhatsApp */}
        <div
          data-part="web-new"
          className={cx("flex items-center gap-2.5 rounded-2xl border border-line bg-card px-3 py-2.5", appear(updated))}
        >
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-lavender text-link [&_svg]:size-4">
            <MessageCircle />
          </span>
          <span className="grid text-xs leading-snug">
            <span className="font-bold">Just now, from WhatsApp</span>
            <span className="text-muted">Ada: sale ₦30,000, paid ₦10,000</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// --- "Same ledger" between the phones ------------------------------------------------

function Connector({ active, run, reduced }) {
  return (
    <div data-part="same-ledger" className="relative flex h-24 w-full items-center justify-center lg:h-full lg:min-h-24">
      {/* The track: vertical when the phones stack, horizontal side by side. */}
      <span
        aria-hidden="true"
        className="absolute top-0 left-1/2 h-full w-0.5 -translate-x-1/2 bg-accent lg:top-1/2 lg:left-2 lg:h-0.5 lg:w-[calc(100%-1rem)] lg:translate-x-0 lg:-translate-y-1/2"
      />
      {/* A dot carries the record across when it is saved. */}
      {active && !reduced && (
        <>
          <span
            key={`v${run}`}
            aria-hidden="true"
            className="absolute top-0 left-1/2 h-full w-0 animate-travel lg:hidden"
            style={{ "--travel-y": "100%" }}
          >
            <i className="absolute -left-1.5 size-3 rounded-full bg-accent" />
          </span>
          <span
            key={`h${run}`}
            aria-hidden="true"
            className="absolute top-1/2 left-2 hidden h-0 w-[calc(100%-1rem)] animate-travel lg:block"
            style={{ "--travel-x": "100%" }}
          >
            <i className="absolute -top-1.5 size-3 rounded-full bg-accent" />
          </span>
        </>
      )}
      <span className="relative z-10 inline-flex items-center gap-1.5 rounded-full border-[1.5px] border-accent bg-card px-3 py-1.5 text-sm font-extrabold whitespace-nowrap text-link [&_svg]:size-4">
        <Link2 aria-hidden="true" /> Same ledger
      </span>
      <ArrowDown aria-hidden="true" className="absolute bottom-0 left-1/2 size-4 -translate-x-1/2 translate-y-1/2 text-accent lg:hidden" />
      <ArrowRight aria-hidden="true" className="absolute top-1/2 right-0 hidden size-4 -translate-y-1/2 text-accent lg:block" />
    </div>
  );
}
