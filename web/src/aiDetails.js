// "How the AI did this": the rows under the confirm card, from the proposal's ai
// block { heard { model, ms }, understood { model, ms }, secondOpinion { model,
// ms, result: "agreed" | "differs" | "not ready" | "off" } }. Metadata only: no
// text, ids or keys are ever shown. A row with nothing to say is left out.
// Plain JavaScript so the web tests can run it.

export const AI_TITLE = "How the AI did this";

const RESULT_WORDS = {
  agreed: "agreed",
  differs: "differs, please check",
  "not ready": "not ready",
  off: "off",
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

// -> [{ key, label, text, warn }] in the order Heard, Understood, Second opinion.
export function aiRows(proposal, { photo = false } = {}) {
  const ai = proposal?.ai;
  if (!ai || typeof ai !== "object") return [];
  const rows = [];
  // A photo has no spoken part: its reading is the "understood" step.
  const steps = photo ? [["understood", "Read the photo"]] : [["heard", "Heard"], ["understood", "Understood"]];
  for (const [key, label] of steps) {
    const model = modelName(ai[key]?.model);
    if (model) rows.push({ key, label, text: withTime(model, ai[key].ms), warn: false });
  }
  const second = ai.secondOpinion;
  const result = RESULT_WORDS[second?.result];
  if (result && !(photo && second.result === "off")) {
    const model = modelName(second.model);
    rows.push({
      key: "second",
      label: "Second opinion",
      text: model ? `${model} (${result})` : result,
      warn: second.result === "differs",
    });
  }
  return rows;
}
