import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkModelOutput } from "./voice.mjs";
import {
  MAX_BODY_CHARS,
  REJECTED,
  FIX_ASK,
  ALREADY_SAVED,
  NOT_REGISTERED,
  UNSUPPORTED,
  EXPIRED_PROPOSAL,
  GENERIC_ERROR,
  UNKNOWN_BUTTON,
  PROPOSAL_NOT_FOUND,
  OTHER_SHOP,
  FFMPEG_MISSING,
  AUDIO_FAILED,
  HEAR_FAILED,
  BAD_AUDIO_JSON,
  CORRECTION_AS_TEXT,
  FIX_LAST_HELP,
  FIX_LAST_NO_ENTRIES,
  FIX_LAST_ALREADY_FIXED,
  alreadyConfirmedFix,
  friendlyErrorText,
  escapeMd,
  heardLine,
  dedupeChecks,
  customerOwedKobo,
  renderProposalCard,
  renderSavedReply,
} from "./messages.mjs";

// Fake fixtures only. Golden tests pin the exact trader-facing text.
const SHOP = "test-shop";

function proposal(id, raw) {
  const { heard, question, ...envelope } = checkModelOutput(raw, SHOP);
  return { id, shop_id: SHOP, status: "pending", heard, question, ...envelope };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const saleEntry = (over = {}) => ({
  type: "sale",
  customer: "Ada",
  item: "rice",
  unit: "bag",
  quantity: 2,
  amountNaira: 15000,
  amountPhrase: "15k",
  priceBasis: "total",
  ...over,
});

const paymentEntry = (over = {}) => ({
  type: "payment",
  customer: "Ada",
  item: null,
  quantity: null,
  unit: null,
  amountNaira: 10000,
  amountPhrase: "10k",
  priceBasis: "total",
  ...over,
});

const HISTORY = [
  { type: "sale", amount_kobo: 2000000, customer: "Ada" },
  { type: "payment", amount_kobo: 500000, customer: "Ada" },
];

describe("message goldens (fake data)", () => {
  it("clean sale with an each-price", () => {
    const p = proposal(1, {
      heard: "Ada buy rice 2 bags, na 15k each.",
      entries: [saleEntry({ priceBasis: "each" })],
      totals: null,
      question: null,
    });
    const card = renderProposalCard(p, { existing: [], shopId: SHOP });
    assert.equal(
      card.text,
      `🛒 *Ada*\n\n2 bags of rice × ₦15,000 = *₦30,000*\n\n⚖️ Ada owes *₦30,000* after saving\n\n_"Ada buy rice 2 bags, na 15k each."_`
    );
    assert.deepEqual(
      card.buttons.map((b) => b.reply.id),
      ["confirm:1", "fix:1", "reject:1"]
    );
    assert.deepEqual(
      card.buttons.map((b) => b.reply.title),
      ["Save", "Fix", "Reject"]
    );
  });

  it("part payment adds shop history to the owes line", () => {
    const p = proposal(2, {
      heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k.",
      entries: [saleEntry(), paymentEntry()],
      totals: {
        totalNaira: 15000, totalPhrase: "15k",
        paidNaira: 10000, paidPhrase: "10k",
        remainderNaira: 5000, remainderPhrase: "remain 5k",
      },
      question: null,
    });
    const card = renderProposalCard(p, { existing: HISTORY, shopId: SHOP });
    assert.equal(
      card.text,
      `🛒 *Ada*\n\n2 bags of rice: *₦15,000*\n💵 Paid: *₦10,000*\n\n⚖️ Ada owes *₦20,000* after saving\n\n_"Ada buy rice 2 bags, na 15k. She pay 10k, remain 5k."_`
    );
  });

  it("correction card names the entry it fixes; normal cards are untouched", () => {
    const base = {
      heard: "make am 12k",
      entries: [saleEntry({ amountNaira: 12000, amountPhrase: "12k" })],
      totals: null,
      question: null,
    };
    const p = proposal(30, base);
    p.correctionOf = 7;
    const card = renderProposalCard(p, { existing: [], shopId: SHOP });
    assert.ok(card.text.startsWith("Fixes entry #7\n\n"), card.text);
    assert.deepEqual(
      card.buttons.map((b) => b.reply.id),
      ["confirm:30", "fix:30", "reject:30"]
    );

    const blocked = proposal(31, { ...base, question: "is that right?" });
    blocked.correctionOf = 7;
    const blockedText = renderProposalCard(blocked).text;
    assert.ok(blockedText.includes("⚠️ *Check this one*\n\nFixes entry #7\n\n"), blockedText);

    const plain = renderProposalCard(proposal(32, base), { existing: [], shopId: SHOP });
    assert.ok(!plain.text.includes("Fixes entry"), plain.text);
  });

  it("needs-checking card shows arithmetic then the flag once, no Save", () => {
    const p = proposal(3, {
      heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
      entries: [saleEntry(), paymentEntry()],
      totals: {
        totalNaira: 15000, totalPhrase: "15k",
        paidNaira: 10000, paidPhrase: "10k",
        remainderNaira: 4000, remainderPhrase: "remain 4k",
      },
      question: null,
    });
    const card = renderProposalCard(p);
    assert.equal(
      card.text,
      `⚠️ *Check this one*\n\n2 bags of rice: *₦15,000*\n💵 Paid: *₦10,000*\nTotal: *₦15,000*\nPaid: *₦10,000*\nRemainder: *₦4,000*\n\n₦15,000 − ₦10,000 = ₦5,000, but you said ₦4,000 remain. Which one na correct?\n\n_"Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k."_`
    );
    assert.deepEqual(
      card.buttons.map((b) => b.reply.id),
      ["fix:3", "reject:3"]
    );
    assert.ok(card.buttons.every((b) => !b.reply.id.startsWith("confirm:")));
  });

  it("remainder mismatch with a model question shows only the one code-built line", () => {
    const p = proposal(20, {
      heard: "Ada buy rice 2 bags, na 15k each. She pay 10k, remain 5k.",
      entries: [saleEntry({ priceBasis: "each" }), paymentEntry()],
      totals: null,
      question: "2 bags at 15k each na 30k, but 10k paid plus remain 5k na 15k, which total correct?",
    });
    const card = renderProposalCard(p);
    assert.equal(
      card.text,
      `⚠️ *Check this one*\n\n2 bags of rice × ₦15,000 = *₦30,000*\n💵 Paid: *₦10,000*\n\n₦30,000 − ₦10,000 = ₦20,000, but you said ₦5,000 remain. Which one na correct?\n\n_"Ada buy rice 2 bags, na 15k each. She pay 10k, remain 5k."_`
    );
    assert.deepEqual(
      card.buttons.map((b) => b.reply.id),
      ["fix:20", "reject:20"]
    );
    assert.ok(!card.text.includes("which total correct?"));
  });

  it("totals mismatch with a model question collapses to the same one line", () => {
    const p = proposal(21, {
      heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
      entries: [saleEntry(), paymentEntry()],
      totals: {
        totalNaira: 15000, totalPhrase: "15k",
        paidNaira: 10000, paidPhrase: "10k",
        remainderNaira: 4000, remainderPhrase: "remain 4k",
      },
      question: "15k total but 10k paid plus 4k remain na 14k, which total correct?",
    });
    const card = renderProposalCard(p);
    assert.equal(
      card.text,
      `⚠️ *Check this one*\n\n2 bags of rice: *₦15,000*\n💵 Paid: *₦10,000*\nTotal: *₦15,000*\nPaid: *₦10,000*\nRemainder: *₦4,000*\n\n₦15,000 − ₦10,000 = ₦5,000, but you said ₦4,000 remain. Which one na correct?\n\n_"Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k."_`
    );
    assert.ok(!card.text.includes("which total correct?"));
  });

  it("multi-entry note prefixes each line and skips settled customers", () => {
    const p = proposal(4, {
      heard: "Ada buy rice 1 bag na 8k and Bola pay 3k for garri.",
      entries: [saleEntry({ quantity: 1, amountNaira: 8000, amountPhrase: "8k" }), paymentEntry({ customer: "Bola", amountNaira: 3000, amountPhrase: "3k" })],
      totals: null,
      question: null,
    });
    const card = renderProposalCard(p, { existing: [], shopId: SHOP });
    assert.equal(
      card.text,
      `🛒 *Ada*\n\n*Ada*: 1 bag of rice: *₦8,000*\n*Bola*: 💵 Paid: *₦3,000*\n\n⚖️ Ada owes *₦8,000* after saving\n\n_"Ada buy rice 1 bag na 8k and Bola pay 3k for garri."_`
    );
  });

  it("markdown in the customer name cannot break the formatting", () => {
    const p = proposal(5, {
      heard: "Mama star buy beans 2 tins, na 4k.",
      entries: [saleEntry({ customer: "Mama *Nkechi* _Best_", item: "beans", unit: "tin", amountNaira: 4000, amountPhrase: "4k" })],
      totals: null,
      question: null,
    });
    const card = renderProposalCard(p, { existing: [], shopId: SHOP });
    assert.equal(
      card.text,
      `🛒 *Mama ＊Nkechi＊ ＿Best＿*\n\n2 tins of beans: *₦4,000*\n\n⚖️ Mama ＊Nkechi＊ ＿Best＿ owes *₦4,000* after saving\n\n_"Mama star buy beans 2 tins, na 4k."_`
    );
    assert.ok(!card.text.includes("*Nkechi*"));
    assert.ok(!card.text.includes("_Best_"));
    assert.equal(countOccurrences(card.text, "*") % 2, 0);
    assert.equal(countOccurrences(card.text, "_") % 2, 0);
  });

  it("very long heard text is trimmed to 120 characters with an ellipsis", () => {
    const p = proposal(6, {
      heard: "A".repeat(200),
      entries: [saleEntry()],
      totals: null,
      question: null,
    });
    const card = renderProposalCard(p, { existing: [], shopId: SHOP });
    const quote = `_"${"A".repeat(119)}…"_`;
    assert.ok(card.text.endsWith(quote));
    assert.equal(quote.length, 124); // 120 quoted chars plus _" "_ markers
  });

  it("saved reply summarizes per customer with the balance when owed", () => {
    const recorded = [
      { type: "sale", amount_kobo: 1500000, customer: "Ada", item: "rice", quantity: 2, unit: "bag" },
      { type: "payment", amount_kobo: 1000000, customer: "Ada", item: null, quantity: null, unit: null },
    ];
    assert.equal(
      renderSavedReply({ recorded, existing: [...HISTORY, ...recorded] }),
      `✅ *Saved*\n\n*Ada*: sale 2 bags of rice *₦15,000*, paid *₦10,000*\n\n⚖️ Ada owes *₦20,000*`
    );
  });

  it("kobo shows only when non-zero", () => {
    const recorded = [
      { type: "sale", amount_kobo: 125050, customer: "Ada", item: "rice", quantity: 1, unit: "bag" },
      { type: "payment", amount_kobo: 1000000, customer: "Ada", item: null, quantity: null, unit: null },
    ];
    assert.equal(
      renderSavedReply({ recorded, existing: recorded }),
      `✅ *Saved*\n\n*Ada*: sale 1 bag of rice *₦1,250.50*, paid *₦10,000*`
    );
  });
});

describe("message rules", () => {
  it("the question appears exactly once", () => {
    // Model's own question: echoed once as a flag, not repeated after it.
    const asked = proposal(7, {
      heard: "Ada take something.",
      entries: [saleEntry({ quantity: 1, amountNaira: 8000, amountPhrase: "8k" })],
      totals: null,
      question: "How much remain?",
    });
    assert.deepEqual(dedupeChecks(asked), ["How much remain?"]);
    assert.equal(countOccurrences(renderProposalCard(asked).text, "How much remain?"), 1);

    // Code-built wrapper question: the flag shows once, the wrapper never.
    const mismatch = proposal(8, {
      heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
      entries: [saleEntry(), paymentEntry()],
      totals: {
        totalNaira: 15000, totalPhrase: "15k",
        paidNaira: 10000, paidPhrase: "10k",
        remainderNaira: 4000, remainderPhrase: "remain 4k",
      },
      question: null,
    });
    const flag = "₦15,000 − ₦10,000 = ₦5,000, but you said ₦4,000 remain. Which one na correct?";
    const text = renderProposalCard(mismatch).text;
    assert.equal(countOccurrences(text, flag), 1);
    assert.equal(countOccurrences(text, "Abeg check am"), 0);

    // Distinct question and flag: each appears once.
    const both = proposal(9, {
      heard: "Ada buy rice 2 bags each 15k.",
      entries: [saleEntry()],
      totals: null,
      question: "Is that correct?",
    });
    assert.ok(both.flags.length >= 2, `expected model echo plus code flag, got ${JSON.stringify(both.flags)}`);
    const bothText = renderProposalCard(both).text;
    assert.equal(countOccurrences(bothText, "Is that correct?"), 1);
    assert.equal(countOccurrences(bothText, 'note says "each" but the amount was read as a total'), 1);
  });

  it("the mismatch card has exactly one question", () => {
    const p = proposal(22, {
      heard: "Ada buy rice 2 bags, na 15k each. She pay 10k, remain 5k.",
      entries: [saleEntry({ priceBasis: "each" }), paymentEntry()],
      totals: null,
      question: "2 bags at 15k each na 30k, but 10k paid plus remain 5k na 15k, which total correct?",
    });
    const line = "₦30,000 − ₦10,000 = ₦20,000, but you said ₦5,000 remain. Which one na correct?";
    assert.deepEqual(dedupeChecks(p), [line]);
    const text = renderProposalCard(p).text;
    assert.equal(countOccurrences(text, line), 1);
    assert.equal(countOccurrences(text, "?"), 1);
    assert.ok(!text.includes("which total correct?"));
    assert.ok(!text.includes("numbers do not add up"));
  });

  it("balances match case-insensitively and hide zero or credit", () => {
    assert.equal(customerOwedKobo({ existing: [{ type: "sale", amount_kobo: 1000000, customer: "ada" }], customer: "Ada" }), 1000000);
    assert.equal(
      customerOwedKobo({
        existing: [{ type: "sale", amount_kobo: 1000000, customer: "Ada" }],
        proposalEntries: [{ type: "payment", amountKobo: 1000000, customer: "ADA" }],
        customer: "Ada",
      }),
      0
    );
    // Settled in full: no owes line.
    const settled = proposal(10, {
      heard: "Ada pay 10k.",
      entries: [paymentEntry()],
      totals: null,
      question: null,
    });
    const text = renderProposalCard(settled, {
      existing: [{ type: "sale", amount_kobo: 1000000, customer: "Ada" }],
      shopId: SHOP,
    }).text;
    assert.ok(!text.includes("owes"), text);
  });

  it("one-line replies are exact, short and nearly emoji-free", () => {
    assert.equal(REJECTED, "Not saved. Send a new note anytime.");
    assert.equal(FIX_ASK, "What should I change? Send the correction as text or a voice note.");
    assert.equal(alreadyConfirmedFix(12), "Proposal 12 is already confirmed; send a new note to correct it.");
    assert.equal(friendlyErrorText(Object.assign(new Error("proposal 3 expired; send the note again"), { status: 410 })), EXPIRED_PROPOSAL);
    assert.equal(friendlyErrorText(Object.assign(new Error("custom 400"), { status: 400 })), "custom 400");
    assert.equal(friendlyErrorText(new Error("boom")), GENERIC_ERROR);
    for (const line of [REJECTED, FIX_ASK, ALREADY_SAVED, NOT_REGISTERED, UNSUPPORTED, EXPIRED_PROPOSAL, UNKNOWN_BUTTON, PROPOSAL_NOT_FOUND, OTHER_SHOP, FFMPEG_MISSING, AUDIO_FAILED, HEAR_FAILED, BAD_AUDIO_JSON, CORRECTION_AS_TEXT]) {
      assert.ok(!/[🛒💵📦⚠️✅⚖️]/.test(line), `emoji in: ${line}`);
    }
    assert.ok(GENERIC_ERROR.startsWith("⚠️ "));
  });

  it("escapeMd neutralizes every WhatsApp formatting character", () => {
    assert.equal(escapeMd("*a_b~c`d*"), "＊a＿b～c｀d＊");
    assert.equal(escapeMd("plain Ada"), "plain Ada");
    assert.equal(heardLine("  spaced\nout  "), '_"spaced out"_');
    assert.equal(heardLine("x".repeat(200), 10), `_"${"x".repeat(9)}…"_`);
    assert.equal(heardLine("anything", 0), null);
  });

  it("no message exceeds 1024 characters and buttons stay short", () => {
    const bodies = [];
    const manyEntries = Array.from({ length: 40 }, (_, i) =>
      saleEntry({ customer: `Customer ${i}`, item: "rice", quantity: 3, amountNaira: 9000 + i, amountPhrase: null })
    );
    const big = proposal(11, { heard: "Long note. ".repeat(300), entries: manyEntries, totals: null, question: null });
    bodies.push(renderProposalCard(big).text);
    const bigBlocked = proposal(12, {
      heard: "Long note. ".repeat(300),
      entries: manyEntries,
      totals: { totalNaira: 1, totalPhrase: null, paidNaira: 2, paidPhrase: null, remainderNaira: 3, remainderPhrase: null },
      question: null,
    });
    bodies.push(renderProposalCard(bigBlocked).text);
    bodies.push(
      renderSavedReply({
        recorded: manyEntries.map((e) => ({ type: "sale", amount_kobo: e.amountNaira * 100, customer: e.customer, item: e.item, quantity: e.quantity, unit: e.unit })),
        existing: [],
      })
    );
    for (const line of [REJECTED, FIX_ASK, ALREADY_SAVED, NOT_REGISTERED, UNSUPPORTED, EXPIRED_PROPOSAL, GENERIC_ERROR, UNKNOWN_BUTTON, PROPOSAL_NOT_FOUND, OTHER_SHOP, FFMPEG_MISSING, AUDIO_FAILED, HEAR_FAILED, BAD_AUDIO_JSON, CORRECTION_AS_TEXT, FIX_LAST_HELP, FIX_LAST_NO_ENTRIES, FIX_LAST_ALREADY_FIXED]) {
      bodies.push(line);
    }
    for (const body of bodies) assert.ok(body.length <= MAX_BODY_CHARS, `over limit (${body.length}): ${body.slice(0, 80)}`);
    for (const card of [renderProposalCard(big), renderProposalCard(bigBlocked)]) {
      for (const b of card.buttons) assert.ok(b.reply.title.length < 20, `title too long: ${b.reply.title}`);
    }
    // Stress card still fits because the heard quote shrinks first.
    assert.ok(!renderProposalCard(big).text.includes("Long note. ".repeat(10)));
  });

  it("messages never contain phone numbers, tokens or secrets", () => {
    const token = "sk-test-canary-token-zzz";
    const phone = "2348012345678";
    process.env.WHATSAPP_TOKEN = token;
    try {
      const p = proposal(13, {
        heard: "Ada buy rice 2 bags, na 15k.",
        entries: [saleEntry({ amountNaira: 12345678, amountPhrase: null })],
        totals: null,
        question: null,
      });
      const bodies = [
        renderProposalCard(p, { existing: HISTORY, shopId: SHOP }).text,
        renderSavedReply({
          recorded: [{ type: "sale", amount_kobo: 1234567800, customer: "Ada", item: "rice", quantity: 2, unit: "bag" }],
          existing: HISTORY,
        }),
        REJECTED, FIX_ASK, ALREADY_SAVED, NOT_REGISTERED, UNSUPPORTED, EXPIRED_PROPOSAL,
        GENERIC_ERROR, UNKNOWN_BUTTON, PROPOSAL_NOT_FOUND, OTHER_SHOP,
        FIX_LAST_HELP, FIX_LAST_NO_ENTRIES, FIX_LAST_ALREADY_FIXED,
      ];
      for (const body of bodies) {
        assert.ok(!/\d{7,}/.test(body), `digit run in: ${body.slice(0, 120)}`);
        assert.ok(!body.includes(token), "token leaked into message");
        assert.ok(!body.includes(phone), "phone number leaked into message");
      }
    } finally {
      delete process.env.WHATSAPP_TOKEN;
    }
  });

  it("cards use only the allowed emoji set", () => {
    const p = proposal(14, {
      heard: "Ada buy rice 2 bags, na 15k. She pay 10k, remain 4k.",
      entries: [saleEntry(), paymentEntry()],
      totals: {
        totalNaira: 15000, totalPhrase: "15k",
        paidNaira: 10000, paidPhrase: "10k",
        remainderNaira: 4000, remainderPhrase: "remain 4k",
      },
      question: null,
    });
    const clean = proposal(15, {
      heard: "Ada buy rice 2 bags, na 15k.",
      entries: [saleEntry()],
      totals: null,
      question: null,
    });
    for (const text of [renderProposalCard(p).text, renderProposalCard(clean, { existing: HISTORY, shopId: SHOP }).text]) {
      // ❓/❔ and the old bare warning sign are out; ⚠️ (with VS16) is allowed.
      assert.ok(!/[❓❔]/.test(text), `old emoji in: ${text.slice(0, 120)}`);
      assert.ok(!/⚠(?!\uFE0F)/.test(text), `old emoji in: ${text.slice(0, 120)}`);
    }
  });
});
