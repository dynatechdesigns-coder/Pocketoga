import { ArrowLeft, Hourglass } from "lucide-react";
import { Button, Card, IconCircle, ThemeToggle } from "../ui.jsx";

// Placeholder for the planned accuracy page (PROJECT.md section 5: "Accuracy
// page and red-team report"). It says plainly that nothing is published yet.
export default function AccuracyPage() {
  return (
    <main className="mx-auto grid max-w-[560px] gap-5 px-5 pt-[calc(24px+env(safe-area-inset-top))] pb-12">
      <div className="flex items-center justify-between">
        <a href="/" className="inline-flex min-h-12 items-center gap-2 font-bold text-link no-underline [&_svg]:size-5">
          <ArrowLeft aria-hidden="true" /> PocketOga
        </a>
        <ThemeToggle />
      </div>
      <h1 className="text-3xl font-extrabold tracking-tight">Accuracy</h1>
      <Card className="grid justify-items-start gap-3 p-6" data-part="accuracy-placeholder">
        <IconCircle icon={Hourglass} tone="slate" />
        <p className="text-lg font-extrabold">Coming soon</p>
        <p className="text-muted">
          This page will show how well PocketOga understands real notes: what it got right, what it got wrong, and how it was tested.
          Nothing is published yet, so there are no accuracy numbers to show.
        </p>
        <Button as="a" href="/" variant="secondary" className="w-auto min-w-42">
          Back to the home page
        </Button>
      </Card>
    </main>
  );
}
