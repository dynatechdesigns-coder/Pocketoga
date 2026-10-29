import { cx } from "../ui.jsx";
import { Reveal } from "./motion.jsx";
import { Photo, Section } from "./parts.jsx";
import VoicePhone from "./VoicePhone.jsx";

// Step 1 is a coded phone, not a photo; steps 2 and 3 use these photo slots.
export const STEP_SLOTS = ["hands-notebook", "shop-counter"];

const STEPS = [
  [
    null,
    "Send a voice note",
    "Say it the way you talk: who bought, how much, what they paid.",
    "A WhatsApp-style chat on a phone. The trader sends a 7-second voice note. PocketOga replies: sold 2 bags of rice to Ada, ₦45,000, she owes ₦20,000, with Save, Fix and Reject buttons.",
  ],
  [
    "hands-notebook",
    "Check what it heard",
    "PocketOga shows the sale, the payment and what is still owed. Wrong? Tap Fix.",
    "Hands hold a phone over an open, handwritten sales notebook.",
  ],
  [
    "shop-counter",
    "Tap Save",
    "Only then is it written down, in a record nobody can quietly change.",
    "A notebook of daily sales held over a counter, beside a calculator and a bundle of cash.",
  ],
];

// Three steps side by side (stacked on phones), each with a photo, a number and
// one sentence. On wide screens a thin line runs from each number to the next.
export default function HowItWorks() {
  return (
    <Section id="how" tone="white" title="How it works" intro="Three steps. Nothing is saved until you say so.">
      <ol className="grid gap-12 md:grid-cols-3 md:gap-8">
        {STEPS.map(([slot, title, text, alt], i) => (
          <Reveal as="li" key={title} delay={i * 90} className="grid content-start gap-4">
            {slot ? (
              <Photo slot={slot} alt={alt} className="aspect-[16/10] md:aspect-[4/3]" />
            ) : (
              <>
                <VoicePhone className="aspect-[16/10] w-full md:aspect-[4/3]" />
                <p className="sr-only">{alt}</p>
              </>
            )}
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-sunset text-lg font-extrabold text-bezel"
              >
                {i + 1}
              </span>
              {/* the connecting line: to the next step's number (wide screens) */}
              <span
                aria-hidden="true"
                className={cx("hidden h-0.5 flex-1 rounded-full bg-sunset/50 md:block", i < STEPS.length - 1 ? "md:-mr-8" : "md:invisible")}
              />
            </div>
            <h3 className="text-xl font-extrabold">
              <span className="sr-only">Step {i + 1}: </span>
              {title}
            </h3>
            <p className="max-w-[40ch] text-[1.0625rem] leading-relaxed text-muted">{text}</p>
          </Reveal>
        ))}
      </ol>
    </Section>
  );
}
