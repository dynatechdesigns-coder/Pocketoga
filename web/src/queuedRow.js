// What one row of "Waiting to send" says, on separate lines: the item's name,
// when it was recorded, and its status. Plain JavaScript so it is tested.
import { correctionSummary } from "./entryCorrection.js";
import { manualSummary } from "./manualEntry.js";

const NAMES = { text: "Typed note", audio: "Voice note", photo: "Alert photo", manual: "Entered by hand", correction: "Edit to an entry" };

export function queuedRow(item, timeLabel) {
  const stuck = item.status === "needs-you";
  const name = NAMES[item.kind] ?? NAMES.text;
  return {
    name,
    // A typed note shows its own words (all of them, wrapped); others have none.
    detail: item.kind === "manual" ? manualSummary(item.payload?.entry) : item.kind === "correction" ? correctionSummary(item.payload) : item.kind === "text" && typeof item.payload?.text === "string" ? item.payload.text.trim() : null,
    recorded: `Recorded ${timeLabel(item.spokenAt)}`,
    status: stuck ? "Needs you" : "Waiting",
    stuck,
    error: stuck ? item.error : null,
    cancelLabel: "Cancel this item",
    cancelHint: `${name} recorded ${timeLabel(item.spokenAt)}`,
  };
}
