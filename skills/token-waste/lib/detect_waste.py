#!/usr/bin/env python3
"""
Detect token-waste candidates in a Claude conversation JSONL.

This is the deterministic pre-pass for the token-waste skill (mirrors dream's
extract.py, but the target is context pollution rather than agent effectiveness).

It correlates each tool_use with its tool_result (by tool_use_id), measures how
many tokens each tool dumped into context, and flags patterns where a cheaper
tool/usage would have loaded far less:

  - full_file_read    Read of a whole large file when a Grep + targeted read would do
  - reread            same file Read 2+ times (content already in context)
  - bash_dump         Bash whose stdout is large AND not redirected to a file
  - no_grep_first     large Read with no Grep of that path earlier in the session
  - unreferenced      large tool_result whose distinctive tokens never reappear
                      in any later assistant message (loaded, never used)

It ALSO walks the instruction context — the directive text the harness injects as
`attachment` messages, NOT as tool results: skill bodies re-injected on every turn
(`invoked_skills`), the skill catalog (`skill_listing`), memory/CLAUDE.md/AGENTS.md
(`nested_memory`), and the recurring `<system-reminder>` blocks (`task_reminder`).
These never flow through tool_use/tool_result, so the result-only passes above are
blind to them — yet they are the heaviest, most repetitive context in a session (a
4k-token skill body re-injected 250× is ~1M tokens). It flags instructions that are:

  - repeated_instruction   the same instruction block injected N+ times (a skill body
                           re-pasted every turn, the catalog re-listed) — deterministic;
                           charges the aggregate cost of every copy past the first
  - instruction_review     a large instruction block shortlisted with a bounded excerpt
                           for the analyst to classify as `obvious_instruction`
                           (extreme-obvious filler) or `confusing_instruction`
                           (contradictory/ambiguous) — the analyst resolves the tag

Output is JSON: a list of candidate events the LLM analyst then scores. The LLM
never sees the raw transcript — only this shortlist — so the tool that hunts
token waste does not itself waste tokens.

Usage:
    python detect_waste.py SESSION.jsonl --project NAME [--chars-per-token 4]
    # prints a JSON object to stdout
"""

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# A tool_result above this many estimated tokens is "large" — worth scrutinising.
LARGE_RESULT_TOKENS = 1500
# A Read result above this is a candidate full-file-read even on its own.
BIG_READ_TOKENS = 2000
# Min distinctive tokens to sample when checking if a result was ever referenced.
REF_SAMPLE = 12
# Jaccard overlap (on shingled content) above which two large results count as
# substantially the same content loaded twice → a `repeated` candidate.
REPEAT_OVERLAP = 0.6
# Excerpt size (chars from head + tail) handed to the analyst so it can judge a
# result's *content quality* (obvious / confusing) without ever loading the raw
# transcript. The LLM sees only these bounded snippets, never the full result.
EXCERPT_HEAD = 700
EXCERPT_TAIL = 400
# A large result is shortlisted for content-quality review (obvious/confusing).
QUALITY_REVIEW_TOKENS = 1500
# Cap on low_value_content review requests per session. These carry excerpts and
# go to the LLM, so we only send the biggest few — reviewing the largest results
# first is where the token-quality payoff is. Keeps the analyst's bill bounded.
MAX_QUALITY_REVIEW = 12
# Hard cap on candidates written to the per-session JSON. The analyst reads this
# file WHOLE to score it, so an unbounded list (231 hits / ~26k tokens on a noisy
# session) turns the waste-hunter into the day's biggest bleed. The list is
# size-ordered, so the kept slice holds every high-impact hit the adapter acts
# on; the sub-300-token tail is noise. The headline `candidate_wasted_tokens` is
# computed from the FULL list before the trim, so the true total is preserved.
MAX_CANDIDATES = 40

# --- Instruction-context thresholds -------------------------------------------
# Instruction context is the directive text the harness *re-injects* as attachment
# messages (skill bodies, the skill catalog, memory/CLAUDE.md, system-reminders) —
# NOT tool results. A 4k-token skill body re-pasted 250× is ~1M tokens, so the unit
# of waste here is the AGGREGATE re-injection cost, not one copy.
#
# A single instruction block this large is worth reviewing for content quality
# (one copy — obvious filler or confusing/contradictory directive text).
INSTRUCTION_REVIEW_TOKENS = 800
# An instruction block re-injected at least this many times is a repeated_instruction
# candidate — the second copy onward is the avoidable cost.
REPEAT_INSTRUCTION_MIN = 3
# Only the aggregate re-injection cost above this is worth flagging (small blocks
# re-pasted a few times aren't worth an adaptation).
REPEAT_INSTRUCTION_MIN_WASTED = 2000
# Cap instruction content-quality review requests per session (they carry excerpts
# to the LLM, same bounded-cost discipline as MAX_QUALITY_REVIEW).
MAX_INSTRUCTION_REVIEW = 8
# Session-wide ceiling on total excerpt BYTES written to the per-session JSON.
# The caps above bound excerpt COUNT, not size: ~20 reviews x 1100 chars put ~14k
# of the largest 2026-08-02 file's 28k into excerpts alone, and the analyst reads
# that file WHOLE by design. Excerpts are spent largest-result-first; once the
# budget is gone the tail keeps its metadata but drops the snippet, so every
# high-impact judgement keeps context and the waste-hunter stops being the day's
# own top bleed.
MAX_EXCERPT_BYTES_PER_SESSION = 6000


def est_tokens(text: str, chars_per_token: float) -> int:
    if not text:
        return 0
    return int(len(text) / chars_per_token)


# pi lowercase tool names -> canonical Claude names, so the Read/Grep/Glob
# linkage below keys identically on both sources.
_PI_TOOL_NAMES = {
    "bash": "Bash", "read": "Read", "write": "Write", "edit": "Edit",
    "glob": "Glob", "grep": "Grep", "task": "Task", "webfetch": "WebFetch",
    "websearch": "WebSearch", "ls": "LS", "multiedit": "MultiEdit",
    "notebookedit": "NotebookEdit", "todowrite": "TodoWrite",
}


def canonicalize_message(inner: dict) -> dict:
    """Normalize a `pi` agent message to the canonical Claude JSONL shape.

    Only the tool schema diverges: pi assistant `toolCall` blocks become
    `tool_use` blocks, and pi top-level `toolResult` messages become a `user`
    message carrying one `tool_result` block. Interactive Claude Code is already
    canonical and passes through untouched, so the tool_use/tool_result linkage
    below counts tokens on both sources. Without this, pi sessions show zero
    tool traffic and the day reads falsely "clean".
    """
    if not isinstance(inner, dict):
        return inner
    if inner.get("role") == "toolResult":
        return {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": inner.get("toolCallId", ""),
                "is_error": inner.get("isError", False),
                "content": inner.get("content", ""),
            }],
        }
    content = inner.get("content")
    if isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "toolCall" for b in content
    ):
        new_content = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "toolCall":
                name = b.get("name", "unknown")
                new_content.append({
                    "type": "tool_use",
                    "id": b.get("id", ""),
                    "name": _PI_TOOL_NAMES.get(name, name),
                    "input": b.get("arguments", {}),
                })
            else:
                new_content.append(b)
        return {**inner, "content": new_content}
    return inner


def text_of(content) -> str:
    """Flatten a content field (string or block list) to plain text."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for b in content:
            if isinstance(b, dict):
                t = b.get("type", "")
                if t == "text":
                    out.append(b.get("text", ""))
                elif t == "tool_result":
                    out.append(text_of(b.get("content", "")))
                elif t == "thinking":
                    out.append(b.get("thinking", ""))
            elif isinstance(b, str):
                out.append(b)
        return "\n".join(out)
    return ""


def distinctive_tokens(text: str) -> list[str]:
    """Pull rare-ish identifier-like tokens to test for later reference."""
    toks = re.findall(r"[A-Za-z_][A-Za-z0-9_]{6,}", text)
    seen, uniq = set(), []
    for t in toks:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    # sample from the middle so we skip boilerplate headers
    mid = uniq[len(uniq) // 4 : len(uniq) // 4 + REF_SAMPLE]
    return mid or uniq[:REF_SAMPLE]


def excerpt(text: str) -> str:
    """Bounded head+tail snippet so the analyst can judge content quality without
    the orchestrator ever feeding it the full result. Mirrors the project rule:
    the tool that hunts waste must not itself waste tokens."""
    text = text.strip()
    if len(text) <= EXCERPT_HEAD + EXCERPT_TAIL:
        return text
    return text[:EXCERPT_HEAD] + "\n…[snipped]…\n" + text[-EXCERPT_TAIL:]


def shingles(text: str, k: int = 5) -> set:
    """k-word shingle set for cheap content-overlap (Jaccard) between results.
    Word-level so it survives reformatting; lower-cased to ignore cosmetic diffs."""
    words = re.findall(r"[A-Za-z0-9_]+", text.lower())
    if len(words) < k:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i : i + k]) for i in range(len(words) - k + 1)}


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if not inter:
        return 0.0
    return inter / len(a | b)


def fingerprint(text: str) -> str:
    """Stable identity for an instruction block so re-injections of the *same* block
    group together. Normalises whitespace so cosmetic reflow doesn't split a group;
    keeps it a cheap hash rather than pairwise overlap because re-injected directive
    text is byte-identical copy-paste, not paraphrase."""
    import hashlib
    norm = re.sub(r"\s+", " ", text.strip()).lower()
    return hashlib.sha1(norm.encode("utf-8", "ignore")).hexdigest()[:16]


def instruction_blocks_from_attachment(att: dict, line_num: int):
    """Yield (kind, label, text) for each directive block in an attachment message.

    These are re-injected context the harness pastes outside the tool_use/tool_result
    channel — the heaviest, most repetitive context in a session and invisible to the
    result-only passes. We only surface kinds that carry standing INSTRUCTIONS (skill
    bodies, the skill catalog, memory, system-reminders); transient bookkeeping
    attachments (hook_success, deferred_tools_delta, goal_status, …) are skipped."""
    st = att.get("type", "")
    if st == "invoked_skills":
        # skill bodies re-injected every turn — one block per skill
        for s in att.get("skills", []):
            if isinstance(s, dict):
                nm = s.get("name", "?")
                txt = s.get("content", "") or ""
                if txt:
                    yield ("skill_body", f"skill:{nm}", txt)
    elif st == "skill_listing":
        txt = att.get("content", "") or ""
        if txt:
            yield ("skill_listing", "skill_catalog", txt)
    elif st == "nested_memory":
        c = att.get("content")
        txt = text_of(c) if not isinstance(c, str) else c
        if isinstance(c, dict):
            # content dicts wrap the text under a "text"/"content" field
            txt = c.get("text") or c.get("content") or json.dumps(c)
        if txt:
            yield ("memory", f"memory:{att.get('displayPath') or att.get('path','?')}", txt)
    elif st == "task_reminder":
        c = att.get("content", [])
        txt = text_of(c) if isinstance(c, list) else (c if isinstance(c, str) else "")
        if txt and txt.strip():
            yield ("system_reminder", "system_reminder", txt)


def parse(filepath: Path, chars_per_token: float):
    """Walk the JSONL once, building ordered events + tool_use/result linkage."""
    tool_uses = {}          # tool_use_id -> {tool, input, index, line}
    results = {}            # tool_use_id -> {text, tokens, index}
    assistant_texts = []    # (index, text) for later-reference checks
    grep_paths = []         # (index, path) of Grep/Glob targets
    read_order = []         # (index, file_path) in order
    instructions = []       # {kind, label, text, fp (fingerprint), tokens, index, line}
    order_index = 0

    with open(filepath, "r", encoding="utf-8") as f:
        for line_num, raw in enumerate(f, start=1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            # Instruction context arrives as top-level `attachment` messages, NOT as
            # role-tagged tool results — so it is handled before the role dispatch.
            if msg.get("type") == "attachment" and isinstance(msg.get("attachment"), dict):
                for kind, label, txt in instruction_blocks_from_attachment(msg["attachment"], line_num):
                    instructions.append({
                        "kind": kind, "label": label, "text": txt,
                        "fp": fingerprint(txt),
                        "tokens": est_tokens(txt, chars_per_token),
                        "index": order_index, "line": line_num,
                    })
                order_index += 1
                continue

            inner = msg.get("message") if isinstance(msg.get("message"), dict) else msg
            inner = canonicalize_message(inner)
            role = inner.get("role")
            content = inner.get("content")

            if role == "assistant" and isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use":
                        tid = b.get("id", "")
                        name = b.get("name", "")
                        inp = b.get("input", {}) or {}
                        tool_uses[tid] = {
                            "tool": name, "input": inp,
                            "index": order_index, "line": line_num,
                        }
                        if name == "Read":
                            read_order.append((order_index, inp.get("file_path", "")))
                        elif name in ("Grep", "Glob"):
                            grep_paths.append((order_index, inp.get("path", "") or inp.get("pattern", "")))
                    elif b.get("type") == "text":
                        assistant_texts.append((order_index, b.get("text", "")))
                order_index += 1

            elif role == "user" and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        tid = b.get("tool_use_id", "")
                        txt = text_of(b.get("content", ""))
                        results[tid] = {
                            "text": txt,
                            "tokens": est_tokens(txt, chars_per_token),
                            "index": order_index,
                        }
                order_index += 1

    return tool_uses, results, assistant_texts, grep_paths, read_order, instructions


def later_reference(sample: list[str], after_index: int, assistant_texts) -> bool:
    """Did any sampled token reappear in an assistant message after this result?"""
    if not sample:
        return True  # nothing distinctive to test → don't flag as unreferenced
    later = "\n".join(t for i, t in assistant_texts if i > after_index)
    return any(tok in later for tok in sample)


def detect_instruction_waste(instructions, candidates):
    """Emit waste candidates from the re-injected instruction context.

    Two shapes, mirroring the result-side passes:
      - repeated_instruction  the SAME block (same fingerprint) re-injected N+ times.
        Deterministic — the second copy onward is avoidable. We charge the AGGREGATE
        re-injection cost (every copy past the first), since that is what actually
        sat in the window, not the size of one copy.
      - instruction_review    one representative copy of a large block, with a bounded
        excerpt, for the analyst to classify as obvious_instruction (extreme-obvious
        filler the model already acts on) or confusing_instruction (contradictory /
        ambiguous directive text). The analyst resolves the tag; the detector can't.

    A block that is BOTH big and repeated yields both candidates — they target
    different fixes (trim the body vs. stop re-injecting it)."""
    groups = defaultdict(list)
    for blk in instructions:
        groups[blk["fp"]].append(blk)

    reviewed = 0
    for fp, blks in groups.items():
        first = blks[0]
        n = len(blks)
        per_copy = first["tokens"]

        # repeated_instruction: re-injected REPEAT_INSTRUCTION_MIN+ times and the
        # avoidable (post-first) cost clears the floor. system_reminders re-appear
        # by design every turn — they are still real cost, but flag them only when
        # the aggregate is large enough to be worth an adaptation.
        if n >= REPEAT_INSTRUCTION_MIN:
            wasted = per_copy * (n - 1)
            if wasted >= REPEAT_INSTRUCTION_MIN_WASTED:
                candidates.append({
                    "tool": "instruction",
                    "kind": first["kind"],
                    "tokens": wasted,
                    "per_copy_tokens": per_copy,
                    "injections": n,
                    "index": first["index"],
                    "line": first["line"],
                    "target": first["label"],
                    "pattern": "repeated_instruction",
                    "note": f"{first['kind']} re-injected {n}x (~{per_copy} tok each); "
                            f"{n - 1} avoidable copies = ~{wasted} tok",
                })

        # instruction_review: one big block → analyst judges obvious/confusing.
        # Review the single representative copy (size of one copy, not the aggregate)
        # because the content fix trims the body once; the aggregate is the repeated_
        # instruction concern. Cap to the biggest few, same discipline as the result side.
        if per_copy >= INSTRUCTION_REVIEW_TOKENS and reviewed < MAX_INSTRUCTION_REVIEW:
            candidates.append({
                "tool": "instruction",
                "kind": first["kind"],
                "tokens": per_copy,
                "injections": n,
                "index": first["index"],
                "line": first["line"],
                "target": first["label"],
                "pattern": "instruction_review",
                "note": "large instruction block — analyst to judge obvious/filler "
                        "or confusing/contradictory directive text",
                "excerpt": excerpt(first["text"]),
            })
            reviewed += 1


def detect(filepath: Path, project: str, chars_per_token: float) -> dict:
    tool_uses, results, assistant_texts, grep_paths, read_order, instructions = parse(
        filepath, chars_per_token
    )

    candidates = []
    read_counts = defaultdict(int)
    for _, fp in read_order:
        read_counts[fp] += 1
    # rank each Read occurrence of a path: 0 = first (legit), 1+ = re-read
    read_seen = defaultdict(int)
    read_rank = {}  # (index, fp) -> occurrence number
    for idx, fp in read_order:
        read_rank[(idx, fp)] = read_seen[fp]
        read_seen[fp] += 1

    total_tool_tokens = sum(r["tokens"] for r in results.values())
    grep_indices_by_path = defaultdict(list)
    for idx, p in grep_paths:
        grep_indices_by_path[p].append(idx)

    for tid, use in tool_uses.items():
        res = results.get(tid)
        if not res:
            continue
        tool = use["tool"]
        inp = use["input"]
        toks = res["tokens"]
        fp = inp.get("file_path", "")
        ev = {
            "tool": tool,
            "tokens": toks,
            "index": use["index"],
            "line": use["line"],
            "target": fp or inp.get("command", "") or inp.get("pattern", ""),
        }

        # full_file_read: a Read with no offset/limit pulling a big file
        if tool == "Read" and toks >= BIG_READ_TOKENS:
            if "offset" not in inp and "limit" not in inp:
                e = dict(ev); e["pattern"] = "full_file_read"
                e["note"] = "whole file read with no offset/limit"
                candidates.append(e)

        # reread: same path read again after the first time (rank >= 1 only;
        # the first read of a file is legitimate and not flagged)
        if tool == "Read" and fp and read_rank.get((use["index"], fp), 0) >= 1:
            e = dict(ev); e["pattern"] = "reread"
            e["note"] = f"file already Read earlier this session ({read_counts[fp]}x total)"
            e["count"] = read_counts[fp]
            candidates.append(e)

        # no_grep_first: big Read with no prior Grep/Glob of that path
        if tool == "Read" and toks >= BIG_READ_TOKENS and fp:
            prior_grep = any(i < use["index"] for i in grep_indices_by_path.get(fp, []))
            if not prior_grep:
                e = dict(ev); e["pattern"] = "no_grep_first"
                e["note"] = "large Read with no Grep of this path beforehand"
                candidates.append(e)

        # bash_dump: large Bash stdout not redirected to a file
        if tool == "Bash" and toks >= LARGE_RESULT_TOKENS:
            cmd = inp.get("command", "")
            redirected = (">" in cmd) or ("| tee" in cmd) or ("--output" in cmd) or ("-o " in cmd)
            if not redirected:
                e = dict(ev); e["pattern"] = "bash_dump"
                e["note"] = "large Bash output dumped to context, not piped to a file"
                candidates.append(e)

        # unreferenced: large result whose distinctive tokens never reappear later
        if toks >= LARGE_RESULT_TOKENS:
            sample = distinctive_tokens(res["text"])
            if not later_reference(sample, res["index"], assistant_texts):
                e = dict(ev); e["pattern"] = "unreferenced"
                e["note"] = "large result loaded but its content never referenced afterward"
                candidates.append(e)

        # obvious / confusing are CONTENT-quality judgements the detector can't make
        # deterministically — it only shortlists large results and attaches a bounded
        # excerpt so the analyst can decide. Any tool's output qualifies (doc, bash,
        # agent, read), not just instructions. One candidate carries both judgements;
        # the analyst tags it `obvious`, `confusing`, or drops it.
        if toks >= QUALITY_REVIEW_TOKENS:
            e = dict(ev); e["pattern"] = "low_value_content"
            e["note"] = "large result — analyst to judge if obvious/filler or confusing/contradictory"
            e["excerpt"] = excerpt(res["text"])
            candidates.append(e)

    # repeated: substantially the same content loaded 2+ times, ANY tool/path.
    # Generalises `reread` (same file path) to overlapping content — the same doc
    # fetched twice, a bash output re-dumped, two reads of the same region. We
    # compare large results pairwise by content shingles; the SECOND occurrence is
    # the wasteful one (the first legitimately introduced the content).
    large = sorted(
        ((tid, res) for tid, res in results.items() if res["tokens"] >= LARGE_RESULT_TOKENS),
        key=lambda kv: kv[1]["index"],
    )
    shingle_cache = {}
    for j in range(len(large)):
        tid_j, res_j = large[j]
        use_j = tool_uses.get(tid_j)
        if not use_j:
            continue
        sj = shingle_cache.setdefault(tid_j, shingles(res_j["text"]))
        for i in range(j):
            tid_i, res_i = large[i]
            si = shingle_cache.setdefault(tid_i, shingles(res_i["text"]))
            if jaccard(si, sj) >= REPEAT_OVERLAP:
                use_i = tool_uses.get(tid_i, {})
                inp_j = use_j["input"]
                e = {
                    "tool": use_j["tool"],
                    "tokens": res_j["tokens"],
                    "index": use_j["index"],
                    "line": use_j["line"],
                    "target": inp_j.get("file_path", "") or inp_j.get("command", "") or inp_j.get("pattern", ""),
                    "pattern": "repeated",
                    "note": "content substantially duplicates an earlier large result this session",
                    "first_target": use_i.get("input", {}).get("file_path", "")
                                    or use_i.get("input", {}).get("command", "")
                                    or use_i.get("input", {}).get("pattern", ""),
                    "first_tool": use_i.get("tool", ""),
                }
                candidates.append(e)
                break  # one repeat-flag per result; earliest match is enough

    # Instruction context: the re-injected directive text (skill bodies, catalog,
    # memory, system-reminders) that never flows through tool_use/tool_result. The
    # result-side passes above are blind to it, yet it is the heaviest, most
    # repetitive context in a session. Emits repeated_instruction (deterministic)
    # and instruction_review (analyst classifies obvious/confusing).
    detect_instruction_waste(instructions, candidates)

    # Cap low_value_content review requests to the biggest few — they carry excerpts
    # to the LLM, so an unbounded shortlist would be the very waste this skill hunts.
    lvc = sorted(
        (c for c in candidates if c["pattern"] == "low_value_content"),
        key=lambda c: -c["tokens"],
    )
    if len(lvc) > MAX_QUALITY_REVIEW:
        drop = set(id(c) for c in lvc[MAX_QUALITY_REVIEW:])
        candidates = [c for c in candidates if id(c) not in drop]

    # keep all distinct (pattern, tool-call) hits, ordered by size
    candidates.sort(key=lambda c: (-c["tokens"], c["index"]))

    # headline waste counts each wasteful tool call's tokens ONCE, even when it
    # tripped several patterns (e.g. a reread that was also a full_file_read).
    # REVIEW-REQUEST patterns (`low_value_content`, `instruction_review`) are
    # excluded — the analyst, not the detector, decides obvious vs confusing vs
    # fine, so the deterministic headline must not claim waste the LLM hasn't
    # confirmed. `repeated_instruction` IS deterministic and counts its aggregate
    # re-injection cost. Dedup key is (source, index): tool calls dedup on their
    # call index; instruction candidates dedup on the fingerprint group's first
    # index, namespaced so the two index spaces can't collide.
    REVIEW_ONLY = {"low_value_content", "instruction_review"}
    dedup = {}
    for c in candidates:
        if c["pattern"] in REVIEW_ONLY:
            continue
        key = ("instr", c["target"]) if c["tool"] == "instruction" else ("call", c["index"])
        dedup[key] = max(dedup.get(key, 0), c["tokens"])
    wasted_tokens = sum(dedup.values())

    # Cap the per-session candidate list the analyst must Read whole (see
    # MAX_CANDIDATES). `wasted_tokens` above is computed from the FULL list, so
    # the session's true headline total survives the trim; `candidate_count`
    # reports the pre-trim total and `candidates_truncated` flags any drop.
    full_count = len(candidates)
    kept = candidates[:MAX_CANDIDATES]

    # Spend the session excerpt budget largest-result-first (kept is size-ordered).
    # Past the budget a candidate keeps every field the analyst scores on — tokens,
    # pattern, target, note — and loses only the snippet, so the trim costs recall
    # on content-quality judgements for small results, never a missed big hit.
    excerpt_budget = MAX_EXCERPT_BYTES_PER_SESSION
    excerpts_stripped = 0
    for c in kept:
        ex = c.get("excerpt")
        if ex is None:
            continue
        if len(ex) <= excerpt_budget:
            excerpt_budget -= len(ex)
        else:
            del c["excerpt"]
            c["excerpt_omitted"] = True
            excerpts_stripped += 1

    return {
        "session_id": filepath.stem,
        "project": project,
        "source_file": str(filepath),
        "chars_per_token": chars_per_token,
        "total_tool_result_tokens": total_tool_tokens,
        "candidate_wasted_tokens": wasted_tokens,
        "candidate_count": full_count,
        "candidates_truncated": full_count - len(kept),
        "excerpts_stripped": excerpts_stripped,
        "candidates": kept,
    }


def main():
    ap = argparse.ArgumentParser(description="Detect token-waste candidates in a session JSONL")
    ap.add_argument("input", help="session JSONL path")
    ap.add_argument("--project", default="", help="project name for labelling")
    ap.add_argument("--chars-per-token", type=float, default=4.0,
                    help="rough chars-per-token for estimation (default 4)")
    ap.add_argument("-o", "--output", help="output JSON path (default stdout)")
    args = ap.parse_args()

    p = Path(args.input)
    if not p.exists():
        print(f"Error: not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    project = args.project or p.parent.name
    out = detect(p, project, args.chars_per_token)
    blob = json.dumps(out, indent=2)
    if args.output:
        Path(args.output).write_text(blob, encoding="utf-8")
        print(f"{out['candidate_count']} candidates, ~{out['candidate_wasted_tokens']} wasted tokens → {args.output}",
              file=sys.stderr)
    else:
        print(blob)


if __name__ == "__main__":
    main()
