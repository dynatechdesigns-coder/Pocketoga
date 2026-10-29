// "Fix this entry" may show only on the shop's latest uncorrected entry,
// and correct-last failures must read as plain sentences, never raw errors.
//
//   npm run check:fix
//
// Fake entries only. Exits 1 on any difference.
import { fixableEntryId } from "../src/ledger.js";
import { ApiError, friendlyError } from "../src/api.js";

const problems = [];
const same = (label, want, got) => {
  if (want !== got) problems.push(`${label}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const entry = (id, seq, type = "sale", over = {}) => ({ id, seq, type, corrects_id: null, correctedById: null, ...over });

// Latest and uncorrected shows it; the list order must not matter.
same("latest shows", 2, fixableEntryId([entry(2, 2), entry(1, 1)]));
same("latest shows (reversed)", 2, fixableEntryId([entry(1, 1), entry(2, 2)]));
// Older entries never show it.
same("older hides", 3, fixableEntryId([entry(1, 1), entry(2, 2), entry(3, 3)]));
// A correction entry never shows it, even as the latest row.
same(
  "correction hides",
  null,
  fixableEntryId([entry(1, 1), { ...entry(2, 2), type: "correction", corrects_id: 1 }])
);
// An already-corrected latest hides it, by correctedById or corrects_id links.
same(
  "corrected hides (correctedById)",
  null,
  fixableEntryId([entry(1, 1), { ...entry(2, 2), correctedById: 3 }, { ...entry(3, 3), type: "correction", corrects_id: 2, correctedById: null }])
);
same(
  "corrected hides (corrects_id fallback)",
  null,
  fixableEntryId([
    { id: 1, seq: 1, type: "sale", corrects_id: null },
    { id: 2, seq: 2, type: "sale", corrects_id: null },
    { id: 3, seq: 3, type: "correction", corrects_id: 2 },
  ])
);
// After a correction the button disappears (the latest row is a correction);
// when a newer sale lands, it moves there.
same("after correction hides", null, fixableEntryId([entry(1, 1), { ...entry(2, 2), correctedById: 3 }, { ...entry(3, 3), type: "correction", corrects_id: 2 }]));
same(
  "moves to the new latest",
  4,
  fixableEntryId([entry(1, 1), { ...entry(2, 2), correctedById: 3 }, { ...entry(3, 3), type: "correction", corrects_id: 2 }, entry(4, 4)])
);
// Empty ledger, and seq ties broken by id as the server picks latest.
same("empty hides", null, fixableEntryId([]));
same("seq tie picks higher id", 8, fixableEntryId([entry(7, 2), entry(8, 2)]));

// Correct-last failures read as plain sentences; older wordings unchanged.
const msg = (status, message) => friendlyError(new ApiError(status, message));
same("nothing to correct", "There is nothing to correct yet.", msg(404, "shop demo has no entries to correct"));
same("already corrected", "This entry was already corrected.", msg(409, "entry 2 was already corrected"));
same("not latest", "A newer entry came in first. Only the latest entry can be fixed.", msg(409, "entry 1 is not the shop's latest entry"));
same("network", "Cannot reach PocketOga. Check your connection and try again.", msg(0, "network"));
same("saved note still", "This note is already saved. To change it, record a new note.", msg(409, "proposal 1 is already confirmed; send a new note to correct it"));
same("rejected note still", "This note was rejected. Please record it again.", msg(409, "proposal 1 was rejected"));
same("missing still", "We could not find that. Please try again.", msg(404, "entry 9 not found"));

if (problems.length) {
  console.error("FAIL: ledger fix rules\n" + problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("PASS: fix button shows only on the latest uncorrected entry; correct-last errors read plain.");
}
