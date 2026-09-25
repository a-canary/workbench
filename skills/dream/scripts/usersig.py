#!/usr/bin/env python3
"""
DRY user-statement proposal extractor (Phase 1b of /dream).

Walks the same session roots as pipeline.py, but reads user-role records
instead of paginating the full transcript. Clusters directive-shaped user
statements that repeat in the window (or one explicit "+rule:" / "Policy:"
declaration) and writes a proposal doc + a beads HITL row. NEVER edits a
skill file — that's the operator's call after reading the proposal.

Pipeline:
    sessions (mtime in window)
       │  extract user-role text
       ▼  filter (skip acks / system-reminders / tool-results / paste-noise)
       │  directive-shape (imperative verb OR explicit framing)
       ▼
       │  cluster (SequenceMatcher ratio >= 0.65)
       ▼
       │  target-surface map (GLOBAL-RULES / <skill> / <repo>/AGENTS.md / drop)
       ▼
~/.claude/dream/proposals/usersig-YYYY-MM-DD.md   (append-only)
       │
       ▼  emit a beads row (HITL type) pointing at the proposal doc
       │  (skipped if --no-bead flag; on dry-run both are skipped)

State: ~/.claude/dream/state/usersig-processed.json — incremental mtime
key (mirrors pipeline.py's processed.json).

Usage:
    usersig.py --window 48h                   # default
    usersig.py --window 7d
    usersig.py --window 48h --dry-run         # print + count, no writes
    usersig.py --no-bead                      # write proposal doc, skip bead
    usersig.py --sessions /p/a.jsonl /p/b.jsonl  # scan a specific set
"""

import argparse
import difflib
import json
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path.home() / ".claude" / "dream" / "state"
PROPOSALS_DIR = Path.home() / ".claude" / "dream" / "proposals"
PROCESSED_FILE = STATE_DIR / "usersig-processed.json"

SESSION_ROOTS = [
    Path.home() / ".claude" / "projects",
    Path.home() / ".pi" / "agent" / "sessions",
]

# Records to drop BEFORE the directive-shape test.
NOISE_PREFIX = (
    "this session is being continued",
    "base directory for this skill",
    "[request interrupted by user",
)
NOISE_EXACT = {
    "yes", "ok", "go", "resume", "proceed", "ping", "done",
    "a", "b", "c", "d", "1by1", "1 and 2. keep me in the loop",
    "yes  (policy, choices.md, missions.md, scope) counsel should only present arguements if against it",
}
NOISE_STARTS = (
    "[tool_result",  # pure tool-result content blocks
    "[pi-midrun-compact/v1]",
    "<command-message>",
    "<system-reminder>",
    "<skill name=",
    "{",  # pure JSON dump
)

# Imperative-verb opener — directive-shape signal.
DIRECTIVE_VERB = re.compile(
    r"^\s*(use|stop|drop|skip|add|fix|make|don't|never|always|avoid|prefer|"
    r"write|update|move|delete|remove|create|kill|ship|land|merge|commit|"
    r"verify|check|run|set|keep|assume|consider|examine|analyse|analyze|"
    r"propose|suggest|recommend|ensure|require|request|tell|summarize|"
    r"deprecate|archive|promote|publish|deploy|investigate|address|"
    r"replace|rename|rename|reduce|increase|disable|enable|refactor|"
    r"rebuild|redo|restart|recheck|review|reassess|revisit)\b",
    re.I,
)

# Explicit framing tokens → operator is *declaring* a rule, not typing a task.
EXPLICIT_FRAMING = re.compile(
    r"(\+rule:|\+policy:|\+todo:|\+bd:|\+feedback:|\+oss|\+todo"
    r"|\bglobal rule:|\bglobal agents\.md rule:|\bpolicy:|"
    r"\bpolicy\s*\|\s*global rule:)",
    re.I,
)

# Token-noise disambiguation: paste-confirm repeats typed during a credential
# exchange; not rules.  Keyed by lowercase prefix to allow partial-line match.
PASTE_NOISE_PREFIX = (
    "i updated cf token permissions",
    "your cf token has all permissions",
    "pass for trading has not changed",
    "i updated",
    "just updated",
    "i have addded r2",
    "ok i have addded",
    "curl ",
    "```",  # terminal / curl / token paste blocks
)


# ---------- session / record extraction ----------


def get_role(rec: dict) -> str | None:
    r = rec.get("role")
    if r:
        return r
    if rec.get("type") == "message":
        msg = rec.get("message") or {}
        return msg.get("role")
    return None


def get_text(content) -> str:
    """Pull only pure text from content blocks. Tool_use/tool_result alone → empty."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for c in content:
            if isinstance(c, dict):
                t = c.get("type")
                if t in ("text", "input_text", "output_text"):
                    txt = c.get("text", "")
                    if txt:
                        parts.append(txt)
                # ignore tool_use, tool_result, image, etc.
            elif isinstance(c, str):
                parts.append(c)
        return " ".join(parts).strip()
    if isinstance(content, dict):
        return get_text(content.get("content", ""))
    return ""


def in_window(path: Path, window_seconds: int) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) <= window_seconds
    except OSError:
        return False


def parse_window(s: str) -> int:
    m = re.fullmatch(r"(\d+)\s*([hdw])", s.strip(), re.I)
    if not m:
        raise SystemExit(f"bad --window: {s!r} (use 48h | 7d | 1w)")
    n, unit = int(m.group(1)), m.group(2).lower()
    mult = {"h": 3600, "d": 86400, "w": 7 * 86400}[unit]
    return n * mult


def is_noise(text: str) -> bool:
    s = text.strip()
    if len(s) < 15:
        return True
    low = s.lower()
    if low in NOISE_EXACT:
        return True
    if any(low.startswith(p) for p in NOISE_PREFIX):
        return True
    if any(s.startswith(p) for p in NOISE_STARTS):
        return True
    if any(low.startswith(p) for p in PASTE_NOISE_PREFIX):
        return True
    return False


def is_directive(text: str) -> bool:
    first_line = text.strip().split("\n", 1)[0].strip()
    if DIRECTIVE_VERB.match(first_line) or EXPLICIT_FRAMING.search(text):
        return True
    # Also count short imperative-style sentences that begin with the rule
    # word itself (e.g. "don't trust...", "never assume...").
    if re.match(r"^\s*(never|always|don't|do not|stop|skip|drop|use)\b", first_line, re.I) and len(text) < 400:
        return True
    return False


def user_records_in_session(path: Path, window_seconds: int) -> list[tuple[int, str]]:
    if not in_window(path, window_seconds):
        return []
    out = []
    try:
        with open(path, "r", errors="replace") as f:
            for ln, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if get_role(rec) not in ("user", "human"):
                    continue
                inner = rec.get("message", rec)
                content = inner.get("content") if isinstance(inner, dict) else None
                text = get_text(content).strip()
                if not text or is_noise(text):
                    continue
                if len(text) > 1500:
                    continue  # skip paste-dumps; rules don't live in paste-dumps
                out.append((ln, text))
    except OSError:
        pass
    return out


# ---------- clustering ----------


def norm(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def cluster(records: list[tuple[int, str]], threshold: float = 0.65):
    """Greedy single-pass cluster: walk records, attach to first match >= threshold,
    else open new cluster. Returns dict cluster_id -> list of (line, text)."""
    clusters: list[list[tuple[int, str]]] = []
    centroids: list[str] = []
    for ln, text in records:
        n = norm(text)
        if not n:
            continue
        best_i, best_sm = -1, 0.0
        for i, c in enumerate(centroids):
            sm = difflib.SequenceMatcher(None, n, c).ratio()
            if sm > best_sm:
                best_sm, best_i = sm, i
        if best_sm >= threshold:
            clusters[best_i].append((ln, text))
            # refresh centroid to longest member (more representative)
            longest = max((norm(t) for _, t in clusters[best_i]), key=len)
            centroids[best_i] = longest
        else:
            clusters.append([(ln, text)])
            centroids.append(n)
    return clusters


# ---------- target-surface mapping ----------


def target_surface(text: str) -> tuple[str, str]:
    """Return (target, one-line insertion hint). Best-guess from keywords."""
    low = text.lower()
    # GLOBAL-RULES
    if re.search(r"\bglobal\b.*\b(rule|agents\.md)", low) or "global agents.md rule" in low:
        return "GLOBAL-RULES.md", "Always-on universal rules section"
    if re.search(r"\+policy\s*\|", low) or re.search(r"\bpolicy:", low):
        return "GLOBAL-RULES.md", "Always-on universal rules section"
    if re.search(r"\+rule\b", low):
        return "GLOBAL-RULES.md", "Always-on universal rules section"
    # Director / role codification
    if re.search(r"\b(director|driver|captain|overseer|monitor)\b.*\b(role|hitl|afk)\b", low) or \
       re.search(r"\bafk\b", low) and re.search(r"\b(until|direct)\b", low):
        return "skills/director/SKILL.md", "Director mode-aware behaviour section"
    # Beads / +<tag>: shorthand
    if re.search(r"\+(todo|bd|feedback|policy|rule)\b", low) or "bead" in low:
        return ("skills/beads/SKILL.md", "Operator shorthand section"
                if "beads" in low else "Bead ticket-start section")
    # ke research
    if "ke research" in low or "bg ke" in low:
        return "skills/ke/SKILL.md", "Multi-topic research batches or recall section"
    # Merge conflict
    if re.search(r"\b(merge|conflict|branch(es)?)\b", low) and "decompos" in low:
        return "skills/resolving-merge-conflicts/SKILL.md", "Concept-decompose mode"
    # Estate / repo hygiene
    if re.search(r"\b(repos?|disk|trash|archive|discard)\b", low) and \
       re.search(r"\b(reason|permission|before)\b", low):
        return "skills/estate-hygiene/SKILL.md", "Hard gates section"
    # Default: GLOBAL-RULES (broadest; safest fallback)
    return "GLOBAL-RULES.md", "Always-on universal rules section"


# ---------- proposal doc + bead ----------


def render_proposal(date_str: str, window: str, sessions: int,
                    candidates: list[dict], noise_count: int) -> str:
    lines = []
    lines.append(f"# User-statement DRY proposals — {date_str}")
    lines.append("")
    lines.append(f"Window: {window} (mtime)  •  Sessions scanned: {sessions}  "
                 f"•  Candidates: {len(candidates)}  •  Noise filtered: {noise_count}")
    lines.append("")
    if not candidates:
        lines.append("> No repeating directive patterns found in this window.")
        lines.append("")
        return "\n".join(lines)

    repeats = [c for c in candidates if c["kind"] == "repeat"]
    oneoffs = [c for c in candidates if c["kind"] == "explicit"]

    if repeats:
        lines.append("## Repeating directives")
        lines.append("")
        for c in repeats:
            target = c["target"]
            lines.append(f"### `{target}`: {c['summary']}")
            lines.append(f"- window occurrences: {c['count']}  •  sessions: {c['sessions']}  "
                         f"•  framing: {c['framing']}")
            lines.append("- verbatim:")
            for line in c["verbatim"].split("\n")[:6]:
                lines.append(f"  > {line[:240]}")
            lines.append(f"- proposed insertion: `{target}` → {c['insertion']}")
            lines.append(f"- rationale: {c['rationale']}")
            lines.append("")

    if oneoffs:
        lines.append("## One-off explicit rule declarations")
        lines.append("")
        for c in oneoffs:
            target = c["target"]
            lines.append(f"### `{target}`: {c['summary']}")
            lines.append("- verbatim:")
            for line in c["verbatim"].split("\n")[:6]:
                lines.append(f"  > {line[:240]}")
            lines.append(f"- proposed insertion: `{target}` → {c['insertion']}")
            lines.append(f"- rationale: {c['rationale']}")
            lines.append("")

    lines.append("## Noise ledger (drop, do not propose)")
    lines.append(f"- {noise_count} records filtered as noise/acks/system-reminders")
    lines.append("")
    return "\n".join(lines)


def session_short(path: Path) -> str:
    return f"{path.parent.name}/{path.stem}"[:60]


def summarize(text: str) -> str:
    """One-line summary of a repeated statement, max ~100 chars."""
    t = re.sub(r"\s+", " ", text.strip())
    # cut at first sentence-ish terminator
    cut = re.split(r"[.\n!?]", t, maxsplit=1)[0]
    if len(cut) > 110:
        cut = cut[:107] + "..."
    return cut


def framing_label(text: str) -> str:
    if EXPLICIT_FRAMING.search(text):
        m = EXPLICIT_FRAMING.search(text)
        return f"explicit ({m.group(0).rstrip(':').strip()})"
    if DIRECTIVE_VERB.match(text):
        m = DIRECTIVE_VERB.match(text)
        return f"imperative ({m.group(1).lower()})"
    return "rule-shape"


def emit_bead(date_str: str, proposal_path: Path) -> None:
    """Best-effort: file a HITL bead pointing at the proposal doc.
    Tries beads_create tool env, then falls back to a `bd create` shell call.
    Silently no-ops if neither is wired — the proposal doc is the durable artifact.
    """
    title = f"usersig-{date_str}: review DRY user-statement proposals"
    desc = (
        f"Phase 1b of /dream produced proposal doc at\n\n"
        f"  {proposal_path}\n\n"
        f"Review the candidates, decide which to apply (and to which surface), "
        f"then apply manually or hand off to a driver. Do not auto-apply."
    )
    # Try the in-process tool first (some pi-agent harnesses expose it).
    tool_fn = globals().get("beads_create") or globals().get("bd")
    if callable(tool_fn):
        try:
            return tool_fn({
                "title": title,
                "type": "task",
                "labels": "usersig,review",
                "description": desc,
            })
        except Exception:
            pass
    # Fallback to shell — `bd` CLI is the standard arc-skills edge.
    import subprocess
    try:
        subprocess.run([
            "bd", "create", title,
            "--type", "task",
            "--label", "usersig",
            "--label", "review",
            "--description", desc,
        ], check=False, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


# ---------- main ----------


def discover_sessions(window_seconds: int,
                      explicit: list[str] | None) -> list[Path]:
    if explicit:
        return [Path(p) for p in explicit]
    out = []
    for root in SESSION_ROOTS:
        if not root.exists():
            continue
        for p in root.rglob("*.jsonl"):
            if in_window(p, window_seconds):
                out.append(p)
    return sorted(out)


def load_processed() -> dict:
    if PROCESSED_FILE.exists():
        try:
            with open(PROCESSED_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {"sessions": {}}


def save_processed(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with open(PROCESSED_FILE, "w") as f:
        json.dump(data, f, indent=2)


def is_unprocessed(path: Path, processed: dict) -> bool:
    key = f"{path.parent.name}/{path.stem}"
    try:
        cur = path.stat().st_mtime
    except OSError:
        return False
    rec = processed["sessions"].get(key)
    if not rec:
        return True
    return rec.get("source_mtime", 0) < cur


def mark_processed(path: Path, processed: dict) -> None:
    key = f"{path.parent.name}/{path.stem}"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return
    processed["sessions"][key] = {
        "processed": datetime.now(timezone.utc).isoformat(),
        "source_mtime": mtime,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--window", default="48h", help="mtime window (48h, 7d, 1w)")
    ap.add_argument("--dry-run", action="store_true", help="don't write files or bead")
    ap.add_argument("--no-bead", action="store_true", help="write proposal doc but skip bead")
    ap.add_argument("--threshold", type=float, default=0.65,
                    help="SequenceMatcher ratio for cluster attach (default 0.65)")
    ap.add_argument("--sessions", nargs="*", help="explicit session JSONLs to scan")
    args = ap.parse_args(argv)

    window_seconds = parse_window(args.window)
    date_str = datetime.now().strftime("%Y-%m-%d")

    sessions = discover_sessions(window_seconds, args.sessions)
    processed = load_processed()
    target_sessions = [s for s in sessions if is_unprocessed(s, processed)]

    print(f"# usersig: {date_str}  window={args.window}  sessions={len(sessions)}  "
          f"unprocessed={len(target_sessions)}", file=sys.stderr)

    # Collect directive records across all unprocessed sessions.
    all_directive: list[tuple[Path, int, str, bool]] = []  # (path, line, text, explicit)
    total_noise = 0
    total_scanned = 0
    per_session_counts: dict[str, int] = {}
    for s in target_sessions:
        records = user_records_in_session(s, window_seconds)
        directive_in_session = 0
        for ln, text in records:
            total_scanned += 1
            if not is_directive(text):
                total_noise += 1
                continue
            directive_in_session += 1
            explicit = bool(EXPLICIT_FRAMING.search(text))
            all_directive.append((s, ln, text, explicit))
        per_session_counts[session_short(s)] = directive_in_session

    # Cluster by SequenceMatcher.
    clusters = cluster([(ln, text) for _, ln, text, _ in all_directive],
                       threshold=args.threshold)

    # Build candidates: >=2 occurrences OR explicit framing.
    candidates: list[dict] = []
    for cluster_records in clusters:
        # map back to (path, line, text, explicit)
        recs = []
        for ln, text in cluster_records:
            for s, sln, stext, sexp in all_directive:
                if sln == ln and stext == text:
                    recs.append((s, sln, stext, sexp))
                    break
        if not recs:
            continue
        any_explicit = any(r[3] for r in recs)
        if len(recs) < 2 and not any_explicit:
            continue  # one-off, no explicit framing → drop
        # Pick representative (longest verbatim).
        rep_text = max((r[2] for r in recs), key=len)
        target, insertion = target_surface(rep_text)
        sessions_touched = {session_short(r[0]) for r in recs}
        candidates.append({
            "kind": "explicit" if (any_explicit and len(recs) < 2) else "repeat",
            "summary": summarize(rep_text),
            "count": len(recs),
            "sessions": len(sessions_touched),
            "framing": framing_label(rep_text),
            "verbatim": rep_text,
            "target": target,
            "insertion": insertion,
            "rationale": (
                "explicit '+rule:/Policy:' framing → operator declaring a rule; one occurrence is enough"
                if any_explicit and len(recs) < 2
                else f"repeats {len(recs)}x across {len(sessions_touched)} sessions in the window"
            ),
        })

    # Rank: explicit first (one-off declarations are usually higher-impact), then by count desc.
    candidates.sort(key=lambda c: (0 if c["kind"] == "explicit" else 1, -c["count"]))

    proposal = render_proposal(
        date_str=date_str,
        window=args.window,
        sessions=len(target_sessions),
        candidates=candidates,
        noise_count=total_noise,
    )

    if args.dry_run:
        print(proposal)
        print(f"\n# candidates={len(candidates)}  noise={total_noise}",
              file=sys.stderr)
        return 0

    PROPOSALS_DIR.mkdir(parents=True, exist_ok=True)
    proposal_path = PROPOSALS_DIR / f"usersig-{date_str}.md"
    proposal_path.write_text(proposal)

    if not args.no_bead:
        emit_bead(date_str, proposal_path)

    for s in target_sessions:
        mark_processed(s, processed)
    save_processed(processed)

    print(f"# wrote {proposal_path}  candidates={len(candidates)}  noise={total_noise}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
