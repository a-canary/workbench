"""PreToolUse host-agent gate (director-oot opt 3) — see pre-host-agent.sh.

Quote-aware: shlex tokenizes the Bash command, so text inside quotes ("git commit -m 'claude -p'")
is data, while wrappers (timeout/sudo/xargs/...), shell -c strings, eval and $(...)/`...` are
followed. Unparseable input falls back to a raw regex and fails closed.
"""
import json
import re
import shlex
import sys

AGENTS = {"claude", "pi"}
WRAPPERS = {"nohup", "env", "time", "timeout", "nice", "ionice", "sudo", "doas", "exec", "command",
            "builtin", "xargs", "stdbuf", "setsid", "chrt", "taskset", "unbuffer", "flock", "watch"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
CONTROL = {";", ";;", "|", "||", "&", "&&", "|&", "(", ")", "\n"}
DANGER = ("--dangerously", "--mcp-config", "--permission-mode", "--settings", "--plugin-dir", "--add-dir", "--tools")
SUBST = re.compile(r"\$\(([^()]*)\)|`([^`]*)`")
RAW = re.compile(r"(^|[\s;|&(`$])(\S*/)?(claude|pi)(\s[^\n]*)?\s(-[A-Za-z]*p[A-Za-z]*|--print)(\s|$)")


def base(tok):
    return tok.rsplit("/", 1)[-1]


def is_print(tok):
    return tok == "--print" or tok.startswith("--print=") or re.fullmatch(r"-[A-Za-z]*p[A-Za-z]*", tok) is not None


def toolless(args):
    """claude args carry exactly one --allowedTools, it is empty, and nothing re-grants tools."""
    vals = []
    for i, t in enumerate(args):
        if t in ("--allowedTools", "--allowed-tools"):
            vals.append(args[i + 1] if i + 1 < len(args) else None)
        elif t.startswith(("--allowedTools=", "--allowed-tools=")):
            vals.append(t.split("=", 1)[1])
        elif t.startswith(DANGER):
            return False
    return vals == [""]


KEYWORDS = {"{", "}", "!", "if", "then", "elif", "else", "while", "until", "do", "done", "fi"}


def blocked_cmd(words):
    while words and words[0] in KEYWORDS:  # { claude -p; } / if ...; then claude -p
        words = words[1:]
    if not words:
        return False
    w0 = base(words[0])
    if w0 in SHELLS:  # bash -c "..." / sh -lc '...'
        for i, t in enumerate(words[1:-1], 1):
            if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", t):
                return blocked(words[i + 1])
        return False
    if w0 == "eval":
        return blocked(" ".join(words[1:]))
    if w0 in WRAPPERS or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        hits = [i for i, t in enumerate(words) if base(t) in AGENTS]
        if not hits:
            return False
        words = words[hits[0]:]
        w0 = base(words[0])
    if w0 not in AGENTS:
        return False
    args = words[1:]
    if not any(is_print(t) for t in args):
        return False
    return not (w0 == "claude" and toolless(args))


def blocked(cmd, depth=0):
    if depth > 4:
        return True
    for m in SUBST.finditer(cmd):
        if blocked(m.group(1) if m.group(1) is not None else m.group(2), depth + 1):
            return True
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars="();<>|&\n")
        lex.whitespace = " \t\r"
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:  # unbalanced quotes: fail closed on anything that looks like an agent run
        return RAW.search(cmd) is not None and "--allowedTools" not in cmd
    words = []
    for t in toks + ["\n"]:
        if t in CONTROL:
            if blocked_cmd(words):
                return True
            words = []
        elif not re.fullmatch(r"[<>&]+|\d*[<>]+&?\d*", t):
            words.append(t)
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if cmd and blocked(cmd):
        print('HOST_AGENT_BLOCKED: run agents via worker-sandbox (director-oot); '
              'tool-less claude -p --allowedTools "" is allowed', file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
