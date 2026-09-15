"""The benchmark corpus must be the same clips on every machine and every run.

Clip selection sorts by duration and breaks ties on the reference text. Python's
built-in str hash is salted per process, so the tie-break has to use a content hash;
this test runs the selection under different PYTHONHASHSEED values and requires the
same order each time.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CODE = """
import json, sys
sys.path.insert(0, {root!r})
from benchmarks import load_data as ld
rows = [{{"text": t, "duration": 3.072}} for t in ["zeta", "alpha", "delta", "gamma", "beta", "epsilon"]]
rows.append({{"text": "longer", "duration": 4.0}})
print(json.dumps([r["text"] for r in ld.buckets_for(rows, lambda r: "g", {{"k": 4}})]))
"""


def _selection(seed: int) -> list[str]:
    env = {**os.environ, "PYTHONHASHSEED": str(seed)}
    out = subprocess.run([sys.executable, "-c", CODE.format(root=str(ROOT))],
                         env=env, capture_output=True, text=True, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_tie_break_does_not_depend_on_python_hash_seed():
    first = _selection(1)
    assert len(first) == 4
    assert "longer" not in first  # shortest clips win before any tie-break
    for seed in (2, 99, 123456):
        assert _selection(seed) == first
