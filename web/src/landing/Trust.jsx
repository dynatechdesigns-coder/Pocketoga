import { Calculator, Lock, Sparkles } from "lucide-react";
import LedgerPeek from "./LedgerPeek.jsx";
import { Reveal } from "./motion.jsx";
import { Section } from "./parts.jsx";

const POINTS = [
  [Sparkles, "The AI only proposes", "It reads your voice note and suggests the entries. Nothing is saved until you tap Save."],
  [Calculator, "Plain code checks every number", "Totals, payments and what is still owed are worked out in code, not guessed."],
  [Lock, "Nobody can change your records quietly", "Every sale you save is locked in. Made a mistake? Add a correction. The old line stays, so there is always a clear record of what happened."],
];

// The deep violet section: who decides, and a saved sale with its correction
// under it. Two equal columns, both centred on the same line, so neither
// hangs below the other. The section is a dark-colour island (see Section tone).
export default function Trust() {
  return (
    <Section id="trust" tone="violet" title="The AI suggests. You decide.">
      <div className="grid gap-10 lg:grid-cols-2 lg:items-stretch lg:gap-16">
        <ul className="grid content-center gap-8">
          {POINTS.map(([Icon, title, text], i) => (
            <Reveal as="li" key={title} delay={i * 80} className="flex gap-5">
              <span
                aria-hidden="true"
                className="grid size-14 shrink-0 place-items-center rounded-2xl bg-white/10 text-marigold [&_svg]:size-7"
              >
                <Icon strokeWidth={2} />
              </span>
              <div className="grid gap-1.5">
                <h3 className="text-2xl leading-snug font-extrabold text-white">{title}</h3>
                <p className="max-w-[44ch] text-[1.125rem] leading-relaxed text-white/90">{text}</p>
              </div>
            </Reveal>
          ))}
        </ul>
        <Reveal delay={120} className="lg:h-full">
          <LedgerPeek />
        </Reveal>
      </div>
      <Reveal as="p" data-part="accuracy-note" className="mt-12 border-t border-white/15 pt-6 text-[1.125rem] text-white/90">
        Accuracy results will be published here.
      </Reveal>
    </Section>
  );
}
