"""Build the standalone recorder.

Design tokens and logo are INJECTED from design/ so there is exactly one source of
truth shared with apps/web. Never hand-edit the generated file.
"""
import json, pathlib, re, urllib.parse

root = pathlib.Path(__file__).resolve().parents[1]
sc = json.loads((root/"benchmarks/data/sautibench/scenarios.json").read_text())["scenarios"]
# NOTE: scenario["note"] is an INTERNAL scoring note ("correct behaviour is to ask").
# It must never reach the speaker - seeing it would bias how they speak, which would
# contaminate the very utterances the adversarial suite depends on.
slim = [{"id": s["id"], "brief": s["brief"], "tags": s["tags"],
         "customer": {"in_roster": s["customer"]["in_roster"]}} for s in sc]

tokens  = (root/"design/tokens.css").read_text()
logo    = (root/"design/logo.svg").read_text().strip()
# Inline SVG favicon: collapse whitespace and use single quotes so the markup cannot
# break out of the href="..." attribute, then percent-encode the rest.
favicon = re.sub(r"\s+", " ", (root/"design/favicon.svg").read_text()).strip().replace('"', "'")

html = (root/"scripts/recorder/template.html").read_text()
for k, v in {
    "__TOKENS__": tokens,
    "__LOGO__": logo,
    "__FAVICON__": urllib.parse.quote(favicon, safe="/:=' "),
    "__SCENARIOS__": json.dumps(slim, ensure_ascii=False),
}.items():
    assert k in html, f"placeholder {k} missing from template"
    html = html.replace(k, v)

out = root/"scripts/recorder/sautice-recorder.html"
out.write_text(html)
(root/"docs/index.html").write_text(html)          # GitHub Pages copy
(root/"web/public/recorder.html").write_text(html) # served by the app at /recorder.html (https, so phones can record)
print(f"built {out.name} ({out.stat().st_size//1024} KB) -> also docs/index.html, web/public/recorder.html")
