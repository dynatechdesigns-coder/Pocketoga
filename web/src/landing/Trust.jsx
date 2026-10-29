import { Calculator, Link2, Sparkles } from "lucide-react";
import ChainDemo from "./ChainDemo.jsx";
import { Reveal } from "./motion.jsx";
import { Section } from "./parts.jsx";

const POINTS = [
  [Sparkles, "The AI only proposes", "It reads your voice note and suggests the entries. Nothing is saved until you tap Save."],
  [Calculator, "Plain code checks every number", "Totals, payments and what is still owed are worked out in code, not guessed."],
  [Link2, "Locked in a chain", "Every entry is linked to the one before it. It can be corrected with a new entry, never erased."],
];

// The deep violet section: who decides, and the hash chain showing a change
// being caught. The section is a dark-colour island (see Section tone).
export default function Trust() {
  return (
    <Section id="trust" tone="violet" title="The AI suggests. You decide.">
      <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-center lg:gap-14">
        <ul className="grid gap-7">
          {POINTS.map(([Icon, title, text], i) => (
            <Reveal as="li" key={title} delay={i * 80} className="flex gap-4">
              <span
                aria-hidden="true"
                className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/10 text-marigold [&_svg]:size-6"
              >
                <Icon strokeWidth={2} />
              </span>
              <div className="grid gap-1">
                <h3 className="text-xl font-extrabold text-white">{title}</h3>
                <p className="max-w-[48ch] text-[1.0625rem] leading-relaxed text-white/85">{text}</p>
              </div>
            </Reveal>
          ))}
        </ul>
        <Reveal delay={120}>
          <ChainDemo />
        </Reveal>
      </div>
    </Section>
  );
}
