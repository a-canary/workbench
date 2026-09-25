---
name: blockdoc
description: Edit long nested files (HTML, JSON, YAML, XML) as small part files — one block per file, append-only assembly, tag-balance validation gate at build. Use when editing an HTML or other nested doc over ~200 lines, when tag/nesting mismatches keep appearing in a big file, or when asked to "blockdoc", "split into parts", or "assemble from parts".
---

# blockdoc — one block per file

Long nested files break under surgical agent edits: mismatched tags, wrong
nesting depth, off-by-one replacements. The fix is a practice change, not
better editing: **one block per part file, append-only assembly, validate at
build.** The parts directory is the source of truth; the assembled file is a
build artifact you never hand-edit.

## Tool

`scripts/blockdoc.py` (Python stdlib only):

```
python3 scripts/blockdoc.py split <file.html> <parts-dir>   adopt an existing long file
python3 scripts/blockdoc.py build <parts-dir> [outfile]     assemble + tag-balance validate (gate)
python3 scripts/blockdoc.py check <file.html>               validate one file in place
python3 scripts/blockdoc.py selftest                        built-in checks
```

## Workflow

1. **Adopt**: `split file.html file.parts/` → one part per top-level `<body>`
   child (`00-preamble.html`, `01-header.html`, …). Split is round-trip exact:
   if reassembly would not reproduce the original byte-for-byte, it aborts and
   removes the parts.
2. **Edit a part**: rewrite the whole small part file with `write`. Never do
   surgical `edit` on a part over ~50 lines, never touch the assembled file.
3. **Append a block**: add a new numbered part file after the last one —
   appending a section never rewrites other parts (the append-only property).
   Inserting mid-document = renumber; parts are small, `mv` is cheap.
4. **Build gate**: run `build` before declaring done. On failure it prints
   tag + line in the assembled output and writes nothing — find the part whose
   range contains that line, fix it, rebuild until clean.

## Rules

- Parts stay small: target < 100 lines; split a part further if it grows past that.
- Commit the parts directory, not just the assembled file.
- `build` never emits output when validation fails — no broken artifact.
- Source files must end with a trailing newline (split refuses otherwise).

## Non-HTML nested files

Same practice, different checker: one block per part file, concatenate in name
order into the final file, validate with the language's own tool
(`python3 -m json.tool`, `yaml.safe_load`, `xmllint --noout`). The split/build
script is HTML-only; for other formats a two-line `cat` + checker suffices.

## Failure modes this kills

- Mismatched/unclosed tags → build gate names the tag and line.
- Wrong-depth edits → impossible: a part is one top-level block.
- Off-by-one replacements in 2000-line files → edits happen in ≤100-line files.
