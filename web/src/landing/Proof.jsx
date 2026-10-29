import { ArrowRight } from "lucide-react";
import { Reveal } from "./motion.jsx";
import { Container } from "./parts.jsx";

// Honest proof: no testimonials, invented numbers or logos. One line and a
// link to the accuracy page (a "coming soon" page until results are published).
export default function Proof() {
  return (
    <section id="proof" aria-label="Proof" className="bg-surface py-16 md:py-24">
      <Container>
        <Reveal className="flex flex-col items-start gap-4 border-y border-line py-10 md:flex-row md:items-center md:justify-between">
          <p className="text-[1.5rem] leading-snug font-extrabold md:text-[1.875rem]">Built and tested with real Pidgin voice notes</p>
          <a
            href="/accuracy"
            className="inline-flex min-h-12 items-center gap-2 text-lg font-extrabold text-link underline decoration-sunset decoration-2 underline-offset-4 [&_svg]:size-5"
          >
            See how accurate it is <ArrowRight aria-hidden="true" />
          </a>
        </Reveal>
      </Container>
    </section>
  );
}
