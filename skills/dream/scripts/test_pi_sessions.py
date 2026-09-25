"""Self-check for pi-agent session ingestion in the dream pipeline.

Run: python3 skills/dream/scripts/test_pi_sessions.py

pi writes a different JSONL schema than interactive Claude Code (every turn is
`type:"message"` with a nested `message.role`, and tools are `toolCall`/
`toolResult` instead of `tool_use`/`tool_result`). These asserts fail if either
the stub-skip filter or the schema normalization stops recognizing pi records —
the two ways pi sessions silently vanish from the nightly run.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import pipeline  # noqa: E402
import extract  # noqa: E402


def _write(lines: list[dict]) -> Path:
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    for line in lines:
        f.write(json.dumps(line) + "\n")
    f.close()
    return Path(f.name)


def test_has_minable_content_recognizes_pi():
    # pi shape: nested message.role
    pi = _write([
        {"type": "session", "id": "x"},
        {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
    ])
    assert pipeline.has_minable_content(pi), "pi user message must count as minable"

    # Claude shape still works (regression guard)
    claude = _write([{"type": "user", "message": {"role": "user", "content": "hi"}}])
    assert pipeline.has_minable_content(claude), "Claude message must still count"

    # genuine stub — no message rows — still skipped
    stub = _write([{"type": "ai-title", "title": "x"}, {"type": "session"}])
    assert not pipeline.has_minable_content(stub), "content-less stub must be skipped"


def test_canonicalize_pi_toolcall():
    inner = {"role": "assistant", "content": [
        {"type": "thinking", "text": "..."},
        {"type": "toolCall", "id": "t1", "name": "bash", "arguments": {"command": "ls"}},
    ]}
    out = extract.canonicalize_message(inner)
    blocks = out["content"]
    tu = [b for b in blocks if b["type"] == "tool_use"]
    assert len(tu) == 1, "toolCall must become one tool_use block"
    assert tu[0]["name"] == "Bash", "pi lowercase name must map to canonical Bash"
    assert tu[0]["input"] == {"command": "ls"}, "arguments must map to input"
    assert tu[0]["id"] == "t1"


def test_canonicalize_pi_toolresult():
    out = extract.canonicalize_message(
        {"role": "toolResult", "toolCallId": "t1", "isError": True, "content": "boom"}
    )
    assert out["role"] == "user", "toolResult must become a user message"
    blk = out["content"][0]
    assert blk["type"] == "tool_result"
    assert blk["tool_use_id"] == "t1"
    assert blk["is_error"] is True
    assert blk["content"] == "boom"


def test_claude_message_passes_through_unchanged():
    inner = {"role": "assistant", "content": [{"type": "tool_use", "id": "a", "name": "Read", "input": {}}]}
    assert extract.canonicalize_message(inner) is inner or \
        extract.canonicalize_message(inner) == inner, "canonical Claude message must be untouched"


def test_extract_message_end_to_end_on_pi():
    # a pi assistant toolCall record, as it arrives from parse_jsonl
    raw = {"type": "message", "message": {"role": "assistant", "content": [
        {"type": "toolCall", "id": "t1", "name": "grep", "arguments": {"pattern": "foo"}},
    ]}}
    result = extract.extract_message(raw, line_num=1, index=0)
    assert result is not None, "pi assistant message must not be dropped as noise"
    # a tool-call turn classifies as tool_use (main's design), with the pi
    # lowercase name canonicalized — this is the whole point of ingestion.
    assert result["role"] == "tool_use", f"expected tool_use, got {result['role']}"
    assert result.get("tool") == "Grep", "pi grep must canonicalize to Grep"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")
