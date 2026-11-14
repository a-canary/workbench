// Hard lines (operator ruling 2026-11-14, repos-peos): with permission prompts skipped, these
// commands are refused by a PreToolUse hook whatever the session's permission mode:
// live order paths, --admin, force push, repo visibility and access changes.
// Quote-aware like pre-host-agent: text inside quotes (a commit message, a grep pattern) is data.

import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "pre-hard-lines.sh");

function run(command: string, tool = "Bash"): { rc: number; err: string } {
  const r = spawnSync("bash", [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
  });
  return { rc: r.status ?? -1, err: r.stderr };
}
const blocked = (c: string) => expect([c, run(c).rc]).toEqual([c, 2]);
const allowed = (c: string) => expect([c, run(c).rc]).toEqual([c, 0]);

test("names the line it blocked", () => {
  expect(run("gh pr merge 5 --admin").err).toContain("HARD_LINE_BLOCKED");
  expect(run("gh pr merge 5 --admin").err).toContain("--admin");
});

test("blocks gh --admin", () => {
  blocked("gh pr merge 5 --admin --squash");
  blocked("cd /x && gh pr merge 5 -R o/r --admin");
  blocked("/usr/bin/gh pr merge --admin 5");
  blocked('bash -c "gh pr merge 5 --admin"');
  blocked("timeout 60 gh pr merge 5 --admin");
  blocked("echo $(gh pr merge 5 --admin)");
});

test("blocks force push in every spelling", () => {
  blocked("git push -f");
  blocked("git push --force origin main");
  blocked("git push --force-with-lease");
  blocked("git push --force-with-lease=main:abc origin main");
  blocked("git push --force-if-includes origin x");
  blocked("git push -uf origin x");
  blocked("git push origin +main");
  blocked("git push origin +HEAD:main");
  blocked("git push --mirror");
  blocked("git -C /repo push -f");
  blocked("git -c user.name=x -C /repo push --force");
  blocked("FOO=1 git push -f");
  blocked("git commit -m x && git push -f");
  blocked("git --git-dir /repo/.git push -f");
  blocked("git push --mirr");
  blocked("git push --force-with-l origin x");
  blocked("git push --forc");
  blocked("git push -4f origin x");
  blocked("git -c alias.p='push -f' p");
});

test("blocks repo visibility, access and deletion", () => {
  blocked("gh repo edit o/r --visibility public");
  blocked("gh repo edit --visibility=private --accept-visibility-change-consequences");
  blocked("gh repo create o/new --public");
  blocked("gh repo delete o/r --yes");
  blocked("gh api -X PATCH repos/o/r -f private=false");
  blocked("gh api repos/o/r --method PATCH -F visibility=public");
  blocked("gh api -X PUT repos/o/r/collaborators/someone");
  blocked("gh api --method PUT /repos/o/r/collaborators/someone -f permission=push");
  blocked("gh pr merge 5 --admin=true");
  blocked("gh api repos/o/r/collaborators/x -f permission=push"); // a field makes it a POST
  blocked("gh api -X DELETE repos/o/r");
  blocked("gh api --method=DELETE /repos/o/r");
  blocked("gh api -XDELETE repos/o/r");
  blocked("gh api -XPUT repos/o/r/collaborators/x");
  blocked("gh api -XPATCH repos/o/r -fprivate=false");
  blocked("gh api -XPATCH repos/o/r -Fvisibility=public");
  blocked("gh api repos/o/r --method PATCH --field=visibility=public");
});

test("blocks through string wrappers, find -exec and nested shells", () => {
  blocked('watch "git push -f"');
  blocked("find . -name x -exec git push -f \\;");
  blocked("find . -exec gh pr merge 5 --admin \\;");
  blocked(`bash -c "bash -c 'bash -c \\"bash -c gh\\\\ pr\\\\ merge\\\\ --admin\\"'"`);
  blocked("function f { git push -f; }; f");
  blocked("env ".repeat(60) + "git push -f"); // a long wrapper chain is checked in linear time
  allowed("env ".repeat(60) + "git status");
  blocked("find . -exec ".repeat(60) + "git push -f \\;");
  allowed("find . -exec ".repeat(60) + "true \\;");
  blocked("git -calias.p='push -f' p");
  blocked("gh api -X DELETE https://api.github.com/repos/o/r");
  blocked("gh api -X DELETE 'repos/o/r?x=1'");
  const odd = spawnSync("bash", [HOOK], { input: '{"tool_name":"Bash","tool_input":"x"}', encoding: "utf8" });
  expect(odd.status).toBe(2); // a command the hook cannot read is refused, not waved through
  allowed("find . -name '*.ts' -exec grep -n push {} +");
  allowed('watch -n 5 "git status"');
});

test("blocks live order paths", () => {
  blocked("npx tsx tools/rebalance-calc.ts --execute");
  blocked("bun tools/rebalance-calc.ts alpaca --execute");
  blocked("cd ~/repos/trading && bun run tools/rebalance-calc.ts --execute");
  blocked("rebalance-calc --execute");
  blocked("npx tsx tools/m1-execute.ts roth --execute");
  blocked("npx tsx tools/order.ts --alpaca-live buy SPY 1");
  blocked("bun tools/order.ts sell SPY 1");
  blocked("npx tsx /home/x/repos/trading/tools/order.ts cancel-all");
  blocked("npm run order -- buy SPY 1");
  blocked("bun run order close SPY");
  blocked("/home/aaron/bin/trade-rebalance-active");
  blocked("nohup trade-rebalance-active &");
  blocked("cd tools && npx tsx order.ts buy SPY 1");
  blocked("node dist/tools/order.js buy SPY 1");
  blocked("bun tools//order.ts buy SPY 1");
  blocked("pnpm order buy SPY 1");
  blocked("yarn order sell SPY 1");
  blocked("node dist/tools/rebalance-calc.js --execute");
  blocked("npx tsx tools/rebalance-calc.ts --execute=true");
});

test("allows the same words as data, and the safe forms", () => {
  allowed("git commit -m 'never use --admin or git push -f'");
  allowed('grep -rn -- "--admin" skills/');
  allowed('bd create "defend: gh pr merge --admin is a hard line"');
  allowed("echo 'git push --force'");
  allowed("gh pr merge 5 --squash --delete-branch");
  allowed("git push -u origin lane/x");
  allowed("git push origin main");
  allowed("git push origin HEAD:refs/heads/x");
  allowed("git push --follow-tags");
  allowed("git fetch -f origin");
  allowed("gh repo view o/r --json visibility");
  allowed("gh repo create o/new --private");
  allowed("gh api repos/o/r -q .visibility");
  allowed("gh api repos/o/r/collaborators");
  allowed("gh api -X DELETE repos/o/r/git/refs/heads/lane/x");
  allowed("gh api -XPATCH repos/o/r/pulls/5 -f title=x");
  allowed("node dist/tools/order.js list open");
  allowed("npx tsx tools/rebalance-calc.ts");
  allowed("npx tsx tools/rebalance-calc.ts --dry-run");
  allowed("npx tsx tools/m1-execute.ts roth --dry-run");
  allowed("npx tsx tools/order.ts list open");
  allowed("bun test tools/order.test.ts");
  allowed("cat tools/order.ts");
  allowed("grep -n execute tools/rebalance-calc.ts");
  allowed("/home/aaron/bin/trade-rebalance-shadow");
});

test("non-Bash tools and malformed input pass; unbalanced quotes fail closed", () => {
  expect(run("gh pr merge 5 --admin", "Read").rc).toBe(0);
  const r = spawnSync("bash", [HOOK], { input: "not json", encoding: "utf8" });
  expect(r.status).toBe(0);
  blocked("git push -f 'unterminated");
  allowed("echo 'unterminated");
  blocked("echo $(echo $(echo $(echo $(echo $(echo $(true))))))"); // past the depth limit: fail closed
  blocked("gh api graphql -f query='mutation { updateRepository(input: {visibility: PUBLIC}) { clientMutationId } }'");
});
