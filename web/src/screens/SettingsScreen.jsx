import { useEffect, useRef, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import FeedbackSection from "../FeedbackSection.jsx";
import InstallRow, { InstallSteps } from "../InstallRow.jsx";
import { shopInfo } from "../settings.js";
import { Avatar, Button, Card, IconCircle, PeriodTabs, Pill, ScreenHeader, SectionTitle, setTheme, useDark } from "../ui.jsx";

const THEMES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

// Top to bottom: Theme, Your shop (with the leave button inside it: Sign out for
// a real shop), Install PocketOga (where it is possible), then Send feedback,
// folded until tapped. Nothing important sits below Feedback. `intent`
// "feedback" opens the Feedback card and scrolls to it (the quiet link at the
// bottom of Home). `onLogin` opens the login screen from the sample shop.
export default function SettingsScreen({ shop, intent, onExit, onLogin }) {
  const dark = useDark();
  const info = shopInfo(shop);
  const [installSteps, setInstallSteps] = useState(false); // iPhone and iPad: how to add it to the home screen
  const [feedbackOpen, setFeedbackOpen] = useState(intent === "feedback");
  const feedbackRef = useRef(null);

  useEffect(() => {
    if (intent !== "feedback") return;
    setFeedbackOpen(true);
    const section = feedbackRef.current;
    if (!section) return;
    section.scrollIntoView({ block: "start" });
    section.querySelector("#feedback-title")?.focus({ preventScroll: true });
  }, [intent]);

  return (
    <section data-part="settings" className="grid gap-4">
      <ScreenHeader title="Settings" />

      <Card as="article" data-part="settings-theme" className="grid gap-3">
        <SectionTitle as="h2" className="mt-0">
          Theme
        </SectionTitle>
        <PeriodTabs periods={THEMES} value={dark ? "dark" : "light"} onChange={setTheme} label="Theme" />
      </Card>

      <section data-part="settings-shop" data-kind={info.kind} aria-labelledby="your-shop-title" className="grid gap-4">
        <Card as="article" className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle as="h2" id="your-shop-title" className="mt-0">
              Your shop
            </SectionTitle>
            <Button data-part="leave" variant={info.leave.variant} size="sm" className="w-auto shrink-0 whitespace-nowrap" onClick={onExit}>
              <LogOut aria-hidden="true" /> {info.leave.label}
            </Button>
          </div>
          <div className="flex items-center gap-4">
            <Avatar name={info.name} size="lg" />
            <div className="grid min-w-0 gap-1">
              <p className="text-lg font-extrabold [overflow-wrap:anywhere]">{info.name}</p>
              <span>
                <Pill tone={info.kind === "demo" ? "amber" : "teal"}>{info.badge}</Pill>
              </span>
            </div>
          </div>
          <p className="text-sm text-muted">{info.line}</p>
        </Card>

        {info.openReal && (
          <Card as="article" data-part="open-real-shop" className="grid gap-3">
            <div className="flex items-center gap-3">
              <IconCircle icon={KeyRound} tone="lavender" size="sm" />
              <SectionTitle as="h3" className="mt-0">
                {info.openReal.title}
              </SectionTitle>
            </div>
            <p className="text-muted">{info.openReal.line}</p>
            <Button data-part="login-to-shop" onClick={onLogin}>
              {info.openReal.button}
            </Button>
          </Card>
        )}
      </section>

      {/* Only where installing is possible; empty (and gap-free) otherwise. */}
      <ul data-part="settings-install" className="grid empty:hidden">
        <InstallRow onClose={() => {}} onSteps={() => setInstallSteps(true)} />
      </ul>
      <InstallSteps open={installSteps} onClose={() => setInstallSteps(false)} />

      <FeedbackSection sectionRef={feedbackRef} open={feedbackOpen} onToggle={() => setFeedbackOpen((o) => !o)} />
    </section>
  );
}
