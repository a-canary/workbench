"""Self-check that token-waste normalizes pi tool records.

Run: python3 skills/token-waste/lib/test_pi_canonicalize.py

Without canonicalization, pi sessions show zero tool traffic and the day reads
falsely "clean" — these asserts fail if that regresses.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import detect_waste  # noqa: E402


def test_pi_toolcall_becomes_tool_use():
    inner = {"role": "assistant", "content": [
        {"type": "toolCall", "id": "t1", "name": "read", "arguments": {"file_path": "/a"}},
    ]}
    out = detect_waste.canonicalize_message(inner)
    tu = [b for b in out["content"] if b["type"] == "tool_use"]
    assert len(tu) == 1 and tu[0]["name"] == "Read" and tu[0]["input"] == {"file_path": "/a"}


def test_pi_toolresult_becomes_user_tool_result():
    out = detect_waste.canonicalize_message(
        {"role": "toolResult", "toolCallId": "t1", "isError": False, "content": "x"}
    )
    assert out["role"] == "user"
    assert out["content"][0]["type"] == "tool_result"
    assert out["content"][0]["tool_use_id"] == "t1"


def test_canonical_claude_untouched():
    inner = {"role": "user", "content": "plain"}
    assert detect_waste.canonicalize_message(inner) == inner


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")
