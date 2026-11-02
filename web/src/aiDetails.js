// "How the AI did this": the rows under the confirm card, from the proposal's ai
// block { heard { model, ms }, understood { model, ms }, secondOpinion { model,
// ms, result: "agreed" | "differs" | "not ready" | "off" } }. Metadata only: no
// text, ids or keys are ever shown. A row with nothing to say is left out.
// Plain JavaScript so the web tests can run it.

export const AI_TITLE = "How the AI did this";

// The second opinion in plain words. "off" has no words: the row is hidden.
const RESULT_WORDS = {
  agreed: "agreed",
  differs: "differs, please check",
  "not ready": "didn't answer in time (nothing was blocked)",
};

// 1234 -> "1.2 s", 40 -> "0.0 s"... whole tenths from integer maths.
export function secondsText(ms) {
  if (!Number.isInteger(ms) || ms <= 0) return "";
  const tenths = Math.max(1, Math.round(ms / 100));
  return `${Math.floor(tenths / 10)}.${tenths % 10} s`;
}

// A model name is shown as a short plain label; anything that is not a short
// name made of letters, digits and . - _ / is not shown.
function modelName(model) {
  const m = typeof model === "string" ? model.trim() : "";
  return m && m.length <= 60 && /^[\w./:-]+$/.test(m) ? m : null;
}

const withTime = (model, ms) => {
  const secs = secondsText(ms);
  return secs ? `${model} (${secs})` : model;
};

// -> [{ key, label, text, sub, warn }] in the order Heard, Understood, Second
// opinion. `sub` is a smaller second line (the second opinion's model name).
// When the same model heard and understood a voice note it is ONE row, with the
// two times added together.
export function aiRows(proposal, { photo = false } = {}) {
  const ai = proposal?.ai;
  if (!ai || typeof ai !== "object") return [];
  const rows = [];
  const heard = modelName(ai.heard?.model);
  const understood = modelName(ai.understood?.model);
  if (photo) {
    // A photo has no spoken part: its reading is the "understood" step.
    if (understood) rows.push({ key: "understood", label: "Read the photo", text: withTime(understood, ai.understood.ms), sub: null, warn: false });
  } else if (heard && heard === understood) {
    const ms = [ai.heard.ms, ai.understood.ms].every(Number.isInteger) ? ai.heard.ms + ai.understood.ms : undefined;
    rows.push({ key: "heard", label: "Heard and understood", text: withTime(heard, ms), sub: null, warn: false });
  } else {
    if (heard) rows.push({ key: "heard", label: "Heard", text: withTime(heard, ai.heard.ms), sub: null, warn: false });
    if (understood) rows.push({ key: "understood", label: "Understood", text: withTime(understood, ai.understood.ms), sub: null, warn: false });
  }
  const second = ai.secondOpinion;
  const result = RESULT_WORDS[second?.result];
  if (result) {
    rows.push({ key: "second", label: "Second opinion", text: result, sub: modelName(second.model), warn: second.result === "differs" });
  }
  return rows;
}
