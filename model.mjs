// Meta Model API client (OpenAI-compatible) plus an injectable mock for tests.
//
// Model ids verified against dev.meta.ai docs roundups (Oct 2026):
// - muse-spark-1.3: text reasoning/extraction. Audio input is NOT supported
//   on the 1.3 checkpoints.
// - muse-spark-1.2: still the checkpoint to use for audio input.
// - reasoning_effort "minimal" is the lowest the API allows on Muse Spark:
//   "none" returns HTTP 400 (dev.meta.ai/docs/reasoning). Even at minimal
//   the model still spends hundreds of reasoning tokens on some notes, so
//   the output caps below leave room for reasoning plus the JSON.
// - Sampling, verified against dev.meta.ai/docs (chat-completions schemas +
//   protocols pages, 30 Oct 2026): temperature 0-2 (default 1), top_p (0,1]
//   (top_p: 0 returns HTTP 400; set temperature OR top_p, never both), seed
//   integer (deprecated but accepted: best-effort deterministic sampling,
//   determinism not guaranteed). Most deterministic combo: temperature 0, a
//   fixed seed, top_p untouched. Docs caveat: Muse Spark is tuned for the
//   defaults and "performs best there" — if extraction quality drops, revert
//   temperature to 1 and keep the seed.
// Audio uses the OpenAI-compatible input_audio part:
//   { type: "input_audio", input_audio: { data: base64, format: "wav" } }
// Images use the OpenAI-compatible image_url part on the 1.3 checkpoint
// (dev.meta.ai/docs/image-understanding):
//   { type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }

export const META_BASE_URL = "https://api.meta.ai/v1";
export const TEXT_MODEL = "muse-spark-1.3";
export const AUDIO_MODEL = "muse-spark-1.2";
// Docs-verified deterministic sampling (see header): greedy decoding plus a
// fixed best-effort seed. Shared by the Meta calls and the Baseten
// second-opinion call (OpenAI-compatible endpoint, same parameter names).
export const MODEL_TEMPERATURE = 0;
export const MODEL_SEED = 7;

export const SYSTEM_PROMPT = `You are PocketOga, a bookkeeping assistant for Nigerian market traders. You understand English and Nigerian Pidgin. You only propose entries; you never save, confirm, or compute totals — plain code checks your work.
Reply with compact JSON only, exactly this shape, no explanation, no extra fields:
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
- Entry types are only: sale (goods sold), payment (money received), purchase (stock bought), expense (money spent). A sale with part payment is TWO entries: a sale for the full total and a payment for what was paid.
- A debt statement with no sale details ("Ada dey owe me 5k") is ONE sale entry: the customer, the stated amount, item/unit/quantity null, priceBasis "total", no question. Plain code records it as owed with stock unchanged.
- Trader glossary: "pay", "paid", "don pay", "e pay", "dem pay", "she don pay" always mean a payment received — never a sale, even when "buy" appears later ("wey she buy" refers to goods bought earlier). "buy", "collect", "take" with goods mean a sale. "dey owe me" / "owe me" mean unpaid debt. If the speaker says someone paid "the remain" / "the balance" / "the rest" with no amount, the amount is that customer's balance owed from the known names; amountPhrase keeps the trader's words. A spoken amount always wins over the balance. "don pay the remain X" and "pay the balance (of) X" are a payment of X, never a sale. "I buy" / "I bought" (first person) is a purchase for the shop (customer null), never a sale to a customer. "remain", "remain am", "balance" state the remainder still owed.
- Pidgin words: "e" = he/she, "wey" = which/that, "don" = already (has/have), "dey" = is/are, "abeg" = please.
- Numbers: "k" means thousand ("15k"/"five K" = 5000, "two k" = 2000), "forty-five hundred" = 4500, "one and half" = 1.5. Units in singular form: mudu, paint, derica, congo, bag, carton, crate, tuber, bunch.
- Hearing rule: "heard" is exactly what was said — never add, infer or complete words or numbers. Mark unclear parts "[unclear]". An unclear amount means a question, never a guess. Totals, remainders and owed figures are computed by code, never stated: keep them out of "heard".
- amountNaira and every totals leg are whole naira integers, never negative. amountPhrase is the trader's exact words for that amount. Fill totals only when the note states total, paid and remainder figures.
- priceBasis says whether amountNaira is per item ("each"), for the whole lot ("total"), or "unclear" when the note does not say. "15k each" is each; a payment or an expense is always a total.
- An expense carries its category in item (one of: transport, rent, power, fuel, data, wages, stock-related, other), the payee in customer (or null when the shop itself paid), the whole-naira amount in amountNaira, priceBasis "total", and quantity and unit null.
- promise captures when the trader says a customer will pay ("she go pay Friday"): the customer name, the trader's exact day-words in datePhrase, and amountNaira (whole naira, or null when no amount is said). Never resolve the day into a date yourself; plain code does that. Null when the note states no promise.
- quantity is a positive integer count of items, or null when the note has none.
- unit is the container or count word in singular form, separate from item: "2 bags of rice" is item "rice", unit "bag", quantity 2. Null when the note names none.
- Match every customer name against the shop's known customers first (exact spellings ride along); only a truly new name is a new customer. Never invent names, items, or amounts. If anything essential is missing or unclear, put it in question and leave the field null.
- No bookkeeping content means "entries": [] with a question.`;

const FIX_SUFFIX =
  "The trader is correcting your previous proposal (included below with their correction). Return the full revised JSON in the same shape.";

// Retry suffix for a length-truncated attempt: same task, double budget,
// explicit compact instruction.
const COMPACT_SUFFIX = "\n\nKeep reasoning minimal and answer with compact JSON only.";

function badJson(message) {
  return Object.assign(new Error(message), { code: "MODEL_BAD_JSON" });
}

function truncatedError() {
  return Object.assign(new Error("model response truncated twice"), { code: "MODEL_TRUNCATED" });
}

export const MODEL_TEXT_TIMEOUT_MS = 30000;
export const MODEL_AUDIO_TIMEOUT_MS = 90000;
export const MODEL_PHOTO_TIMEOUT_MS = 30000;
// Output caps: reasoning + visible JSON combined. Live notes spent up to
// ~800 reasoning tokens at minimal effort and truncated an 800 cap, so text
// allows 2000 (reasoning plus JSON, measured in the dev log); a length
// retry doubles it. No catalogue or ledger data is ever sent — the prompt
// carries only rules, so it is already minimal.
export const MODEL_TEXT_MAX_TOKENS = 2000;
export const MODEL_AUDIO_MAX_TOKENS = 1200;
export const MODEL_PHOTO_MAX_TOKENS = 500;

// One fetch with a timeout and a single retry. Retries transport failures,
// timeouts, 429s and 5xx responses; anything else (other 4xx, bad payloads)
// fails fast so a broken request never doubles its cost. The returned
// response carries a non-enumerable attempts count (1 when no retry fired)
// so dev logs can tell a slow call from a retried one.
export async function fetchWithRetry(fetchFn, url, opts, { timeoutMs, retries = 1 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
      const retryableStatus = res && (res.status === 429 || (Number.isInteger(res.status) && res.status >= 500 && res.status <= 599));
      if (retryableStatus && attempt < retries) {
        attempt++;
        continue;
      }
      if (res && (typeof res === "object" || typeof res === "function")) {
        try {
          Object.defineProperty(res, "attempts", { value: attempt + 1, configurable: true });
        } catch {
          // Frozen response: attempts stay unknown, the call is unaffected.
        }
      }
      return res;
    } catch (err) {
      if (attempt < retries && (err?.name === "TimeoutError" || err instanceof TypeError)) {
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

// The trader's shortcut tap, passed to the model as a likely type only —
// never an order. Plain code re-checks the classification afterwards and
// says so on the card when the note clearly says something else.
function hintSentence(hint) {
  return `Likely type: ${hint} (the trader tapped it first). Classify each entry by what they actually said — if they clearly said something else, use that.`;
}

function apiError(message) {
  return Object.assign(new Error(message), { status: 502 });
}

// Dev-only one-liner per model call: kind, length-retry flag, attempts, HTTP
// status, finish reason, token counts, content length. Numbers only — never
// the note, image bytes, key, or model output. Silent unless
// POCKETOGA_TIMING=1.
function logModelCall({ kind, retry, attempts, status, finish, input, output, reasoning, contentChars, ok, ms }) {
  if (process.env.POCKETOGA_TIMING !== "1") return;
  console.log(
    `model kind=${kind} retry=${retry} attempts=${attempts} status=${status} finish=${finish} ` +
      `in_tokens=${input} out_tokens=${output} reasoning_tokens=${reasoning} ` +
      `content_chars=${contentChars} ok=${ok} ms=${ms}`
  );
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

// One chat-completion round trip: fetch, log, parse. Complete JSON is used
// as-is whatever the finish reason; unparseable output throws badJson
// carrying the finish reason so the caller can retry length cutoffs.
async function callOnce({ baseUrl, model, fetchFn, timeoutMs, userContent, kind, apiKey, prompt, maxTokens, retry }) {
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithRetry(
      fetchFn,
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          reasoning_effort: "minimal",
          temperature: MODEL_TEMPERATURE,
          seed: MODEL_SEED,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: userContent },
          ],
        }),
      },
      { timeoutMs }
    );
  } catch (err) {
    logModelCall({ kind, retry, attempts: "n/a", status: "error", finish: "none", input: "n/a", output: "n/a", reasoning: "n/a", contentChars: 0, ok: false, ms: Date.now() - t0 });
    throw apiError(`model API request failed: ${err.message}`);
  }
  const attempts = Number.isInteger(res?.attempts) ? res.attempts : "n/a";
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logModelCall({ kind, retry, attempts, status: res.status, finish: "none", input: "n/a", output: "n/a", reasoning: "n/a", contentChars: 0, ok: false, ms: Date.now() - t0 });
    throw apiError(`model API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => ({}));
  const choice = data.choices?.[0] ?? {};
  const content = choice.message?.content ?? "";
  const usage = data.usage ?? {};
  const info = {
    kind,
    retry,
    attempts,
    status: res.status,
    finish: choice.finish_reason ?? "none",
    input: Number.isInteger(usage.prompt_tokens) ? usage.prompt_tokens : "n/a",
    output: Number.isInteger(usage.completion_tokens) ? usage.completion_tokens : "n/a",
    reasoning: Number.isInteger(usage.completion_tokens_details?.reasoning_tokens) ? usage.completion_tokens_details.reasoning_tokens : "n/a",
    contentChars: String(content).length,
    ms: Date.now() - t0,
  };
  try {
    const out = parseModelJson(content);
    logModelCall({ ...info, ok: true });
    return out;
  } catch (err) {
    logModelCall({ ...info, ok: false });
    throw Object.assign(err, { finish: choice.finish_reason ?? null });
  }
}

// Real client. Reads the key from process.env.META_API_KEY unless given one.
// The key is never opened from, printed to, or written anywhere here.
export function createModelClient({
  apiKey = process.env.META_API_KEY,
  baseUrl = META_BASE_URL,
  textModel = TEXT_MODEL,
  audioModel = AUDIO_MODEL,
  fetchFn = fetch,
  textTimeoutMs = MODEL_TEXT_TIMEOUT_MS,
  audioTimeoutMs = MODEL_AUDIO_TIMEOUT_MS,
  photoTimeoutMs = MODEL_PHOTO_TIMEOUT_MS,
} = {}) {
  return {
    async complete({ text = null, audio = null, image = null, prior = null, system = null, hint = null, context = null }) {
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
          { type: "text", text: `Listen to this trader voice note and extract the bookkeeping JSON. Reply with compact JSON only.${hint ? ` ${hintSentence(hint)}` : ""}${context ? `\n\n${context}` : ""}` },
          { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
        ];
      } else if (prior) {
        userContent =
          `Previous proposal:\n${JSON.stringify(prior)}\n\nTrader correction: ${text}\n\nReturn the revised JSON.${hint ? `\n\n${hintSentence(hint)}` : ""}`;
      } else {
        userContent = hint ? `${text}\n\n${hintSentence(hint)}` : text;
        if (context) userContent += `\n\n${context}`;
      }
      const maxTokens = isAudio ? MODEL_AUDIO_MAX_TOKENS : isImage ? MODEL_PHOTO_MAX_TOKENS : MODEL_TEXT_MAX_TOKENS;
      const shared = {
        baseUrl,
        model: isAudio ? audioModel : textModel,
        fetchFn,
        timeoutMs: isAudio ? audioTimeoutMs : isImage ? photoTimeoutMs : textTimeoutMs,
        userContent,
        kind: isAudio ? "audio" : isImage ? "photo" : prior ? "fix" : "text",
        apiKey,
      };
      try {
        return await callOnce({ ...shared, prompt, maxTokens, retry: 0 });
      } catch (err) {
        // finish=length with unparseable output: the budget died on reasoning.
        // One automatic retry with double budget and an explicit compact-JSON
        // instruction. Both attempts failed means MODEL_TRUNCATED, never a
        // confused "I no understand" card for a cutoff.
        if (err?.code === "MODEL_BAD_JSON" && err?.finish === "length") {
          try {
            return await callOnce({ ...shared, prompt: prompt + COMPACT_SUFFIX, maxTokens: maxTokens * 2, retry: 1 });
          } catch (retryErr) {
            if (retryErr?.code === "MODEL_BAD_JSON") throw truncatedError();
            throw retryErr;
          }
        }
        throw err;
      }
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
