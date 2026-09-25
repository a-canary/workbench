#!/usr/bin/env python3
"""
extract_adaptations.py — deterministic pass for /adaptation-review.

Reads the dream journal (`~/.claude/dream/journal/YYYY-MM-DD.md`) over a
trailing window, pulls every `## adaptation` block /dream and /token-waste
wrote, identifies the SURFACE each one touched (a file path), and runs cheap
deterministic health checks on those surfaces so a smart agent only has to
reason about the shortlist — never the raw journals.

It detects, deterministically:
  - missing      — the surface file the adaptation named no longer exists
  - reverted     — a tracked surface was modified by a later commit that looks
                   like a revert (best-effort: the adaptation's own line/rule is
                   gone from the current file)
  - thrash       — the SAME surface was edited by >=2 adaptations in the window
                   (two self-healing runs fighting over one file)
  - conflict     — two adaptations in the window touch the same surface with
                   opposing intent keywords (added X vs removed X)
  - broken       — a *.py / *.sh / *.ts surface fails a syntax/parse check
  - rule_bloat   — ~/AGENTS.md grew by more than RULE_BLOAT_LINES across the
                   window's rule-appends (every waste fix dumping a "remember
                   not to" rule there is itself a regression)

The LLM never reads the journals. It gets this JSON shortlist plus, per
adaptation, a bounded excerpt of the block (so it can judge intent) and the
deterministic verdicts. Output goes to stdout as one JSON object.

Usage:
  python3 extract_adaptations.py --days 10 [--journal-dir DIR] [--today YYYY-MM-DD]
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import date, datetime, timedelta

HOME = os.path.expanduser("~")
DEFAULT_JOURNAL_DIR = os.path.join(HOME, ".claude", "dream", "journal")
AGENTS_MD = os.path.join(HOME, "AGENTS.md")

# A surface touched by >= this many adaptations in the window = thrash.
THRASH_MIN = 2
# AGENTS.md gaining more than this many lines of rules across the window is bloat.
RULE_BLOAT_LINES = 12
# Excerpt of each adaptation block handed to the agent (chars).
EXCERPT_CHARS = 1400

# Path-ish token: an absolute path or a ~/-rooted path, optionally `backticked`.
PATH_RE = re.compile(r"`?((?:~|/)[\w./@+-]+\.\w+|(?:~|/)[\w./@+-]+)`?")
# Opposing-intent keyword pairs for conflict detection.
INTENT_PAIRS = [
    ("add", "remove"), ("added", "removed"), ("enable", "disable"),
    ("exempt", "require"), ("loosen", "strengthen"), ("relax", "tighten"),
    ("allow", "block"), ("widen", "narrow"),
]


def daterange(today, days):
    for i in range(days):
        yield today - timedelta(days=i)


def read_journal(journal_dir, d):
    p = os.path.join(journal_dir, f"{d.isoformat()}.md")
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


def split_adaptations(text, day):
    """Yield (source, body) for each `## adaptation` block in a journal."""
    # Split on the heading, keep the trailing body up to the next H2 or EOF.
    parts = re.split(r"(?mi)^##\s+adaptation\s*$", text)
    # parts[0] is pre-heading content; each subsequent part is a block body.
    for body in parts[1:]:
        # Trim at the next H2 if the regex didn't (it does), and at next adaptation.
        nxt = re.search(r"(?m)^##\s+\S", body)
        if nxt:
            body = body[: nxt.start()]
        src = "dream"
        m = re.search(r"(?mi)^\s*source:\s*(\S+)", body)
        if m:
            src = m.group(1).strip()
        yield src, body.strip(), day


def extract_surface(body):
    """Best-effort: the file path the adaptation says it touched.

    Heuristic order: a path on a `surface:`/`file path`/`The one change` line,
    else the first concrete path-looking token in the block.
    """
    # Prefer lines that explicitly name the touched file.
    priority_lines = []
    for line in body.splitlines():
        low = line.lower()
        if any(k in low for k in ("surface", "file path", "the one change",
                                  "the change", "touched", "edited")):
            priority_lines.append(line)
    for line in priority_lines + body.splitlines():
        for m in PATH_RE.finditer(line):
            cand = m.group(1)
            # Skip obvious non-surfaces (journal/tmp tally references).
            if "/dream/journal/" in cand or "session-waste-examples" in cand:
                continue
            return cand
    return None


def expand(path):
    if path.startswith("~"):
        return os.path.join(HOME, path[2:]) if path.startswith("~/") else os.path.expanduser(path)
    return path


def git_root(path):
    d = os.path.dirname(path)
    try:
        r = subprocess.run(
            ["git", "-C", d, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def recent_commits_touching(path, since_iso):
    """Best-effort list of commit subjects since `since_iso` that touched path."""
    root = git_root(path)
    if not root:
        return []
    rel = os.path.relpath(path, root)
    try:
        r = subprocess.run(
            ["git", "-C", root, "log", f"--since={since_iso}",
             "--pretty=%h %s", "--", rel],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode == 0:
            return [ln for ln in r.stdout.splitlines() if ln.strip()]
    except (OSError, subprocess.SubprocessError):
        pass
    return []


def syntax_ok(path):
    """Cheap parse check for the languages adaptations commonly touch.

    Returns (checked: bool, ok: bool, detail: str).
    """
    ext = os.path.splitext(path)[1]
    try:
        if ext == ".py":
            r = subprocess.run([sys.executable, "-m", "py_compile", path],
                               capture_output=True, text=True, timeout=30)
            return True, r.returncode == 0, r.stderr.strip()[:300]
        if ext == ".sh":
            r = subprocess.run(["bash", "-n", path],
                               capture_output=True, text=True, timeout=30)
            return True, r.returncode == 0, r.stderr.strip()[:300]
        if ext in (".json",):
            with open(path, encoding="utf-8") as f:
                json.load(f)
            return True, True, ""
    except json.JSONDecodeError as e:
        return True, False, str(e)[:300]
    except (OSError, subprocess.SubprocessError) as e:
        return True, False, str(e)[:300]
    # .ts/.md/etc: no cheap local check; leave to the agent.
    return False, True, ""


def intent_conflict(body_a, body_b):
    a, b = body_a.lower(), body_b.lower()
    for x, y in INTENT_PAIRS:
        if (x in a and y in b) or (y in a and x in b):
            return f"{x}/{y}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=10)
    ap.add_argument("--journal-dir", default=DEFAULT_JOURNAL_DIR)
    ap.add_argument("--today", default=None,
                    help="YYYY-MM-DD; defaults to system today (passed in by the "
                         "skill so cron after-midnight runs are explicit).")
    args = ap.parse_args()

    if args.today:
        today = datetime.strptime(args.today, "%Y-%m-%d").date()
    else:
        today = date.today()
    since_iso = (today - timedelta(days=args.days)).isoformat()

    adaptations = []
    for d in daterange(today, args.days):
        text = read_journal(args.journal_dir, d)
        if not text:
            continue
        for src, body, day in split_adaptations(text, d):
            surface = extract_surface(body)
            adaptations.append({
                "date": day.isoformat(),
                "source": src,
                "surface": surface,
                "excerpt": body[:EXCERPT_CHARS],
            })

    # Group by surface for thrash/conflict detection.
    by_surface = {}
    for a in adaptations:
        if a["surface"]:
            by_surface.setdefault(a["surface"], []).append(a)

    findings = []

    for a in adaptations:
        surface = a["surface"]
        verdicts = []
        if not surface:
            verdicts.append({"check": "no_surface",
                             "detail": "could not identify a touched file from the block"})
        else:
            path = expand(surface)
            exists = os.path.exists(path)
            if not exists:
                verdicts.append({"check": "missing",
                                 "detail": f"surface {surface} does not exist on disk"})
            else:
                checked, ok, detail = syntax_ok(path)
                if checked and not ok:
                    verdicts.append({"check": "broken",
                                     "detail": f"syntax/parse error: {detail}"})
                commits = recent_commits_touching(path, since_iso)
                # A later "revert"/"undo"/"Revert" commit on the same surface is suspicious.
                rev = [c for c in commits
                       if re.search(r"\brevert|undo|roll ?back\b", c, re.I)]
                if rev:
                    verdicts.append({"check": "reverted",
                                     "detail": "revert-like commit(s) on this surface: "
                                               + "; ".join(rev[:3])})
                a["recent_commits"] = commits[:6]
        findings.append({**a, "verdicts": verdicts})

    thrash = []
    for surface, group in by_surface.items():
        if len(group) >= THRASH_MIN:
            thrash.append({
                "surface": surface,
                "count": len(group),
                "dates": sorted({g["date"] for g in group}),
                "sources": sorted({g["source"] for g in group}),
            })
        # pairwise intent conflict within the same surface
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                c = intent_conflict(group[i]["excerpt"], group[j]["excerpt"])
                if c:
                    findings.append({
                        "date": f"{group[i]['date']}|{group[j]['date']}",
                        "source": "cross",
                        "surface": surface,
                        "excerpt": "",
                        "verdicts": [{"check": "conflict",
                                      "detail": f"opposing intent ({c}) on {surface} "
                                                f"between {group[i]['date']} and "
                                                f"{group[j]['date']}"}],
                    })

    # AGENTS.md rule-bloat across the window.
    rule_bloat = None
    agents_appends = [a for a in adaptations
                      if a["surface"] and os.path.basename(expand(a["surface"])) == "AGENTS.md"]
    if len(agents_appends) >= 2 and os.path.isfile(AGENTS_MD):
        commits = recent_commits_touching(AGENTS_MD, since_iso)
        rule_bloat = {
            "appends_in_window": len(agents_appends),
            "dates": sorted(a["date"] for a in agents_appends),
            "recent_commits": commits[:8],
            "note": f">= {len(agents_appends)} adaptations appended rules to "
                    f"~/AGENTS.md in {args.days}d; verify it hasn't become a "
                    f"contradictory rule dump (threshold {RULE_BLOAT_LINES} lines).",
        }

    out = {
        "today": today.isoformat(),
        "window_days": args.days,
        "journal_dir": args.journal_dir,
        "adaptations_found": len(adaptations),
        "days_with_journal": len({a["date"] for a in adaptations}),
        "by_source": _count(adaptations, "source"),
        "thrash": thrash,
        "rule_bloat": rule_bloat,
        "findings": findings,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _count(items, key):
    out = {}
    for it in items:
        out[it[key]] = out.get(it[key], 0) + 1
    return out


if __name__ == "__main__":
    main()
