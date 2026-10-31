import { useSyncExternalStore } from "react";
import { ChevronRight, Download, Share } from "lucide-react";
import { IOS_STEPS, install } from "./install.js";
import { IconCircle, Sheet } from "./ui.jsx";

// One row in the More sheet, only where installing is possible (Chrome gets
// the browser's own dialog, iPhone and iPad Safari get the steps). Nothing
// shows on the home screen.
export default function InstallRow({ onClose, onSteps }) {
  useSyncExternalStore(install.subscribe, install.get); // re-render when the prompt arrives or the app is installed
  let kind = null;
  try {
    kind = install.kind();
  } catch {
    kind = null;
  }
  if (!kind) return null;

  async function tap() {
    try {
      if (kind === "ios") {
        onClose();
        onSteps();
        return;
      }
      await install.prompt();
      onClose();
    } catch {
      // a failed prompt never breaks the menu
    }
  }

  return (
    <li>
      <button
        type="button"
        data-part="install-row"
        data-kind={kind}
        onClick={tap}
        className="flex min-h-16 w-full items-center gap-3.5 rounded-card border border-line bg-card px-4 py-2.5 text-left shadow-soft transition-transform duration-150 active:scale-[0.98]"
      >
        <IconCircle icon={Download} tone="lavender" />
        <span className="grid min-w-0 flex-1">
          <span className="font-bold">Install PocketOga</span>
          <span className="text-sm text-muted">{kind === "ios" ? "Add it to your home screen" : "Open it like an app, even with no signal"}</span>
        </span>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-grey" />
      </button>
    </li>
  );
}

// The iPhone and iPad steps, in plain words.
export function InstallSteps({ open, onClose }) {
  return (
    <Sheet open={open} onClose={onClose} title="Install PocketOga">
      <ol data-part="install-steps" className="grid gap-3">
        {IOS_STEPS.map((text, i) => (
          <li key={text} className="flex items-start gap-3 rounded-card border border-line bg-card p-4">
            <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-lavender font-extrabold text-link">
              {i + 1}
            </span>
            <span className="min-w-0 pt-0.5 [overflow-wrap:anywhere]">
              {i === 0 && <Share aria-hidden="true" className="mr-1.5 mb-0.5 inline size-5 text-link" />}
              {text}
            </span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}
