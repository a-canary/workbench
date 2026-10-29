# Workbench v1 vs Current Private Stack — Diff Report

Generated: 2026-06-22
Updated: 2026-06-22 (post-fix)

## Summary

**Risk level: HIGH → MEDIUM (after fixes applied).** First deploy would break the V100 queue system, roll back 12 skill commits, and switch models.json format. Fixes applied to deploy-stable.sh.

## Component-by-Component Diff

### 1. Skills (arc-skills)

| Aspect | Current | Workbench v1 | Impact |
|--------|---------|--------------|--------|
| Commit | `a8eab4b` (HEAD) | `50e0d361` (pinned) | **Rollback of 12 commits** |
| Skills dir | `~/.pi/skills -> ~/repos/arc-skills/skills` (symlink) | Hard copy to `~/.pi/skills` | Symlink lost |

**Commits lost on rollback:**
- `a8eab4b` feat(agent-mode): explicit role declaration for herdr panes
- `ca2672e` feat: declare MODE in director/driver/worker skills
- `e51a63b` feat(skills): add agent-mode skill
- `d955faa` rules: add tool capability matching rule
- `7c34383` driver: add completion notification to director
- `6bef97f` Merge epic director-0n5: consolidate beads model
- `95d5028` consolidate beads model to central ~/vault/director/.bd/
- `f37159a` bd init: initialize beads issue tracking
- `5085830` policy: fix Opus → counsel references
- `0daf34d` policy: Defend gates use counsel instead of Opus
- `01f5ca3` policy: rename DefendRelease → DefendDeploy
- `98417c9` rule: collapse screenshots before VLM ingestion

**Risk:** Director/driver/worker role declarations lost, beads model split, policy changes reverted.

### 2. Pi models.json

| Aspect | Current | Workbench v1 | Impact |
|--------|---------|--------------|--------|
| Model count | 40 | 38 | 2 models lost |
| Aliases | `fast`, `queue` present | **Missing** | **V100 queue system broken** |
| API keys | Real keys | `!pass show` placeholders | **All API calls fail** |
| Base URLs | Real IPs | `YOUR-IP` placeholders | **All proxy calls fail** |
| **Format** | Object with `providers` key | **Array of provider objects** | **Schema incompatibility** |

**Models lost:**
- `fast` — alias for v100/flash (critical for fast work)
- `queue` — alias for v100/queue (critical for background work)

**Schema incompatibility:** The operator's config is `{"providers": {...}}` (object), workbench template is `[{baseUrl, models}]` (array). Pi accepts both but switching formats could break assumptions in other tooling.

**FIX APPLIED:** Deploy script no longer overwrites models.json. Backs up local config and preserves it. Workbench template kept only for fresh installs.

### 3. Pi settings.json

| Aspect | Current | Workbench v1 | Impact |
|--------|---------|--------------|--------|
| File | `~/.pi/agent/settings.json` exists | `pi/pi-settings.json` **does not exist** | No change (script has `|| true`) |

Current settings preserved. No risk here.

### 4. Pi extensions

| Extension | Current | Workbench v1 | Impact |
|-----------|---------|--------------|--------|
| auto-remind.ts | ✓ | ✓ | Same |
| auto-session-name.ts | ✓ | ✓ | Same |
| auto-update.ts | ✓ | ✓ | Same |
| compact-header.ts | ✓ | ✓ | Same |
| git-guard.ts | ✓ | ✓ | Same |
| herdr-agent-state.ts | ✓ | ✓ | Same |
| ke-hooks.ts | ✓ | ✓ | Same |
| write-guard.ts | ✓ | ✓ | Same |

**No risk.** All extensions match. Write-guard already active.

### 5. arc-llm-proxy

| Aspect | Current | Workbench v1 | Impact |
|--------|---------|--------------|--------|
| Commit | Need to check | main (unpinned) | Unpinned ref = unpredictable |

Proxy commit not pinned in manifest — `ref: "main"` means deploy gets whatever main is at deploy time.

## Recommendations Before First Deploy

### Must-fix (blocking)

1. **Fix deploy-stable.sh models.json handling:** ✅ FIXED
   - Script now backs up local models.json and preserves it (no overwrite)
   - Workbench template kept only for fresh installs

2. **Fix skills deploy target:** ✅ FIXED
   - Script no longer clones to volatile /tmp
   - Uses existing ~/repos/arc-skills checkout, preserves symlink

3. **Update manifest pinned commit:** ⚠️ DECISION NEEDED
   - `last_tested` is `50e0d361`, current HEAD is `a8eab4b` (12 commits ahead)
   - Options: bump pin, or document intentional rollback

4. **Pin proxy commit:** ⚠️ TODO
   - `ref: "main"` means deploy gets whatever main is at deploy time
   - Should pin to specific commit for reproducibility

### Should-fix

4. **Add `fast` and `queue` aliases to workbench template:**
   - These are essential for the V100 queue system
   - Without them, deployed workbench can't do queue-based scheduling

5. **Run actual harness-bench:**
   - Manifest claims `last_tested` but no results in `.harness-bench/results/`
   - The "tested" claim is currently unverified

### Nice-to-have

6. **Document the skills symlink vs hard-copy difference:**
   - Current setup uses symlink (live updates with git)
   - Workbench uses hard copy (frozen at deploy time)

## Verdict

**First deploy is now SAFE** for the operator's existing setup (items 1-2 fixed). Models preserved, skills update in-place.

**Remaining risk:** Skills pinned commit `50e0d361` is 12 commits behind current HEAD. First deploy will roll back agent-mode work. Decision needed: bump pin or accept rollback.

**For fresh installs:** Workbench template is missing `fast`/`queue` aliases. New machines won't have the V100 queue system out of the box.
