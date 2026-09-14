/**
 * Real Intron streaming round trip from TypeScript.
 * Run: npx tsx scripts/smoke-intron.mts <wav> <lang...>
 *
 * Exits non-zero if arguments are invalid or ANY language attempt fails, so it
 * can gate CI/smoke checks. The API key is read from the environment and never
 * printed; only redacted timing and error diagnostics are shown.
 */
import { readFileSync } from "node:fs";
import { loadAs16kMono } from "../src/lib/audio/wav";
import {
  transcribeStream,
  IntronStreamError,
  CODE_SWITCHED,
  type LanguageCode,
} from "../src/lib/speech/intron-stream";

function die(msg: string): never {
  console.error(`smoke-intron: ${msg}`);
  process.exit(2);
}

const apiKey = process.env.INTRON_API_KEY ?? process.env.API_KEY;
if (!apiKey) die("set INTRON_API_KEY (or API_KEY)");

const VALID = new Set<string>([...Object.keys(CODE_SWITCHED), "en"]);
const [wavPath, ...rawLangs] = process.argv.slice(2);
if (!wavPath) die("usage: tsx scripts/smoke-intron.mts <wav> <lang...>");

const langs = (rawLangs.length ? rawLangs : ["pcm"]);
for (const l of langs) if (!VALID.has(l)) die(`unsupported language ${JSON.stringify(l)}; expected one of ${[...VALID].join(", ")}`);

let pcm: Buffer;
try {
  pcm = loadAs16kMono(readFileSync(wavPath));
} catch (e) {
  die(`could not load ${wavPath}: ${(e as Error).message}`);
}
console.log(`audio: ${(pcm.length / 2 / 16000).toFixed(2)}s  ${pcm.length} bytes PCM16 @16k mono\n`);

let failures = 0;
for (const lang of langs as LanguageCode[]) {
  process.stdout.write(`--- use_language_asr_input=${lang} ---\n`);
  try {
    const r = await transcribeStream(pcm, {
      apiKey: apiKey as string,
      language: lang,
      onOpen: (s) => console.log(`  session ${s.sessionId.slice(0, 8)}…  credits ${s.creditBalance}`),
      onPartial: (t) => console.log(`  partial: ${t}`),
    });
    console.log(`  partials=${r.partialCount}  firstPartial=${r.msToFirstPartial}ms  stopToFinal=${r.msStopToFinal}ms  total=${r.msTotal}ms`);
    console.log(`  FINAL: ${JSON.stringify(r.transcript)}\n`);
  } catch (e) {
    failures++;
    if (e instanceof IntronStreamError) {
      const d = e.detail;
      console.log(`  FAILED [${e.code}] ${e.message}`);
      console.log(`    stage=${d.stage} recoverable=${d.recoverable}` +
        (d.providerEvent ? ` providerEvent=${d.providerEvent}` : "") +
        (d.closeCode != null ? ` close=${d.closeCode}/${JSON.stringify(d.closeReason)}` : "") + "\n");
    } else {
      console.log(`  FAILED: ${(e as Error).message}\n`);
    }
  }
}

if (failures > 0) {
  console.error(`smoke-intron: ${failures}/${langs.length} language attempt(s) failed`);
  process.exit(1);
}
