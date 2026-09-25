#!/usr/bin/env python3
"""
dream-page: stream a window of cleaned conversation messages from raw JSONL.

Replaces the extract -> compress -> index file pipeline. Instead of
materializing YAML to disk, this yields a bounded window of noise-stripped
messages to stdout so the collector agent can read a session incrementally.

Windowing is by *cleaned-message count* (not raw JSONL lines): a single
tool_result can be one 50KB line, so raw-line windows are wildly uneven.
Each emitted message keeps its original JSONL `line` number so journal
entries can cite an exact source location.

Usage:
    page.py SESSION.jsonl [--offset N] [--window M] [--max-bytes B]

    --offset N      message index to start from (0-based, default 0)
    --window M      max number of cleaned messages to emit (default 80)
    --max-bytes B   soft cap on emitted message-body bytes (default 20000);
                    the window stops early once exceeded so a few fat
                    tool_results can't blow the consumer's context budget.

Output is YAML: a small header, the message window, then a footer with
either `next_offset: N` (more remain) or `next_offset: EOF` (done).
"""

import argparse
import sys
from pathlib import Path

# Reuse the battle-tested parsing/noise-stripping from extract.py.
sys.path.insert(0, str(Path(__file__).parent))
import extract  # noqa: E402
from extract import parse_jsonl, yaml_value  # noqa: E402

extract.TAGGING_ENABLED = False  # windowing replaces COMPRESS tagging

DEFAULT_WINDOW = 80
# Each page is dumped straight into the collector's context, so this byte cap IS
# the per-page token cost (~1 token / 4 bytes). It must also stay UNDER the
# harness's inline-display threshold (~16k bytes): a page above it is spilled to a
# `tool-results/<id>.txt` stub with a "read the full result" pointer, and the
# haiku collector obeys the pointer and `Read`s the file back — the exact re-read
# its own definition forbids (37 such reads / ~262k tokens, tally 20260705; pages
# measured 37-41k because the old 20k cap counted only message-body bytes, not
# YAML structure, so real pages ran ~2x the cap). 12000 keeps a fully-rendered
# page ~9-12k bytes — inline, never spilled, still ~3k tokens. Override with
# --max-bytes only when a session genuinely needs wider context.
DEFAULT_MAX_BYTES = 12000
TRUNCATE_TAIL = 1200  # keep this many chars when truncating one oversized field


def _block(key: str, text: str, indent: str = "    ", max_chars: int = 0) -> list[str]:
    """Render a YAML block scalar, truncating one oversized field if max_chars > 0."""
    if max_chars and len(text) > max_chars:
        dropped = len(text) - max_chars
        text = text[:max_chars] + f"\n[truncated {dropped} bytes]"
    body_indent = indent + "  "
    return [f"{indent}{key}: |"] + [f"{body_indent}{ln}" for ln in text.split("\n")]


def emit_message(msg: dict, max_field_chars: int = 0) -> list[str]:
    """Render one cleaned message as compact YAML lines (no COMPRESS tagging)."""
    out = [f"  - index: {msg['index']}", f"    line: {msg['line']}", f"    role: {msg['role']}"]

    if msg["role"] == "tool_use":
        out.append(f"    tool: {msg.get('tool', 'unknown')}")
        for key in ("command", "description", "file_path", "pattern", "path",
                    "old_string", "new_string", "content", "subagent_type",
                    "prompt", "url", "query", "input"):
            val = msg.get(key)
            if not val:
                continue
            if isinstance(val, dict):
                out.append(f"    {key}:")
                for k, v in val.items():
                    out.append(f"      {k}: {yaml_value(v)}")
            elif isinstance(val, str) and ("\n" in val or len(val) > 80):
                out.extend(_block(key, val, max_chars=max_field_chars))
            else:
                out.append(f"    {key}: {yaml_value(val)}")
        return out

    if msg["role"] == "tool_result":
        if msg.get("is_error"):
            out.append("    is_error: true")
        content = msg.get("content", "")
        if "\n" in content or len(content) > 80:
            out.extend(_block("content", content, max_chars=max_field_chars))
        elif content:
            out.append(f"    content: {yaml_value(content)}")
        return out

    # user / assistant / other
    if msg.get("is_interrupt"):
        out.append("    is_interrupt: true")
    thinking = msg.get("thinking")
    if thinking:
        out.extend(_block("thinking", thinking, max_chars=max_field_chars))
    content = msg.get("content")
    if content:
        if "\n" in content or len(content) > 80:
            out.extend(_block("content", content, max_chars=max_field_chars))
        else:
            out.append(f"    content: {yaml_value(content)}")
    return out


def main():
    parser = argparse.ArgumentParser(description="Stream a window of cleaned conversation messages")
    parser.add_argument("input", help="Input JSONL session file")
    parser.add_argument("--offset", type=int, default=0, help="Message index to start from (default 0)")
    parser.add_argument("--window", type=int, default=DEFAULT_WINDOW, help=f"Messages per window (default {DEFAULT_WINDOW})")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help=f"Soft cap on emitted body bytes (default {DEFAULT_MAX_BYTES})")
    args = parser.parse_args()

    path = Path(args.input)
    if not path.exists():
        print(f"Error: file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    messages, metadata = parse_jsonl(path)
    total = len(messages)
    start = min(max(0, args.offset), total)
    window_end = min(total, start + args.window)

    # Truncate any single field so no one tool_result can dominate — and, more
    # importantly, so a page never swells past the harness's inline-display
    # threshold. Above that threshold the harness spills the whole page to a
    # `tool-results/<id>.txt` stub with a "read the full result" pointer, and the
    # haiku collector obeys that pointer and `Read`s the file — the exact re-read
    # its own definition forbids (37 such reads / ~262k tokens, tally 20260705).
    # Capping a single field at a quarter of the page budget keeps any one field
    # from filling the page, so mid-size fields can't sum a page past --max-bytes
    # into spill territory. Override with a larger --max-bytes for wider fields.
    max_field_chars = max(TRUNCATE_TAIL, args.max_bytes // 4) if args.max_bytes else 0

    body: list[str] = []
    emitted_bytes = 0
    end = start
    for msg in messages[start:window_end]:
        rendered = emit_message(msg, max_field_chars=max_field_chars)
        block = "\n".join(rendered) + "\n"
        # Always emit at least one message so the window can't stall.
        if args.max_bytes and end > start and emitted_bytes + len(block) > args.max_bytes:
            break
        body.extend(rendered)
        body.append("")
        emitted_bytes += len(block) + 1
        end += 1

    lines = [
        f"session_id: {yaml_value(metadata['session_id'])}",
        f"project: {yaml_value(metadata['project'])}",
        f"message_count: {total}",
        f"window: [{start}, {end})",
        "",
        "messages:",
    ]
    lines.extend(body)
    lines.append(f"next_offset: {end if end < total else 'EOF'}")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
