#!/usr/bin/env python3
"""Test that all agent mode declarations are consistent and parseable."""
import re
import sys
from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
MODE_RE = re.compile(r"^MODE:\s*(director|driver|worker)$", re.MULTILINE)

expected = {
    "director": ["director/SKILL.md", "director/sys_director.md"],
    "driver": ["driver/SKILL.md", "driver/sys_driver.md"],
    "worker": ["task/SKILL.md"],
}

failures = []
for mode, files in expected.items():
    for rel in files:
        p = SKILLS_DIR / rel
        if not p.exists():
            failures.append(f"missing: {rel}")
            continue
        text = p.read_text()
        if not MODE_RE.search(text):
            failures.append(f"no 'MODE: {mode}' declaration in {rel}")

if failures:
    for f in failures:
        print(f"FAIL: {f}", file=sys.stderr)
    sys.exit(1)
print("all mode declarations present and consistent")
