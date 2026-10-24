#!/usr/bin/env python3
"""Self-check for extract-agent-gaps.py's transcript parsing — the one non-trivial
branch (string vs list content, noise filtering, tool_result exclusion).
Run: python3 bin/test_extract_agent_gaps.py"""
import importlib.util
import json
import tempfile
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "eag", Path(__file__).with_name("extract-agent-gaps.py"))
eag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eag)


def _session(records) -> Path:
    fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    for r in records:
        fh.write(json.dumps(r) + "\n")
    fh.close()
    return Path(fh.name)


def test_transcript_text():
    p = _session([
        {"type": "user", "message": {"content": "fix the bug"}},                    # string prose
        {"type": "user", "message": {"content": [                                   # list prose
            {"type": "text", "text": "no, use the compose file"}]}},
        {"type": "user", "message": {"content": [                                   # tool_result = noise
            {"type": "tool_result", "content": "stdout dump"}]}},
        {"type": "user", "message": {"content": "[Request interrupted by user]"}},   # marker = noise
        {"type": "user", "message": {"content": "<system-reminder>x</system-reminder>"}},  # noise
        {"type": "assistant", "message": {"content": [                              # agent text
            {"type": "text", "text": "done"},
            {"type": "tool_use", "name": "Bash", "input": {}}]}},
    ])
    txt, n = eag.transcript_text(p)
    p.unlink()
    users = [l for l in txt.splitlines() if l.startswith("USER:")]
    agents = [l for l in txt.splitlines() if l.startswith("AGENT:")]
    assert users == ["USER: fix the bug", "USER: no, use the compose file"], users
    assert agents == ["AGENT: done"], agents           # tool_use block excluded
    assert n == 3, n                                    # 2 user + 1 agent, noise dropped
    assert "tool_result" not in txt and "stdout dump" not in txt
    assert "interrupted" not in txt and "system-reminder" not in txt


def test_clean_protects_delimiter():
    assert "|" not in eag.clean("a | b\nc")             # pipe -> / so the log stays parseable


if __name__ == "__main__":
    test_transcript_text()
    test_clean_protects_delimiter()
    print("ok")
