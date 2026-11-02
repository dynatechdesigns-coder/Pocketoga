import { Info } from "lucide-react";
import { Button, Card } from "./ui.jsx";

// A calm notice for a limit (HTTP 429): a plain sentence and an OK button. Not
// red, not a crash, no code. The message is the server's own text or ours.
export default function LimitNotice({ message, onOk, className }) {
  return (
    <Card data-part="limit-notice" role="status" className={`grid min-w-0 gap-3 border-line bg-lavender ${className ?? ""}`}>
      <p className="flex min-w-0 items-start gap-2.5 font-semibold [overflow-wrap:anywhere] [&_svg]:mt-0.5 [&_svg]:size-5 [&_svg]:shrink-0">
        <Info aria-hidden="true" /> <span className="min-w-0">{message}</span>
      </p>
      <Button data-part="limit-ok" variant="secondary" onClick={onOk}>
        OK
      </Button>
    </Card>
  );
}
