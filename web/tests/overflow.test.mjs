// Web tests that guard against sideways scrolling: no fixed widths in the rows
// that hold recorders, queued notes and forms, flexible children that can
// shrink, the 48px Cancel button, and one width rule per Button. There is no
// browser here, so the markup is checked from its source. The cause is fixed in
// the markup; the body's overflow-x rule is only a last resort.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, test } from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const walk = (dir) =>
  readdirSync(new URL(dir, root)).flatMap((n) => {
    const rel = `${dir}${n}`;
    return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : rel.endsWith(".jsx") ? [rel] : [];
  });
const feedback = read("FeedbackSection.jsx");

describe("the recording row", () => {
  test("is a flex row inside the card that can shrink", () => {
    assert.match(feedback, /\(recording \? \(\s*<div className="flex min-w-0 items-center gap-2">/);
  });

  test("the Recording pill takes the remaining width and may shrink (flex-1, min-w-0, truncating text)", () => {
    const stop = feedback.match(/data-part="feedback-stop"[^]*?className="([^"]*)"/)[1].replace(/\[&_svg\]:\S+/g, ""); // the icon inside may be shrink-0
    assert.match(stop, /\bflex-1\b/);
    assert.match(stop, /\bmin-w-0\b/);
    assert.doesNotMatch(stop, /\bw-full\b|\bw-\[|\bshrink-0\b/);
    assert.match(feedback, /<span className="min-w-0 truncate tabular-nums">Recording /);
  });

  test("Cancel is a fixed 48px square X button that never shrinks, labelled 'Cancel recording'", () => {
    const at = feedback.indexOf('data-part="feedback-cancel-recording"');
    const tag = feedback.slice(at - 60, feedback.indexOf("</button>", at));
    assert.match(tag, /aria-label="Cancel recording"/);
    assert.match(tag, /className="[^"]*\bsize-12\b[^"]*\bshrink-0\b|className="[^"]*\bshrink-0\b[^"]*\bsize-12\b/); // 48px x 48px
    assert.match(tag, /<X aria-hidden="true" \/>/);
    assert.doesNotMatch(tag, /\bw-full\b|\bw-auto\b|\bpx-\d|\bflex-1\b|<Button/);
  });

  test("both are plain buttons, so no competing width class can come from the shared Button", () => {
    const at = feedback.indexOf('data-part="feedback-stop"');
    assert.doesNotMatch(feedback.slice(at - 60, feedback.indexOf("</div>", at)), /<Button/);
  });
});

describe("the other rows", () => {
  test("'Record a voice message' / 'Record again' can shrink and centres its wrapping text", () => {
    assert.match(feedback, /data-part="feedback-mic" variant="quiet" className="min-w-0 text-center"/);
  });

  test("the voice-ready chip wraps instead of overflowing", () => {
    assert.match(feedback, /data-part="feedback-audio" className="flex flex-wrap items-center justify-between gap-2/);
  });

  test("the rating stars fit inside the card at 320px (5 x 44px + gaps, inside gutters and card padding)", () => {
    assert.match(feedback, /grid size-11 shrink-0/);
    assert.ok(5 * 44 + 4 * 4 <= 320 - 2 * 20 - 2 * 20);
  });

  test("Waiting to send: the text column shrinks, Cancel is a fixed 44px, rows can shrink", () => {
    const w = read("WaitingToSend.jsx");
    assert.match(w, /data-part="waiting-to-send"[^>]*className="grid min-w-0 gap-3/);
    assert.match(w, /<div className="grid min-w-0 flex-1 gap-0\.5">/);
    assert.match(w, /data-part="queued-cancel"[^]*?className="grid size-11 shrink-0/);
    assert.match(w, /<li [^>]*className="min-w-0 /);
  });

  test("the hand-entry form is one shrinking column", () => {
    assert.match(read("ManualEntry.jsx"), /data-part="manual-form"[^>]*className="grid min-w-0 gap-4"/);
  });

  test("the Record screen's Cancel sits 68px right of the 152px mic: 76 + 20 + 48 = 144px from the centre, inside 160px", () => {
    assert.match(read("screens/RecordScreen.jsx"), /absolute top-1\/2 -right-\[68px\] grid size-12/);
    assert.ok(76 + 68 <= 160);
  });
});

describe("Button has one width rule", () => {
  const buttonSource = () => {
    const ui = read("ui.jsx");
    return ui.slice(ui.indexOf("export function Button"), ui.indexOf("export const inputClass"));
  };

  test("full width unless the caller sets its own width, so w-full never competes with w-auto", () => {
    const b = buttonSource();
    assert.match(b, /const ownWidth = \/\(\^\|\\s\)!\?w-\/\.test\(className \?\? ""\);/);
    assert.match(b, /!ownWidth && "w-full"/);
    assert.doesNotMatch(b, /"inline-flex min-h-12 w-full/);
  });

  test("no class string in the app carries both w-full and w-auto", () => {
    for (const file of walk("")) {
      for (const m of read(file).matchAll(/className="([^"]*)"/g)) {
        assert.ok(!(/(^|\s)w-full(\s|$)/.test(m[1]) && /(^|\s)!?w-auto!?(\s|$)/.test(m[1])), `${file}: ${m[1]}`);
      }
    }
  });

  test("no Button is given two width classes", () => {
    for (const file of walk("")) {
      for (const m of read(file).matchAll(/<Button[^>]*?className="([^"]*)"/g)) {
        const widths = m[1].split(/\s+/).filter((c) => /^!?w-/.test(c));
        assert.ok(widths.length <= 1, `${file}: ${m[1]}`);
      }
    }
  });
});

describe("Settings and the Feedback card", () => {
  const settings = read("screens/SettingsScreen.jsx");

  test("no fixed widths in the Feedback card or Settings", () => {
    for (const [name, src] of [["FeedbackSection", feedback], ["SettingsScreen", settings]]) {
      assert.doesNotMatch(src, /\b(min-|max-)?w-\[\d+(px|rem)?\]|\bw-screen\b|\bw-\[100vw\]/, name);
    }
  });

  test("every flex-1 child in the Feedback card can shrink", () => {
    const flexible = [...feedback.matchAll(/className="([^"]*\bflex-1\b[^"]*)"/g)];
    assert.ok(flexible.length >= 2);
    for (const m of flexible) assert.match(m[1], /\bmin-w-0\b/, m[1]);
  });

  test("long words wrap in errors and the thank-you text", () => {
    assert.match(feedback, /data-part="feedback-error"[^>]*\[overflow-wrap:anywhere\]/);
    assert.match(feedback, /blockquote className="[^"]*\[overflow-wrap:anywhere\]/);
  });

  test("the stylesheet's body overflow-x is not the fix: the rows above stay inside by themselves", () => {
    assert.match(feedback, /min-w-0/);
    assert.match(read("index.css"), /overflow-x: hidden/); // still there as a last resort
  });
});

describe("the text box", () => {
  test("the placeholder no longer repeats the card's subtitle", () => {
    assert.match(feedback, /placeholder="Write your feedback here"/);
    assert.equal((feedback.match(/Tell us what to fix or add/g) ?? []).length, 1); // only the card's subtitle
  });
});
