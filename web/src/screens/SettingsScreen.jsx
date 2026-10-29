import { useEffect, useState } from "react";
import { Download, LogOut, ShieldCheck } from "lucide-react";
import { Avatar, Button, Card, IconCircle, PeriodTabs, ScreenHeader, SectionTitle, setTheme, useDark } from "../ui.jsx";

const THEMES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

// Theme (light unless the trader picks dark, remembered on this device), the
// shop, installing the app, and leaving the shop.
export default function SettingsScreen({ shop, onExit }) {
  const dark = useDark();

  // Chrome and Android offer an install prompt; keep it for our button.
  const [installEvent, setInstallEvent] = useState(null);
  useEffect(() => {
    const keep = (e) => {
      e.preventDefault();
      setInstallEvent(e);
    };
    window.addEventListener("beforeinstallprompt", keep);
    return () => window.removeEventListener("beforeinstallprompt", keep);
  }, []);

  return (
    <section className="grid gap-4">
      <ScreenHeader title="Settings" />

      <Card as="article" className="grid gap-3">
        <SectionTitle as="h2" className="mt-0">
          Theme
        </SectionTitle>
        <p className="text-sm text-muted">Light is easiest to read outdoors. Your choice is kept on this phone.</p>
        <PeriodTabs periods={THEMES} value={dark ? "dark" : "light"} onChange={setTheme} label="Theme" />
      </Card>

      <Card as="article" className="flex items-center gap-4">
        <Avatar name={shop.name} size="lg" />
        <div>
          <SectionTitle as="h2" className="mt-0">
            {shop.name}
          </SectionTitle>
          <p className="text-sm text-muted">{shop.demo ? "Demo shop · fake data only" : `Shop ID: ${shop.id}`}</p>
        </div>
      </Card>

      <Card as="article" className="flex items-center gap-4">
        <IconCircle icon={ShieldCheck} tone="lavender" />
        <p className="text-muted">PocketOga only suggests. Nothing is saved until you tap Save, and saved records are never edited: fixes are added as corrections.</p>
      </Card>

      {installEvent && (
        <Button variant="secondary" onClick={() => installEvent.prompt()}>
          <Download aria-hidden="true" /> Install PocketOga on this phone
        </Button>
      )}

      <Button variant="quiet" onClick={onExit}>
        <LogOut aria-hidden="true" /> Leave this shop
      </Button>
    </section>
  );
}
