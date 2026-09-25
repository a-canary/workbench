---
name: img-collapse
description: Collapse dead space (maximal runs of identical adjacent rows/columns) in a screenshot before VLM ingestion, then crop the RAW original back out via an index sidecar. Use when a VLM must see a long screenshot with large empty regions (terminal scrollback, tall web pages, dashboards) and you need exact pixel recovery for any region it references.
---

# img-collapse

VLMs waste tokens on dead space. Collapse maximal runs of identical adjacent rows/columns into one; keep an index sidecar so any collapsed-coordinate box maps back to the raw original pixels — lossless, no re-rendering.

Stack: python3 + Pillow + numpy (stdlib otherwise). Script is executable, no install.

## Usage

```
skills/img-collapse/img-collapse collapse <in> <out>
    # writes <out> (collapsed PNG) + <out>.map.json, prints orig WxH -> collapsed WxH and bytes before/after

skills/img-collapse/img-collapse crop <orig> <sidecar> --box x0,y0,x1,y1 [--out PATH]
    # box in COLLAPSED coords (inclusive) -> writes the RAW original pixels for that region,
    # prints the original-coordinate box used. Default out: <orig>.crop.png

skills/img-collapse/img-collapse --selftest
```

## Workflow

1. `collapse` the screenshot; feed the collapsed PNG to the VLM.
2. When the VLM references a region in collapsed coordinates, `crop` the original and hand those raw pixels (or a zoom) back.
3. Never edit the sidecar by hand — it is the only mapping between coordinate spaces.

## Semantics

- A row/col is kept iff it differs from the last KEPT neighbor; each maximal run of identical neighbors keeps exactly its first member.
- Rows collapse first, then columns on the row-collapsed grid (order matters for the sidecar shape).
- Pixel-exact: collapsed output and crops are straight pixel subsets of the original — no resampling, mode preserved.
- Palette (P-mode) images compare by palette index, not resolved color — two indices mapping to the same RGB value are treated as distinct. Rare in screenshots; convert to RGB first if it matters.
- `--box` is inclusive on both ends; out-of-bounds or reversed boxes (x0>x1, y0>y1) are rejected with the collapsed dimensions printed.
- Distortion caveat: distances are compressed, relative alignment preserved. For metric-accurate reads (graphs, diagrams where distance is language) view the collapsed image, then request a raw crop for the region in question.

## Selftest

5 assert cases: uniform 100x100 -> 1x1 (maps all-zero); checkerboard unchanged (0 dropped); 50 content / 200 blank / 50 content rows -> height 101 with monotonic row_map and correct boundary indices; crop round-trip equals original pixels; single-pixel + full-frame edges.
