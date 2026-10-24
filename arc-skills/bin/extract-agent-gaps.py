#!/usr/bin/env python3
"""Stage 1 of the nightly knowledge-gap loop: extract topics/facts the AGENT was
confused about from recent sessions, append-only to a dense log.

Signal = the agent's own confusion: a fact it got wrong, a topic it was uncertain
on, a thing the user had to correct. NOT user-experience friction.

Cheap+wide half of a CAM loop (slow lane via arc-llm-proxy at 127.0.0.1:8091,
`hygiene` alias). The smart half — rank by severity x frequency, then reconcile
against AGENTS.md / MEMORY.md / ke — runs as a stage in nightly-self-improve.sh.

Output: one dense pipe-delimited line per gap, appended to GAP_LOG:
  YYYY-MM-DD | topic | one-line fact-the-agent-was-confused-about | session8
Append-only: the log is the accumulating frequency signal stage 2 ranks over.
"""
import json, re, sys, time, urllib.error, urllib.request
from datetime import date, timedelta
from pathlib import Path

# Both harnesses: claude sessions are flat; pi sessions nest per project slug.
SESSIONS_DIRS = [
    Path.home() / ".claude/projects" / str(Path.home()).replace("/", "-"),
    Path.home() / ".pi/agent/sessions",
]
GAP_LOG = Path.home() / ".claude/dream/agent-gaps.log"   # append-only, dense
ENDPOINT = "http://127.0.0.1:8091/v1/chat/completions"   # arc-llm-proxy
MODEL = "hygiene"   # slow-lane alias (stable handle; backend is a config swap)
KEYS_FILE = Path.home() / "repos/arc-llm-proxy/deploy/keys.local.json"


def _factory_key() -> str:
    d = json.loads(KEYS_FILE.read_text())
    for k, v in d.items():
        if (isinstance(v, dict) and v.get("user") == "factory") or v == "factory":
            return k
    raise SystemExit(f"factory key not found in {KEYS_FILE}")
CHAR_BUDGET = 90_000              # ~28k tokens
MIN_TURNS = 2                    # need some dialogue to judge confusion
MAX_SESSIONS = 8                # keep the serial run bounded

PROMPT = """You are auditing a coding-agent transcript for the AGENT's OWN knowledge gaps.

Report only TOPICS or FACTS the agent was confused about: something it got factually wrong, was visibly uncertain about, guessed at, or that the user had to correct. Focus on durable, reusable knowledge (an API's behavior, a provider's limits, a config path, a tool's contract, a project constraint) — NOT one-off typos or transient state.

A gap requires EVIDENCE OF ERROR in the transcript: a wrong action, a visible guess, a retry after failure, or a user correction. An agent that states a fact correctly, cites a rule it is following, or narrates a precaution it took is NOT a gap — it already had that knowledge. Skip it. Recited doctrine (rotation rules, timestamp handling, which runner to use) is the single largest source of false gaps; report it only if the agent actually got it wrong first.

For each, give: a short topic (2-5 words, the reusable subject) and a one-line fact stating what the correct knowledge is (what the agent should have known).

Return STRICT JSON: {"gaps": [{"topic": "<2-5 word subject>", "fact": "<one line: the correct fact the agent lacked>"}]}
Empty list if the agent showed no knowledge gaps. No prose outside the JSON.

TRANSCRIPT:
"""


def yesterday_sessions() -> list[Path]:
    y = date.today() - timedelta(days=1)
    out = []
    for d in SESSIONS_DIRS:
        out += [p for p in d.rglob("*.jsonl")
                if date.fromtimestamp(p.stat().st_mtime) == y]
    out.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return out[:MAX_SESSIONS]


def _text(content) -> str:
    """Real prose from a message: the string itself, or the joined text-type
    blocks of list content. Ignores tool_result/tool_use blocks — user turns are
    mostly harness-wrapped tool_results, which are noise, not user prose."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content
                        if isinstance(b, dict) and b.get("type") == "text").strip()
    return ""


def _is_noise(s: str) -> bool:  # tags, hooks, system-reminders, interrupt markers
    return (not s or s.startswith("<") or s.startswith("[")
            or "system-reminder" in s[:60] or "hook" in s[:20].lower())


def transcript_text(path: Path) -> tuple[str, int]:
    """User + agent text in order, for confusion judgement. Returns (text, n_turns).
    User text lives as a bare string OR text blocks inside list content — capture both."""
    lines, n = [], 0
    for raw in path.read_text(errors="replace").splitlines():
        try:
            o = json.loads(raw)
        except Exception:
            continue
        typ = o.get("type")
        if typ == "message":  # pi format: {"type":"message","message":{"role":...}}
            typ = o.get("message", {}).get("role")
        if typ not in ("user", "assistant"):
            continue
        s = _text(o.get("message", {}).get("content"))
        if not s or (typ == "user" and _is_noise(s)):
            continue
        n += 1
        lines.append(f"{'USER' if typ == 'user' else 'AGENT'}: {s}")
    return "\n".join(lines), n


def ask(transcript: str) -> list[dict]:
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT + transcript[:CHAR_BUDGET]}],
        "temperature": 0.2,
        "max_tokens": 4000,  # reasoning model — leaves room for <think> + JSON
    }).encode()
    req = urllib.request.Request(
        ENDPOINT, data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_factory_key()}",
        },
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=900) as r:  # slow lane: queue-wait
                content = json.loads(r.read())["choices"][0]["message"]["content"]
            break
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 2:
                time.sleep(int(e.headers.get("Retry-After") or 0) or 10 * (2 ** attempt))
                continue
            raise
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)  # strip reasoning
    start, end = content.find("{"), content.rfind("}")
    if start == -1 or end == -1:
        return []
    return json.loads(content[start:end + 1]).get("gaps", [])


def clean(s: str) -> str:
    return " ".join(str(s).split()).replace("|", "/")  # keep the pipe delimiter safe


# Recited-doctrine denylist: facts the judge keeps logging as "gaps" even though
# the agent recited them CORRECTLY and they're already covered on a surface.
# Prompt warnings (line ~33) didn't stop the pattern (recurred 8-01/8-07/8-08),
# so enforce deterministically pre-append. Family-first remediation 2026-08-12:
# rotation rule verified live 7-26; created_at formats live in MEMORY.md
# (reference_ledger_created_at_formats.md); tsx-vs-bun remediated 7-19.
RECITED_DOCTRINE = [
    re.compile(r"\bstate rotation|derive[ds]? from (the )?read value|"
               r"compute .* from (the )?read value", re.I),
    re.compile(r"\bcreated_at\b", re.I),
    re.compile(r"\btsx\b .*\bbun\b|\bbun\b .*\btsx\b|"
               r"bun:sqlite|new Database\(\) instead of \.open\(\)", re.I),
    # 2026-08-26: "JSON parsing on state.json" family (~9 lines 8-07..8-16)
    # verified collector artifact — no cited session ever failed a parse;
    # live ~/vault/oversight/state.json is single-line {"next":"..."}.
    re.compile(r"\bstate\.json\b", re.I),
]


def is_recited_doctrine(topic: str, fact: str) -> bool:
    blob = f"{topic} {fact}"
    return any(rx.search(blob) for rx in RECITED_DOCTRINE)


def main() -> int:
    sessions = yesterday_sessions()
    if not sessions:
        print("no sessions from yesterday", file=sys.stderr)
        return 0
    GAP_LOG.parent.mkdir(parents=True, exist_ok=True)
    day = (date.today() - timedelta(days=1)).isoformat()

    rows, first = [], True
    for path in sessions:
        transcript, n = transcript_text(path)
        if n < MIN_TURNS:
            continue
        first = False
        try:
            gaps = ask(transcript)
        except Exception as e:
            print(f"FAIL session={path.stem} err={e}", file=sys.stderr)
            continue
        for g in gaps:
            topic, fact = clean(g.get("topic", "")), clean(g.get("fact", ""))
            if topic and fact and not is_recited_doctrine(topic, fact):
                rows.append(f"{day} | {topic} | {fact} | {path.stem[:8]}")
        print(f"session={path.stem[:8]} turns={n} gaps={len(gaps)}")

    if rows:
        with GAP_LOG.open("a") as fh:  # append-only
            fh.write("\n".join(rows) + "\n")
        print(f"appended {len(rows)} gaps -> {GAP_LOG}")
    else:
        print("no agent gaps")
    return 0


if __name__ == "__main__":
    sys.exit(main())
