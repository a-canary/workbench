"""PreToolUse hard-lines gate (operator ruling 2026-11-14, repos-peos).

Blocks: --admin (gh), force push (git), repo visibility/access/deletion (gh),
live order paths (rebalance-calc/m1-execute --execute, trade-rebalance-active,
order tool with order verbs). Quote-aware shlex; follows wrappers, shell -c,
eval, $(...)/`...`. Unparseable input falls back to raw regex and fails closed.
"""
import json
import re
import shlex
import sys

WRAPPERS = {"nohup", "env", "time", "timeout", "nice", "ionice", "sudo", "doas", "exec", "command",
            "builtin", "xargs", "stdbuf", "setsid", "chrt", "taskset", "unbuffer", "flock", "watch"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
CONTROL = {";", ";;", "|", "||", "&", "&&", "|&", "(", ")", "\n"}
KEYWORDS = {"{", "}", "!", "if", "then", "elif", "else", "while", "until", "do", "done", "fi"}

ORDER_VERBS = {"buy", "buy-notional", "sell", "stop-sell", "close", "cancel", "cancel-all"}
VIEWERS = {"cat", "grep", "rg", "sed", "head", "tail", "less", "wc", "ls", "echo", "printf",
           "git", "bd", "ke", "diff"}


def base(tok):
    return tok.rsplit("/", 1)[-1]


def substs(cmd):
    """Bodies of $(...) / `...` outside single quotes."""
    i, n, dq = 0, len(cmd), False
    while i < n:
        c = cmd[i]
        if c == "\\":
            i += 2
            continue
        if c == "'" and not dq:
            j = cmd.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            dq = not dq
        elif c == "`":
            j = cmd.find("`", i + 1)
            yield cmd[i + 1:] if j < 0 else cmd[i + 1:j]
            i = n if j < 0 else j + 1
            continue
        elif cmd.startswith("$(", i):
            depth, j = 1, i + 2
            while j < n and depth:
                depth += {"(": 1, ")": -1}.get(cmd[j], 0)
                j += 1
            yield cmd[i + 2:j - 1] if depth == 0 else cmd[i + 2:]
            i = j
            continue
        i += 1


def git_push_force(words):
    """words[0] is git; return 'force push' if this is a force push, else None."""
    i = 1
    while i < len(words):
        w = words[i]
        if w in ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"):
            i += 2
        elif w.startswith("-"):
            i += 1
        else:
            break
    if i >= len(words) or words[i] != "push":
        return None
    for j in range(i + 1, len(words)):
        w = words[j]
        if w == "-f" or w == "--force" or w == "--mirror":
            return "force push"
        if w.startswith("--force-with-lease") or w.startswith("--force-if-includes"):
            return "force push"
        if re.fullmatch(r"-[A-Za-z]*f[A-Za-z]*", w):
            return "force push"
        if w.startswith("+"):
            return "force push"
    return None


def check_hard_line(words):
    """Check a simple command against all hard lines. Return line name or None."""
    if not words:
        return None
    w0 = base(words[0])

    # a. --admin with gh
    if w0 == "gh" and "--admin" in words:
        return "--admin"

    # c. repo visibility, access, deletion
    if w0 == "gh" and len(words) > 1 and words[1] == "repo":
        if "edit" in words[2:] and any(w.startswith("--visibility") for w in words):
            return "repo visibility or access"
        if len(words) > 2 and words[2] == "create" and "--public" in words:
            return "repo visibility or access"
        if len(words) > 2 and words[2] == "delete":
            return "repo visibility or access"

    # c. gh api visibility/private/collaborators
    if w0 == "gh" and len(words) > 1 and words[1] == "api":
        # ponytail: a body sent with --input FILE is not read; branch protection and the prose rule cover that path
        if any(w.startswith(("private=", "visibility=")) or "updateRepository" in w for w in words):
            return "repo visibility or access"
        if any("/collaborators/" in w for w in words):
            method = None
            for k, w in enumerate(words):
                if w == "-X" and k + 1 < len(words):
                    method = words[k + 1]
                elif w == "--method" and k + 1 < len(words):
                    method = words[k + 1]
                elif w.startswith("--method="):
                    method = w.split("=", 1)[1]
            if method and method.upper() in ("PUT", "POST", "PATCH", "DELETE"):
                return "repo visibility or access"

    # b. git force push
    if w0 == "git":
        res = git_push_force(words)
        if res:
            return res

    # d. live order path — only for non-viewer commands
    if w0 not in VIEWERS:
        basenames = []
        for w in words:
            bn = base(w)
            if bn.endswith(".ts"):
                bn = bn[:-3]
            basenames.append(bn)

        if ("rebalance-calc" in basenames or "m1-execute" in basenames) and "--execute" in words:
            return "live order path"
        if "trade-rebalance-active" in basenames:
            return "live order path"

        # order tool: basename (no .ts) is 'order' and word contains 'tools/order'
        order_idx = -1
        for k, w in enumerate(words):
            bn = base(w)
            if bn.endswith(".ts"):
                bn = bn[:-3]
            if bn == "order" and "tools/order" in w:
                order_idx = k
                break
        if order_idx < 0:
            for k in range(len(words) - 1):
                if words[k] == "run" and base(words[k + 1]) == "order":
                    order_idx = k + 1
                    break
        if order_idx >= 0:
            for j in range(order_idx + 1, len(words)):
                if words[j] in ORDER_VERBS:
                    return "live order path"

    return None


def blocked_cmd(words):
    """Check a simple command (may have keywords/wrappers). Return line name or None."""
    while words and words[0] in KEYWORDS:
        words = words[1:]
    if not words:
        return None
    w0 = base(words[0])
    if w0 in SHELLS:
        for i, t in enumerate(words[1:-1], 1):
            if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", t):
                return blocked(words[i + 1])
        return None
    if w0 == "eval":
        return blocked(" ".join(words[1:]))
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        return blocked_cmd(words[1:])
    if w0 in WRAPPERS:
        for i in range(1, len(words)):
            res = blocked_cmd(words[i:])
            if res:
                return res
        return None
    return check_hard_line(words)


def blocked(cmd, depth=0):
    """Check a command string. Return hard line name or None."""
    if depth > 4:  # fail closed, as pre-host-agent does
        return "command nested too deep to check"
    for sub in substs(cmd):
        res = blocked(sub, depth + 1)
        if res:
            return res
    try:
        lex = shlex.shlex(cmd, posix=True, punctuation_chars="();<>|&\n")
        lex.whitespace = " \t\r"
        lex.commenters = ""
        lex.whitespace_split = True
        toks = list(lex)
    except ValueError:
        # fail closed with raw regex
        if re.search(r"git\s[^\n]*push[^\n]*\s(-f|--force|--mirror)", cmd):
            return "force push"
        if re.search(r"(^|\s)gh(\s[^\n]*)?\s--admin", cmd):
            return "--admin"
        if re.search(r"--execute", cmd) and re.search(r"(rebalance-calc|m1-execute)", cmd):
            return "live order path"
        return None
    words = []
    for t in toks + ["\n"]:
        if t in CONTROL:
            res = blocked_cmd(words)
            if res:
                return res
            words = []
        elif not re.fullmatch(r"[<>&]+|\d*[<>]+&?\d*", t):
            words.append(t)
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if cmd:
        hit = blocked(cmd)
        if hit:
            print(f"HARD_LINE_BLOCKED: {hit} is a hard line (operator ruling 2026-11-14); "
                  "a human runs it, never an agent", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())