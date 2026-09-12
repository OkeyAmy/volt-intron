/**
 * Block B exit criterion: a real Intron streaming round trip from TypeScript.
 * Run: npx tsx scripts/smoke-intron.ts <wav> <lang...>
 */
import { readFileSync } from "node:fs";
import { loadAs16kMono } from "../src/lib/audio/wav";
import { transcribeStream, type LanguageCode } from "../src/lib/speech/intron-stream";

const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
if (!apiKey) throw new Error("set INTRON_API_KEY (or API_KEY)");

const [wavPath, ...langs] = process.argv.slice(2);
const pcm = loadAs16kMono(readFileSync(wavPath));
console.log(`audio: ${(pcm.length / 2 / 16000).toFixed(2)}s  ${pcm.length} bytes PCM16 @16k mono\n`);

for (const lang of (langs.length ? langs : ["pcm"]) as LanguageCode[]) {
  process.stdout.write(`--- use_language_asr_input=${lang} ---\n`);
  try {
    const r = await transcribeStream(pcm, {
      apiKey, language: lang,
      onOpen: (s) => console.log(`  session ${s.sessionId.slice(0, 8)}  credits ${s.creditBalance}`),
      onPartial: (t) => console.log(`  partial: ${t}`),
    });
    console.log(`  partials=${r.partialCount}  firstPartial=${r.msToFirstPartial}ms  total=${r.msTotal}ms`);
    console.log(`  FINAL: ${JSON.stringify(r.transcript)}\n`);
  } catch (e) {
    console.log(`  FAILED: ${(e as Error).message}\n`);
  }
}
