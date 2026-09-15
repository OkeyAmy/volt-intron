"""Build the benchmark report (HTML + PDF, target <= 3 pages) from a run's results.

Every number comes from benchmarks/outputs/<tag>/results.json (and the manifest);
model ids and language-hint policy are read from the provider modules, so the report
cannot drift from the code that produced the scores. Prose lives in narrative.md and
must not contain numbers.

Usage:
    uv run python -m benchmarks.report.build_report --tag final
    uv run python -m benchmarks.report.build_report --tag final --examples   # worst cells, for writing findings
"""
from __future__ import annotations

import argparse
import csv
import html
import json
import re
import shutil
import subprocess
from datetime import date
from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
ROOT = BENCH.parent
OUTPUTS = BENCH / "outputs"
MANIFEST = BENCH / "data" / "pilot_manifest.csv"
NARRATIVE = Path(__file__).resolve().parent / "narrative.md"

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
]


def provider_config() -> list[dict]:
    from benchmarks.providers import elevenlabs, gemini, groq_whisper, intron_sahara

    return [
        {"provider": "intron_sahara", "model": "Sahara (streaming STT)", "endpoint": "wss://infer.voice.intron.io/stt/v1/stream",
         "hints": intron_sahara.LANG_CODES},
        {"provider": "groq_whisper", "model": groq_whisper._DEFAULT_MODEL, "endpoint": "api.groq.com /audio/transcriptions",
         "hints": groq_whisper.LANG_CODES},
        {"provider": "gemini", "model": gemini._DEFAULT_MODEL, "endpoint": "generativelanguage.googleapis.com generateContent",
         "hints": "language named in the prompt"},
        {"provider": "elevenlabs", "model": elevenlabs._DEFAULT_MODEL, "endpoint": "api.elevenlabs.io /v1/speech-to-text",
         "hints": {**elevenlabs.LANG_CODES, "pidgin": None}},
    ]


def pct(v) -> str:
    return "–" if v is None else f"{v * 100:.1f}%"


def ci(s: dict) -> str:
    if not s or s.get("mean") is None:
        return "–"
    return f"{s['mean']*100:.1f}% ±{s['ci95']*100:.1f}" if s.get("ci95") else f"{s['mean']*100:.1f}%"


def load_narrative() -> dict[str, str]:
    text = NARRATIVE.read_text() if NARRATIVE.exists() else ""
    parts = re.split(r"^## +(.+)$", text, flags=re.M)
    return {parts[i].strip().lower(): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


def md(block: str) -> str:
    """Tiny markdown: paragraphs, '- ' bullets, **bold**."""
    out, items = [], []
    def flush():
        if items:
            out.append("<ul>" + "".join(f"<li>{i}</li>" for i in items) + "</ul>")
            items.clear()
    for para in re.split(r"\n\s*\n", block):
        for line in para.splitlines():
            esc = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", html.escape(line.strip()))
            if line.strip().startswith("- "):
                items.append(esc[2:])
            elif line.strip():
                flush()
                out.append(f"<p>{esc}</p>")
        flush()
    return "\n".join(out)


def table(headers: list[str], rows: list[list[str]]) -> str:
    th = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    trs = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>"


def build_html(tag: str) -> str:
    res = json.loads((OUTPUTS / tag / "results.json").read_text())
    summary: dict = res["summary"]
    providers = sorted(summary)
    narrative = load_narrative()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()

    with open(MANIFEST, newline="") as f:
        manifest = list(csv.DictReader(f))
    corpus = [r for r in manifest if r["source"] not in ("recorded", "synthetic", "codeswitch")]
    cs_rows = [r for r in manifest if r["source"] == "codeswitch"]
    meta_path = BENCH / "data" / "codeswitch_meta.json"
    cs_meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    parts = [f"<h1>Sautice — code-switched speech benchmark</h1>"
             f"<p class='meta'>Run <code>{html.escape(tag)}</code> · commit <code>{commit}</code> · "
             f"built {date.today().isoformat()} · {len(providers)} models</p>"]
    if narrative.get("summary"):
        parts.append("<h2>1. Summary</h2>" + md(narrative["summary"]))

    # Models
    rows = []
    for p in provider_config():
        if p["provider"] not in providers:
            continue
        h = p["hints"]
        hint = h if isinstance(h, str) else ", ".join(f"{k}→{v or 'none'}" for k, v in h.items()
                                                        if k in ("pidgin", "yoruba", "igbo", "hausa", "english"))
        rows.append([p["provider"], html.escape(p["model"]), html.escape(p["endpoint"]), html.escape(hint)])
    parts.append("<h2>2. Models and configuration</h2>" + table(["provider", "model", "API", "language hint"], rows))
    if narrative.get("models"):
        parts.append(md(narrative["models"]))

    # Data
    def count_by(rs, key):
        out: dict[str, list] = {}
        for r in rs:
            out.setdefault(r[key], []).append(float(r["duration"]))
        return out
    data_rows = [[html.escape(src), str(len(d)), f"{sum(d)/60:.1f} min", html.escape(", ".join(sorted({r['language'] for r in corpus if r['source']==src})))]
                 for src, d in sorted(count_by(corpus, "source").items())]
    if cs_rows:
        durs = [float(r["duration"]) for r in cs_rows]
        pairs = sorted({m.get("language_pair") for m in cs_meta.values() if m.get("language_pair")})
        data_rows.append(["SautiBench code-switched recordings (ours, consented)", str(len(cs_rows)),
                          f"{sum(durs)/60:.1f} min", html.escape(", ".join(pairs))])
    parts.append("<h2>3. Data</h2>" + table(["source", "clips", "audio", "languages"], data_rows))
    if cs_meta:
        speakers = len({m["speaker_id"] for m in cs_meta.values()})
        envs = sorted({m.get("environment") or "?" for m in cs_meta.values()})
        devices = sorted({m.get("device") or "?" for m in cs_meta.values()})
        regions = sorted({m.get("accent_region") or "?" for m in cs_meta.values()})
        parts.append(f"<p class='small'>Code-switched set: {speakers} speakers; accent regions {html.escape(', '.join(regions))}; "
                     f"devices {html.escape(', '.join(devices))}; environments {html.escape(', '.join(envs))}.</p>")
    if narrative.get("data"):
        parts.append(md(narrative["data"]))

    if narrative.get("metrics"):
        parts.append("<h2>4. Metrics</h2>" + md(narrative["metrics"]))

    # Track 1
    t1 = [[p, str(summary[p]["n"]), ci(summary[p]["norm_wer"]), pct(summary[p]["norm_cer"]["mean"]),
           pct(summary[p]["basic_wer"]["mean"]),
           f"{summary[p]['latency_s']['mean']:.1f}s" if summary[p]["latency_s"]["mean"] is not None else "–",
           pct(summary[p]["ok_rate"])] for p in providers if summary[p]["n"]]
    if t1:
        parts.append("<h2>5. Results — open corpora (Track 1)</h2>" +
                     table(["provider", "clips", "norm WER (95% CI)", "norm CER", "basic WER", "latency", "call success"], t1))
        langs = sorted({g for p in providers for g in summary[p]["language_breakdown"]})
        lrows = [[l] + [ci(summary[p]["language_breakdown"].get(l, {})) for p in providers] for l in langs]
        parts.append("<p class='small'>Norm WER by language:</p>" + table(["language"] + providers, lrows))

    # Track 3
    cs_prov = [p for p in providers if (summary[p].get("codeswitch") or {}).get("n")]
    if cs_prov:
        rows = []
        for p in cs_prov:
            s = summary[p]["codeswitch"]
            ma, mc = s["money_all"], s["money_given_reference_exact"]
            rows.append([p, f"{s['n']} ({s['ok']} ok)", ci(s["norm_wer"]), pct(s["norm_cer"]["mean"]), pct(s["basic_wer"]["mean"]),
                         f"{ma.get('exact',0)}/{ma.get('n',0)}", f"{mc.get('exact',0)}/{mc.get('n',0)}",
                         f"{ma.get('catastrophic',0)}", f"{ma.get('blocked',0)}"])
        parts.append("<h2>6. Results — code-switched speech (Track 3)</h2>" +
                     table(["provider", "clips", "norm WER (95% CI)", "norm CER", "basic WER",
                            "invoice exact (all)", "invoice exact (reference exact)", "wrong total >10%", "blocked (asked)"], rows))
        langs = sorted({g for p in cs_prov for g in summary[p]["codeswitch"]["language_wer"]})
        lrows = [[l] + [f"{ci(summary[p]['codeswitch']['language_wer'].get(l, {}))} / {pct((summary[p]['codeswitch']['language_cer'].get(l) or {}).get('mean'))}"
                        for p in cs_prov] for l in langs]
        parts.append("<p class='small'>WER / CER by language pair:</p>" + table(["language"] + cs_prov, lrows))
        first = summary[cs_prov[0]]["codeswitch"]
        parts.append(f"<p class='small'>Reference ceiling: the human reference transcript yields the exact invoice on "
                     f"{first['reference_exact']}/{first['reference_scored']} clips.</p>")

    # Track 2 (recorded briefs) if present
    t2 = [[p, str(summary[p]["money_recorded"].get("n", 0)), str(summary[p]["money_recorded"].get("exact", 0)),
           str(summary[p]["money_recorded"].get("catastrophic", 0)), str(summary[p]["money_recorded"].get("blocked", 0))]
          for p in providers if summary[p].get("money_recorded", {}).get("n")]
    if t2:
        parts.append("<h2>7. Product probe — recorded English briefs (Track 2)</h2>" +
                     table(["provider", "clips", "invoice exact", "wrong total >10%", "blocked"], t2))

    for key, title in (("findings", "Qualitative findings"), ("limitations", "Limitations and responsible data use")):
        if narrative.get(key):
            parts.append(f"<h2>{title}</h2>" + md(narrative[key]))

    css = """
      @page { size: A4; margin: 12mm 13mm; }
      body { font: 9.2pt/1.35 -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #16233F; }
      h1 { font-size: 15pt; margin: 0 0 2px; } h2 { font-size: 10.5pt; margin: 10px 0 4px; border-bottom: 1px solid #D9D5CA; }
      p { margin: 3px 0; } .meta, .small { color: #5A6274; font-size: 8.2pt; } ul { margin: 2px 0 4px 16px; padding: 0; }
      table { border-collapse: collapse; width: 100%; margin: 3px 0 5px; font-size: 8.2pt; font-variant-numeric: tabular-nums; }
      th, td { border-bottom: 1px solid #EAE7DF; padding: 2px 4px; text-align: left; vertical-align: top; }
      th { background: #F7F6F2; } code { font-size: 8pt; }
    """
    return f"<!doctype html><html><head><meta charset='utf-8'><title>Sautice benchmark</title><style>{css}</style></head><body>{''.join(parts)}</body></html>"


def to_pdf(html_path: Path, pdf_path: Path) -> bool:
    chrome = next((c for c in CHROME_CANDIDATES if c and Path(c).exists()), None)
    if not chrome:
        print("[-] Chrome/Chromium not found; open the HTML and print to PDF manually")
        return False
    subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                    f"--print-to-pdf={pdf_path}", html_path.resolve().as_uri()], check=True,
                   capture_output=True)
    return pdf_path.exists()


def pdf_pages(pdf_path: Path) -> int:
    return len(re.findall(rb"/Type\s*/Page(?!s)", pdf_path.read_bytes()))


def examples(tag: str, k: int = 3) -> None:
    cells = [json.loads(l) for l in (OUTPUTS / tag / "per_cell.jsonl").read_text().splitlines() if l.strip()]
    groups: dict[tuple, list] = {}
    for c in cells:
        if c.get("ok"):
            groups.setdefault((c["provider"], c["source"] == "codeswitch", c["language"]), []).append(c)
    for (prov, is_cs, lang), cs in sorted(groups.items()):
        print(f"\n## {prov} · {'code-switched' if is_cs else 'corpus'} · {lang}")
        for c in sorted(cs, key=lambda x: -x["norm_wer"])[:k]:
            print(f"- WER {c['norm_wer']*100:.0f}%  REF: {c['text_ref']}\n  HYP: {c.get('text','')}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--examples", action="store_true")
    args = ap.parse_args()
    if args.examples:
        examples(args.tag)
        return 0
    out_dir = OUTPUTS / args.tag
    html_path, pdf_path = out_dir / "report.html", out_dir / "benchmark-report.pdf"
    html_path.write_text(build_html(args.tag))
    print(f"[report] {html_path}")
    if to_pdf(html_path, pdf_path):
        n = pdf_pages(pdf_path)
        print(f"[report] {pdf_path} ({n} pages){'  !! over the 3-page limit' if n > 3 else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
