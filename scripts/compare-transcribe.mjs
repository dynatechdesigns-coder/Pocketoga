// Transcription A/B: current path (muse-spark-1.2 input_audio straight to
// bookkeeping JSON) versus Muse Voice Transcribe (muse-voice-transcribe-1.0
// batch endpoint, transcript only). Prints per-file time and transcript for
// each path so a human can judge speed and Pidgin quality.
//
// Usage: node scripts/compare-transcribe.mjs [wav ...]
//   Default files: note.wav note2.wav note3.wav (existing fake probe
//   samples). Pass your own fake recordings to compare more notes, e.g. the
//   five Pidgin/English notes below recorded as 16 kHz mono WAV.
//   Needs META_API_KEY (read from process.env only, never printed). No mock:
//   a mocked comparison would prove nothing.
//
// Fake comparison notes (record each as one WAV, 16 kHz mono, then pass the
// files on the command line):
//   1. "Mama Chinedu buy 2 bag of rice, 15k each, she pay 25k." (Pidgin mix)
//   2. "Ada don pay 5k for the rice wey she buy." (Pidgin)
//   3. "I bought 10 bags of rice at 45k each." (English)
//   4. "Bola buy garri 3 mudu, 4500 total, e pay 2000." (Pidgin mix)
//   5. "Paid shop rent for November, 150000." (English)
//
// Docs: dev.meta.ai/docs/speech-to-text. Batch endpoint takes RIFF/WAVE
// mono 16-bit PCM at 16/24 kHz (exactly what the app records), max 32 MB /
// 10 min per request. 25 languages with code-switching, English included;
// Nigerian Pidgin is not listed, so the script biases toward English and
// lets code-switching cover the Pidgin. `keywords` biasing (market words)
// is deliberately off for a fair first comparison.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createModelClient } from "../model.mjs";

const ASR_URL = "https://api.meta.ai/v1/asr/transcribe";
const ASR_MODEL = "muse-voice-transcribe-1.0";
const TIMEOUT_MS = 120000;

function turnText(turn) {
  if (typeof turn === "string") return turn;
  return turn?.text ?? turn?.transcript ?? JSON.stringify(turn);
}

// Path B: batch transcription. Returns { text, ms }.
async function transcribeFile(apiKey, wavPath) {
  const audio = readFileSync(wavPath);
  const sessionId = randomBytes(8).toString("hex");
  const form = new FormData();
  form.append(
    "request",
    new Blob(
      [JSON.stringify({ mode: "PUSH_TO_TALK", model: ASR_MODEL, audioEncoding: "WAV", languageBias: ["English"] })],
      { type: "application/json" }
    )
  );
  form.append("audio", new Blob([audio], { type: "audio/wav" }), "note.wav");
  const t0 = Date.now();
  const res = await fetch(`${ASR_URL}?sessionId=${sessionId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`transcribe ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  const turns = Array.isArray(data.turns) ? data.turns : [];
  return { text: turns.map(turnText).join(" ").trim() || JSON.stringify(data).slice(0, 300), ms };
}

// Path A: current direct extraction. Returns { heard, entries, ms }.
async function directExtract(client, wavPath) {
  const data = readFileSync(wavPath).toString("base64");
  const t0 = Date.now();
  const out = await client.complete({ audio: { data, format: "wav" } });
  const ms = Date.now() - t0;
  const entries = (out.entries ?? [])
    .map((e) => `${e.type} ${e.customer ?? "?"} ${e.amountNaira ?? "?"} ${e.item ?? ""}`.trim())
    .join("; ");
  return { heard: out.heard ?? "(none)", entries: entries || "(none)", ms };
}

async function main() {
  const apiKey = process.env.META_API_KEY;
  if (!apiKey) {
    console.error("compare-transcribe needs META_API_KEY (real-model comparison only; no mock).");
    process.exit(1);
  }
  const files = process.argv.slice(2);
  const wavs = files.length > 0 ? files : ["note.wav", "note2.wav", "note3.wav"];
  const client = createModelClient({ apiKey });
  let aTotal = 0;
  let bTotal = 0;
  for (const wav of wavs) {
    console.log(`--- ${wav} ---`);
    try {
      const a = await directExtract(client, wav);
      aTotal += a.ms;
      console.log(`A direct   ${a.ms}ms heard: "${a.heard}"`);
      console.log(`A entries: ${a.entries}`);
    } catch (err) {
      console.log(`A direct   FAILED: ${err.message}`);
    }
    try {
      const b = await transcribeFile(apiKey, wav);
      bTotal += b.ms;
      console.log(`B voicetrx ${b.ms}ms transcript: "${b.text}"`);
    } catch (err) {
      console.log(`B voicetrx FAILED: ${err.message}`);
    }
  }
  console.log(`total A ${aTotal}ms, total B ${bTotal}ms (B is transcript-only; a full switch would add a text-extraction call)`);
}

await main();
