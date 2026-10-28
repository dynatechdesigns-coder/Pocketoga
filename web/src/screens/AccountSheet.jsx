import { useEffect, useState } from "react";
import { Download, LogOut, ShieldCheck } from "lucide-react";
import { Avatar, Button, Card, IconCircle, SectionTitle, Sheet } from "../ui.jsx";

// Opened from the avatar in the top bar: the shop, installing the app, and
// leaving the shop.
export default function AccountSheet({ open, shop, onClose, onExit }) {
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
    <Sheet open={open} onClose={onClose} title="Account">
      <div className="grid gap-4">
        <Card as="article" className="flex items-center gap-4">
          <Avatar name={shop.name} size="lg" />
          <div>
            <SectionTitle as="h3" className="mt-0">
              {shop.name}
            </SectionTitle>
            <p className="text-sm text-muted">{shop.demo ? "Demo shop · fake data only" : `Shop ID: ${shop.id}`}</p>
          </div>
        </Card>

        <Card as="article" className="flex items-center gap-4">
          <IconCircle icon={ShieldCheck} tone="lavender" />
          <p className="text-muted">
            PocketOga only suggests. Nothing is saved until you tap Save, and saved records can never be edited.
          </p>
        </Card>

        {installEvent && (
          <Button variant="secondary" onClick={() => installEvent.prompt()}>
            <Download aria-hidden="true" /> Install PocketOga on this phone
          </Button>
        )}

        <Button variant="quiet" onClick={onExit}>
          <LogOut aria-hidden="true" /> Leave this shop
        </Button>
      </div>
    </Sheet>
  );
}
