// Mechanical measurement of pi-vcc buildOwnCut over the pi-compaction-rank corpus.
// TSV out, no prose: case, cut, tail_tok, kept, summarize_tok, flags.
// Bug #4 (findings/upstream-reports.md in pi-compaction-rank): Strategy A walks back to
// the last user entry with NO token ceiling, so the kept tail can exceed the window.
const FORK = process.env.FORK!, PICR = process.env.PICR!;
const BUDGET = Number(process.env.TAIL_TOKEN_BUDGET ?? 8000);
const tok = (v: unknown) => Math.ceil(JSON.stringify(v ?? "").length / 4);
let CASES: any[], buildOwnCut: any;
try {
  ({ CASES } = await import(`${PICR}/stress/corpus.ts`));
  ({ buildOwnCut } = await import(`${FORK}/src/hooks/before-compact.ts`));
} catch (e: any) {
  console.log(`IMPORT_ERROR\t-\t0\t0\t0\t${String(e?.message ?? e).slice(0, 160)}`);
  process.exit(1);
}
console.log("case\tcut\ttail_tok\tkept\tsummarize_tok\tflags");
for (const c of CASES) {
  const entries = c.messages.map((m: any, i: number) => ({ id: `e${i}`, type: "message", message: m }));
  const t0 = performance.now();
  let cut: any;
  try { cut = buildOwnCut(entries); } catch (e: any) {
    console.log(`${c.name}\tcrash\t0\t0\t0\tCRASH:${String(e?.message ?? e).slice(0, 120)}`); continue;
  }
  const ms = Math.round(performance.now() - t0);
  if (!cut?.ok) { console.log(`${c.name}\tdefer:${cut?.reason ?? "?"}\t0\t0\t0\t${ms}ms`); continue; }
  const ki = entries.findIndex((e) => e.id === cut.firstKeptEntryId);
  const tail = ki < 0 ? [] : entries.slice(ki);            // synth anchor (compactAll) keeps nothing
  const tailTok = tail.reduce((s, e) => s + tok(e.message), 0);
  const sumTok = (cut.messages ?? []).reduce((s: number, m: any) => s + tok(m), 0);
  const flags = [`${ms}ms`];
  if (ki < 0) flags.push("SYNTH_ANCHOR");
  if (cut.compactAll) flags.push("compactAll");
  if (tailTok > BUDGET) flags.push("TAIL_OVER_BUDGET");
  console.log(`${c.name}\tcut\t${tailTok}\t${tail.length}\t${sumTok}\t${flags.join(",")}`);
}
