import json, pathlib
sc = json.load(open("benchmarks/data/sautibench/scenarios.json"))["scenarios"]
slim = [{"id":s["id"],"brief":s["brief"],"note":s["note"],"tags":s["tags"],
         "customer":{"in_roster":s["customer"]["in_roster"]}} for s in sc]
tpl = pathlib.Path("scripts/recorder/template.html").read_text()
out = pathlib.Path("scripts/recorder/sautice-recorder.html")
out.write_text(tpl.replace("__SCENARIOS__", json.dumps(slim, ensure_ascii=False)))
print(f"built {out}  ({out.stat().st_size//1024} KB, {len(slim)} scenarios, self-contained)")
