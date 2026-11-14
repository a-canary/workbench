"""PreToolUse hard-lines gate (operator ruling 2026-11-14, repos-peos).

Blocks: --admin (gh), force push (git), repo visibility/access/deletion (gh),
live order paths (rebalance-calc/m1-execute --execute, trade-rebalance-active,
order tool with order verbs). Quote-aware shlex; follows wrappers, shell -c,
eval, $(...)/`...`. Input the tokenizer rejects (unbalanced quotes, which bash rejects
too) is checked by raw regex for the main spellings only.

Limits: this is a tripwire for the honest mistake, not a security boundary. It reads the
command text, so it cannot see a script's contents (bash x.sh, source), an interpreter's
string (python -c, node -e), a request body in a file (gh api --input), arguments piped
into xargs, stored git or gh aliases, a word built by shell expansion (g=git; $g push ...),
a command run on another host (ssh host "..."), or a merge through the API (pulls/N/merge). Branch protection and the prose rule cover those.
"""
import json
import re
import shlex
import sys

WRAPPERS = {"nohup", "env", "time", "timeout", "nice", "ionice", "sudo", "doas", "exec", "command",
            "builtin", "xargs", "su", "script", "strace", "ltrace", "chronic", "ts", "stdbuf", "setsid", "chrt", "taskset", "unbuffer", "flock", "watch"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish"}
CONTROL = {";", ";;", "|", "||", "&", "&&", "|&", "(", ")", "\n"}
KEYWORDS = {"{", "}", "!", "if", "then", "elif", "else", "while", "until", "do", "done", "fi"}

ORDER_VERBS = {"buy", "buy-notional", "sell", "stop-sell", "close", "cancel", "cancel-all"}
VIEWERS = {"cat", "grep", "rg", "sed", "head", "tail", "less", "wc", "ls", "echo", "printf",
           "git", "bd", "ke", "diff"}


SCRIPT_EXT = re.compile(r"\.(ts|js|mjs|cjs)$")


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
        if w.startswith("-calias.") or w.startswith("--config-env=alias.") or (
                w in ("-c", "--config-env") and i + 1 < len(words) and words[i + 1].startswith("alias.")):
            return "git alias defined inline (cannot be checked)"
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
        # git accepts any unambiguous prefix of a long option: --forc, --force-with-l, --mirr
        if re.fullmatch(r"--(f|fo|for|forc|force.*|m|mi|mir|mirr|mirro|mirror)(=.*)?", w):
            return "force push"
        if re.fullmatch(r"-[A-Za-z0-9]*f[A-Za-z0-9]*", w):
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
    if w0 == "gh" and any(w == "--admin" or w.startswith("--admin=") for w in words):
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
        # fields and methods also come attached to the short flag: -fprivate=false, -XPUT
        if any(re.search(r"(^|^-[fF]|^--(raw-)?field=)(private|visibility)=", w) or "updateRepository" in w
               for w in words):
            return "repo visibility or access"
        method = ""
        for k, w in enumerate(words):
            if w in ("-X", "--method") and k + 1 < len(words):
                method = words[k + 1]
            elif w.startswith("--method="):
                method = w.split("=", 1)[1]
            elif re.fullmatch(r"-X.+", w):
                method = w[2:]
        if not method and any(re.match(r"-[fF]|--(raw-)?field|--input", w) for w in words):
            method = "POST"  # gh api switches to POST as soon as a field or body is given
        method = method.upper()
        if method in ("PUT", "POST", "PATCH", "DELETE") and any("/collaborators/" in w for w in words):
            return "repo visibility or access"
        if method == "DELETE" and any(
                re.fullmatch(r"(https://[^/]+)?/?repos/[^/?]+/[^/?]+/?(\?.*)?", w) for w in words):
            return "repo visibility or access"

    # b. git force push
    if w0 == "git":
        res = git_push_force(words)
        if res:
            return res

    # d. live order path — only for non-viewer commands
    if w0 not in VIEWERS:
        basenames = [SCRIPT_EXT.sub("", base(w)) for w in words]

        execute = any(w == "--execute" or w.startswith("--execute=") for w in words)
        if ("rebalance-calc" in basenames or "m1-execute" in basenames) and execute:
            return "live order path"
        if "trade-rebalance-active" in basenames:
            return "live order path"

        # order tool: a script file named order (order.ts, dist/tools/order.js), or any tools/order path
        order_idx = -1
        for k, w in enumerate(words):
            if basenames[k] == "order" and ("tools/order" in w or SCRIPT_EXT.search(w)):
                order_idx = k
                break
        # the package script: npm run order, bun run order, pnpm order, yarn order
        if order_idx < 0 and w0 in ("npm", "pnpm", "yarn", "bun") and "order" in words:
            order_idx = words.index("order")
        if order_idx >= 0:
            for j in range(order_idx + 1, len(words)):
                if words[j] in ORDER_VERBS:
                    return "live order path"

    return None


def blocked_cmd(words, depth=0):
    """Check a simple command (may have keywords/wrappers). Return line name or None."""
    if words and words[0] == "function" and "{" in words:  # function f { cmd; }
        words = words[words.index("{"):]
    while words and words[0] in KEYWORDS:
        words = words[1:]
    if not words:
        return None
    w0 = base(words[0])
    if w0 in SHELLS:
        for i, t in enumerate(words[1:-1], 1):
            if re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", t):
                return blocked(words[i + 1], depth + 1)
        return None
    if w0 == "eval":
        return blocked(" ".join(words[1:]), depth + 1)
    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        return blocked_cmd(words[1:], depth)
    if w0 in WRAPPERS:
        for i in range(1, len(words)):
            # the command follows the wrapper's own options, or is one quoted string (watch "git ...").
            # A nested wrapper is skipped, not recursed into: this loop reaches its suffixes anyway,
            # and recursing on every suffix is exponential in the length of a wrapper chain.
            if base(words[i]) in WRAPPERS:
                continue
            res = blocked_cmd(words[i:], depth) or (" " in words[i] and blocked(words[i], depth + 1))
            if res:
                return res
        return None
    if w0 == "find":
        for i, t in enumerate(words):
            # a nested find is skipped for the same reason as a nested wrapper: this loop reaches its -exec
            if t in ("-exec", "-execdir", "-ok", "-okdir") and base("".join(words[i + 1:i + 2])) != "find":
                res = blocked_cmd(words[i + 1:], depth)
                if res:
                    return res
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
        # The tokenizer gave up (an apostrophe in a # comment or a heredoc body does that, and bash runs
        # those). Fail closed: an unreadable command that names any hard-line tool is refused.
        if re.search(r"\bgit\b[^\n]*\bpush\b|\bgh\s+(repo|api)\b|--admin\b|rebalance-calc|m1-execute|"
                     r"trade-rebalance-active|\border(\.(ts|js|mjs|cjs))?\s", cmd):
            return "command the checker cannot parse (fix the quoting) that names a hard-line tool"
        return None
    words = []
    for t in toks + ["\n"]:
        if t in CONTROL:
            res = blocked_cmd(words, depth)
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
    if not isinstance(data, dict) or data.get("tool_name") != "Bash":
        return 0
    ti = data.get("tool_input")
    cmd = ti.get("command") if isinstance(ti, dict) else None
    if cmd != "":
        try:
            hit = blocked(cmd) if isinstance(cmd, str) else "command is not text"
        except Exception as e:  # a checker fault must not read as "allowed"
            hit = f"hard-line check failed ({type(e).__name__})"
        if hit:
            print(f"HARD_LINE_BLOCKED: {hit} is a hard line (operator ruling 2026-11-14); "
                  "a human runs it, never an agent", file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())