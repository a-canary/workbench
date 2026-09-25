---
name: youtube-extract
description: Extract info and judgement from a YouTube video — clean transcript, chapter map, screenshots of critical visual moments, and referenced material (repos, whitepapers, links) assessed against the video's claims. Use when asked to summarize, analyze, or mine a YouTube video/talk, or given a youtube.com/youtu.be URL needing more than a title.
---

# youtube-extract

Turn one YouTube URL into verified, durable knowledge. Requires `yt-dlp` + `ffmpeg`.
Work in `$CLAUDE_JOB_DIR/tmp` (fallback `mktemp -d`). `URL="<video>"`.

## 1. Metadata + links (no download)

```bash
yt-dlp --skip-download --dump-json "$URL" > meta.json
python3 -c "
import json,re; m=json.load(open('meta.json'))
print(m['title'],'|',m['uploader'],'|',m['upload_date'],'|',m['duration_string'])
for c in (m.get('chapters') or []): print(f\"{int(c['start_time'])//60}:{int(c['start_time'])%60:02d}\", c['title'])
print(*sorted(set(re.findall(r'https?://[^\s)\\\"]+', m['description']))), sep='\n')"
```

Classify links: github / arxiv-whitepaper / docs / promo-noise. Keep the first three kinds.

## 2. Transcript

```bash
yt-dlp --skip-download --write-auto-subs --sub-langs en --sub-format vtt -o t "$URL"   # no en subs? check meta.json subtitles keys
python3 ~/.claude/skills/youtube-extract/scripts/clean_vtt.py t.en.vtt > transcript.txt
```

Auto-VTT has rolling duplicate lines + word-timing tags; `clean_vtt.py` dedupes to `[MM:SS] text`.
Read `transcript.txt` (grep-range it if >2k lines; chapters tell you where the meat is).

## 3. Pick critical visual moments

From transcript + chapters, list timestamps (cap ~6) where visuals carry info words can't:
cues like "this chart", "as you can see", "here's the code/backtest/results", demo/results chapters.
Skip talking-head stretches — a screenshot must earn its tokens.

## 4. Screenshots

Per timestamp (compute END = start + 2s yourself):

```bash
yt-dlp -f "bestvideo[height<=720]" --download-sections "*HH:MM:SS-HH:MM:SS_END" -o "seg.%(ext)s" "$URL"
ffmpeg -y -i seg.* -frames:v 1 shot_HHMMSS.jpg 2>/dev/null   # may core-dump AFTER writing — check file exists
rm seg.*
```

Read each image; transcribe charts/tables/code into text in the breakdown (the jpg is temp, the text is durable).

## 5. Chase references

For each kept link, ask a named question first ("does the repo implement the claimed X?", "does the paper report the quoted number?") then WebFetch/clone only to answer it. No named question → don't fetch. Note claim-vs-source agreement.

## 6. Judgement

Separate durable/actionable (method, number with provenance, gotcha, repo worth using) from hype/filler. State confidence and whether each key claim was source-verified (step 5) or is the speaker's assertion only. Domain lenses: trading/finance → extract the *method* (signal construction, flow/rebalance mechanics), not the prediction; coding/AI → does the repo/paper actually support the demo.

## 7. Output

Caller asked for a specific output → produce that. Otherwise:

- **Durables → ke**: one `ke add "youtube/<channel>/<slug>"` per standalone finding, body includes claim, verification status, and provenance `URL @ MM:SS`.
- **Full breakdown → tmp file**: `breakdown.md` in the workdir — metadata, chapter map, cleaned key-claims list, screenshot transcriptions, link assessments, judgement. Report the path.
