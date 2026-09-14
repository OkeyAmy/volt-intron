"""Server-only bridge: one JSON request on stdin, one JSON response on stdout.

The web app is Node; the authoritative money and resolution logic is Python. Rather
than port it (and risk drift), Node invokes this as a short-lived subprocess with a
structured request. No shell, no arguments carrying data — everything is JSON on the
pipe, so there is nothing to interpolate.

Request:
  {"action": "draft",
   "transcript": "...",              # used when no `intent` is supplied
   "intent": {...},                  # optional pre-extracted intent (e.g. from an LLM)
   "selections": {...},              # the reviewer's disambiguation choices
   "roster_path": "...",             # optional; defaults to the bundled demo roster
   "today": "YYYY-MM-DD"}            # optional date context for due dates

Response: {"ok": true, "draft": {...}, "intent": {...}} or {"ok": false, "error": "..."}.
"""
from __future__ import annotations

import json
import sys

from sautice.invoice.extract import Intent, heuristic_extract
from sautice.invoice.executor import build_draft
from sautice.invoice.roster import load_roster

MAX_INPUT_BYTES = 256 * 1024


def handle(req: dict) -> dict:
    action = req.get("action")
    if action != "draft":
        return {"ok": False, "error": f"unknown action {action!r}"}

    if req.get("intent"):
        intent = Intent.from_dict(req["intent"])
    else:
        intent = heuristic_extract(str(req.get("transcript", "")))

    roster = load_roster(req.get("roster_path"))
    draft = build_draft(intent, roster, req.get("selections") or {}, today=req.get("today"))
    return {"ok": True, "draft": draft, "intent": intent.to_dict()}


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        json.dump({"ok": False, "error": "request too large"}, sys.stdout)
        return 1
    try:
        req = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        json.dump({"ok": False, "error": f"invalid JSON: {exc}"}, sys.stdout)
        return 1
    try:
        resp = handle(req)
    except Exception as exc:  # noqa: BLE001 - a bridge must always answer, never crash silently
        json.dump({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, sys.stdout)
        return 1
    json.dump(resp, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
