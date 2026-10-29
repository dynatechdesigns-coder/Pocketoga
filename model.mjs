// Meta Model API client (OpenAI-compatible) plus an injectable mock for tests.
//
// Model ids verified against dev.meta.ai docs roundups (Oct 2026):
// - muse-spark-1.3: text reasoning/extraction. Audio input is NOT supported
//   on the 1.3 checkpoints.
// - muse-spark-1.2: still the checkpoint to use for audio input.
// Audio uses the OpenAI-compatible input_audio part:
//   { type: "input_audio", input_audio: { data: base64, format: "wav" } }
// Images use the OpenAI-compatible image_url part on the 1.3 checkpoint
// (dev.meta.ai/docs/image-understanding):
//   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }

export const META_BASE_URL = "https://api.meta.ai/v1";
export const TEXT_MODEL = "muse-spark-1.3";
export const AUDIO_MODEL = "muse-spark-1.2";

export const SYSTEM_PROMPT = `You are PocketOga, a bookkeeping assistant for Nigerian market traders. You understand English and Nigerian Pidgin. You only propose entries; you never save, confirm, or compute totals — plain code checks your work.
Reply with JSON only, exactly this shape:
{
  "heard": "what the trader said, in their own words",
  "entries": [
    {"type": "sale", "customer": "name or null", "item": "rice or null", "unit": "bag or null", "quantity": 2, "amountNaira": 15000, "amountPhrase": "15k", "priceBasis": "total"}
  ],
  "totals": {"totalNaira": 15000, "totalPhrase": "15k", "paidNaira": 10000, "paidPhrase": "10k", "remainderNaira": 5000, "remainderPhrase": "remain 5k"},
  "promise": {"customer": "Ada or null", "datePhrase": "Friday", "amountNaira": 20000},
  "question": "a short clarifying question, or null"
}
Rules:
- Entry types are only: sale (goods sold), payment (money received), restock (stock bought), expense (money spent). A sale with part payment is TWO entries: a sale for the full total and a payment for what was paid.
- "k" means thousand naira ("15k" = 15000). "remain 3k" means a 3000 naira remainder is still owed.
- amountNaira and every totals leg are whole naira integers, never negative. amountPhrase is the trader's exact words for that amount. Fill totals only when the note states total, paid and remainder figures.
- priceBasis says whether amountNaira is per item ("each"), for the whole lot ("total"), or "unclear" when the note does not say. "15k each" is each; a payment or an expense is always a total. Never guess: use "unclear".
- An expense carries its category in item (one of: transport, rent, power, wages, stock-related, other), the payee in customer (or null when the shop itself paid), the whole-naira amount in amountNaira, priceBasis "total", and quantity and unit null.
- promise captures when the trader says a customer will pay ("she go pay Friday", "he promise 20k by month end"): the customer name, the trader's exact day-words in datePhrase, and amountNaira (whole naira, or null when no amount is said). Never resolve the day into a date yourself; plain code does that. Null when the note states no promise.
- quantity is a positive integer count of items, or null when the note has none.
- unit is the container or count word in singular form, separate from item: "2 bags of rice" is item "rice", unit "bag", quantity 2; "3 tins of milk" is item "milk", unit "tin", quantity 3. Null when the note names none.
- Never invent names, items, or amounts. If anything essential is missing or unclear, put it in question and leave the field null.
- If the note has no bookkeeping content, return "entries": [] with a question.`;

const FIX_SUFFIX =
  "The trader is correcting your previous proposal (included below with their correction). Return the full revised JSON in the same shape.";

function badJson(message) {
  return Object.assign(new Error(message), { code: "MODEL_BAD_JSON" });
}

function apiError(message) {
  return Object.assign(new Error(message), { status: 502 });
}

export function parseModelJson(content) {
  if (typeof content !== "string" || !content.trim()) throw badJson("model response was empty");
  try {
    return JSON.parse(content);
  } catch {
    // Fall through and try to recover a JSON object from surrounding text.
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      // Fall through to the error below.
    }
  }
  throw badJson("model response was not JSON");
}

// Real client. Reads the key from process.env.META_API_KEY unless given one.
// The key is never opened from, printed to, or written anywhere here.
export function createModelClient({
  apiKey = process.env.META_API_KEY,
  baseUrl = META_BASE_URL,
  textModel = TEXT_MODEL,
  audioModel = AUDIO_MODEL,
  fetchFn = fetch,
  timeoutMs = 60000,
} = {}) {
  return {
    async complete({ text = null, audio = null, image = null, prior = null, system = null }) {
      if (!apiKey) throw apiError("META_API_KEY is not set");
      if (audio && image) throw new Error("complete takes audio or image, not both");
      const isAudio = !!audio;
      const isImage = !!image;
      const prompt = system ?? (prior ? `${SYSTEM_PROMPT}\n\n${FIX_SUFFIX}` : SYSTEM_PROMPT);
      let userContent;
      if (isImage) {
        if (prior) throw new Error("prior is not supported with image input");
        userContent = [
          { type: "text", text: "Read this photo and reply with the JSON described in the system prompt." },
          { type: "image_url", image_url: { url: `data:${image.format};base64,${image.data}` } },
        ];
      } else if (isAudio) {
        userContent = [
          { type: "text", text: "Listen to this trader voice note and extract the bookkeeping JSON." },
          { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
        ];
      } else if (prior) {
        userContent =
          `Previous proposal:\n${JSON.stringify(prior)}\n\nTrader correction: ${text}\n\nReturn the revised JSON.`;
      } else {
        userContent = text;
      }
      let res;
      try {
        res = await fetchFn(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: isAudio ? audioModel : textModel,
            reasoning_effort: "minimal",
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: userContent },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw apiError(`model API request failed: ${err.message}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw apiError(`model API error ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = await res.json().catch(() => ({}));
      return parseModelJson(data.choices?.[0]?.message?.content ?? "");
    },
  };
}

// Mock client for tests: handler(request) returns the structured object (or a
// raw string to exercise the JSON-recovery path). No network involved.
export function createMockModelClient(handler) {
  return {
    async complete(request) {
      const out = await handler(request);
      return typeof out === "string" ? parseModelJson(out) : out;
    },
  };
}
