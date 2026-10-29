import { Button } from "../ui.jsx";
import { hasImage } from "./images.js";
import { Reveal } from "./motion.jsx";
import { Container, Photo } from "./parts.jsx";

// The last call: the market lane as a wide banner, darkened on the side where
// the words sit (below them on phones, beside them on wide screens).
export default function FinalCta({ onDemo }) {
  const photo = hasImage("market-lane");
  return (
    <section aria-labelledby="cta-h" className="bg-cream py-16 md:py-24">
      <Container>
        <Reveal className="relative isolate overflow-hidden rounded-[24px]">
          {photo && (
            <Photo
              slot="market-lane"
              alt="A busy market lane at dusk, with stalls of tomatoes, peppers and bananas on both sides."
              fill
              className="-z-20"
            />
          )}
          <span
            aria-hidden="true"
            data-part="cta-shade"
            className={
              photo
                ? "absolute inset-0 -z-10 bg-[linear-gradient(0deg,rgba(18,18,42,0.94)_0%,rgba(18,18,42,0.86)_50%,rgba(18,18,42,0.2)_100%)] md:bg-[linear-gradient(90deg,rgba(18,18,42,0.94)_0%,rgba(18,18,42,0.88)_45%,rgba(18,18,42,0.1)_80%)]"
                : "absolute inset-0 -z-10 bg-hero"
            }
          />
          <div
            data-on-photo
            className="flex min-h-[460px] flex-col justify-end gap-6 p-7 md:min-h-[420px] md:max-w-[520px] md:justify-center md:p-14"
          >
            <h2 id="cta-h" className="text-[2rem] leading-tight font-extrabold tracking-tight text-white md:text-[2.75rem]">
              Your shop. Your money. In your pocket.
            </h2>
            <Button variant="light" size="lg" className="w-full hover:-translate-y-0.5 sm:w-auto sm:min-w-56" onClick={onDemo}>
              Try the demo shop
            </Button>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
