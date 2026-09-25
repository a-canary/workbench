You are writing the verdict for a pi-vcc fork patch. Attached: mechanical.txt (authoritative decision), baseline.txt (pristine fork), measure.txt (patched fork), patch.txt (what was applied). Columns are TSV: case, cut, tail_tok, kept, summarize_tok, flags.
Write at most 12 lines of Markdown:
1. First line exactly: `VERDICT: <decision from mechanical.txt>`
2. A 3-column table: case, baseline tail_tok, patched tail_tok — only rows that changed or carry flags.
3. Two sentences: does the kept tail now respect the budget, and did any case regress from `cut` to `defer:`?
4. One sentence naming the next patch to write, or `none` if PASS.
Do not invent numbers; use only values present in the attachments. An `IMPORT_ERROR` row is an infra fault, never a result.
