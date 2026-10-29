// The landing page's WhatsApp mockup must say exactly what the real bot says.
//
//   npm run check:copy
//
// Renders the demo note through the bot's own message builders (messages.mjs,
// read only) and compares with the text the landing page shows
// (src/landing/whatsappDemo.js). Also checks the web phone's before/after
// numbers follow from the same entries. Exits 1 on any difference.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = resolve(new URL("../..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const bot = await import(pathToFileURL(resolve(repo, "messages.mjs")));
const demo = await import(new URL("../src/landing/whatsappDemo.js", import.meta.url));

const problems = [];
const same = (label, want, got) => {
  if (want !== got) problems.push(`${label} differs:\n--- bot ---\n${want}\n--- landing ---\n${got}`);
};

const card = bot.renderProposalCard(demo.DEMO_PROPOSAL, { existing: [], shopId: "demo" });
same("reply card", card.text, demo.CARD_TEXT);
same("card buttons", card.buttons.map((b) => b.reply.title).join("|"), demo.CARD_BUTTONS.join("|"));
same("saved reply", bot.renderSavedReply({ recorded: demo.DEMO_RECORDED, existing: demo.DEMO_RECORDED }), demo.SAVED_TEXT);

// The web phone: sold grows by the sale, collected by the payment, owed by
// what Ada still owes (integer kobo throughout).
const sale = demo.DEMO_PROPOSAL.entries.filter((e) => e.type === "sale").reduce((t, e) => t + e.amountKobo, 0);
const paid = demo.DEMO_PROPOSAL.entries.filter((e) => e.type === "payment").reduce((t, e) => t + e.amountKobo, 0);
const { WEB_BEFORE: b, WEB_AFTER: a } = demo;
if (a.soldKobo - b.soldKobo !== sale) problems.push(`web phone: sold should grow by ${sale}`);
if (a.collectedKobo - b.collectedKobo !== paid) problems.push(`web phone: collected should grow by ${paid}`);
if (a.owedKobo - b.owedKobo !== sale - paid) problems.push(`web phone: owed should grow by ${sale - paid}`);

if (problems.length) {
  console.error("FAIL: the landing page's WhatsApp mockup does not match the bot\n" + problems.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log("PASS: reply card, buttons and saved reply match messages.mjs exactly; web phone numbers follow from the same entries.");
}
