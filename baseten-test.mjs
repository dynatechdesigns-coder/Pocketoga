const res = await fetch("https://inference.baseten.co/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.BASETEN_API_KEY}`,
  },
  body: JSON.stringify({
    model: "meta-models/muse-spark-open-1026",
    max_tokens: 2000,
    messages: [{ role: "user", content: "Say hello in Nigerian Pidgin." }],
  }),
});

const data = await res.json();
const choice = data.choices?.[0];
const msg = choice?.message ?? {};

console.log("STATUS:", res.status);
console.log("FINISH REASON:", choice?.finish_reason);
console.log("MESSAGE FIELDS:", Object.keys(msg).join(", "));

for (const [key, value] of Object.entries(msg)) {
  if (typeof value === "string") {
    console.log(`FIELD ${key}: ${value.length} chars`);
  }
}

// Try to find the clean final answer
let content = msg.content ?? "";
let answer = content;
const markers = ["</think>", "assistantfinal", "<|channel|>final<|message|>", "Final answer:"];
for (const m of markers) {
  const i = content.lastIndexOf(m);
  if (i !== -1) {
    answer = content.slice(i + m.length);
    console.log("FOUND MARKER:", m);
    break;
  }
}

console.log("\n=== ANSWER (last 300 chars) ===");
console.log(answer.trim().slice(-300));

if (!res.ok) console.log("ERROR:", JSON.stringify(data).slice(0, 500));