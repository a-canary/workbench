export function keywords(title: string): string[] {
  const stopwords = new Set([
    "with", "from", "into", "that", "this", "then", "than", "when", "what",
    "have", "been", "were", "will", "your", "over", "under", "after",
    "before", "about", "main",
  ]);

  let s = title.toLowerCase();
  s = s.replace(/\[[^\]]*\]/g, " ");

  const matches = s.match(/[a-z][a-z0-9-]{3,}/g);
  if (!matches) return [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of matches) {
    if (stopwords.has(m)) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    result.push(m);
    if (result.length === 3) break;
  }
  return result;
}

export function parseMemories(s: string): { key: string; text: string }[] {
  const lines = s.split("\n");
  const entries: { key: string; text: string }[] = [];
  let latest: { key: string; text: string } | null = null;

  for (const line of lines) {
    // 2-space key line: exactly 2 spaces, then one non-space token, then optional trailing whitespace
    const keyMatch = line.match(/^  (\S+)[ \t]*$/);
    if (keyMatch) {
      latest = { key: keyMatch[1], text: "" };
      entries.push(latest);
      continue;
    }

    // 4-space text line
    const textMatch = line.match(/^    (.+)/);
    if (textMatch && latest && latest.text === "") {
      latest.text = textMatch[1].slice(0, 200);
    }
  }

  return entries;
}

export function parseKe(s: string): { score: number; title: string; path: string }[] {
  const lines = s.split("\n");
  const entries: { score: number; title: string; path: string }[] = [];
  let latest: { score: number; title: string; path: string } | null = null;

  for (const line of lines) {
    // Entry line: "- [<num>%] <title>"
    const entryMatch = line.match(/^- \[([0-9.]+)%\] (.*)$/);
    if (entryMatch) {
      latest = {
        score: parseFloat(entryMatch[1]),
        title: entryMatch[2].trim(),
        path: "",
      };
      entries.push(latest);
      continue;
    }

    // Path line: leading whitespace + "→ <path>"
    const pathMatch = line.match(/^\s+→ (.+)$/);
    if (pathMatch && latest && latest.path === "") {
      latest.path = pathMatch[1].trim();
    }
  }

  return entries;
}

export function parseEnd(a: string[]) {
  if (a.length < 3) return { error: "usage" };

  const id = a[0];
  const outcome = a[1];
  const finding = a[2];

  if (outcome !== "done" && outcome !== "checkpoint" && outcome !== "blocked") {
    return { error: "outcome: done|checkpoint|blocked" };
  }

  const metrics: Record<string, number> = {};
  let mission = "";

  for (let i = 3; i < a.length; i++) {
    const arg = a[i];
    const eqIdx = arg.indexOf("=");
    if (eqIdx === -1 || eqIdx === 0) continue;

    const k = arg.slice(0, eqIdx);
    const v = arg.slice(eqIdx + 1);

    if (k === "mission") {
      mission = v;
      continue;
    }

    if (v.trim() === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) {
      metrics[k] = n;
    }
  }

  return { id, outcome, finding, metrics, mission };
}
