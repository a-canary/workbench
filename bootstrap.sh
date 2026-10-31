#!/bin/bash
# bootstrap.sh: install workbench from pinned component versions
# Reads manifest.json to pull the exact tested combination.
#
# Usage: ./bootstrap.sh [--dry-run]
# Exit 3 = installed, but an optional QA dependency needs a manual step (see WARN lines).

set -euo pipefail
WORKBENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi
# Clones live here, not /tmp: a reboot wipes /tmp and would dangle the ~/.pi/skills symlink.
WB_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/workbench"
STAMP=$(date +%Y%m%d%H%M%S)
WARN=0

run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "would run: $*"
    else
        "$@"
    fi
}

# Copy $1 to $2, keeping a .bak-<stamp> of an existing $2 that differs.
install_file() {
    if [[ -e "$2" ]] && ! cmp -s "$1" "$2"; then run cp "$2" "$2.bak-$STAMP"; fi
    run cp "$1" "$2"
}

echo "workbench bootstrap (dry-run=$DRY_RUN)"
echo "qualified: $(jq -r '.qualified' "$WORKBENCH_DIR/manifest.json")"
echo ""
run mkdir -p "$WB_DATA" ~/.pi/agent/extensions ~/repos

# --- Skills ---
echo "skills:"
SKILLS_REPO=$(jq -r '.components.skills.repo' "$WORKBENCH_DIR/manifest.json")
SKILLS_REF=$(jq -r '.components.skills.ref' "$WORKBENCH_DIR/manifest.json")
SKILLS_DIR="$WB_DATA/arc-skills"
if [[ -d "$SKILLS_DIR/.git" ]]; then
    run git -C "$SKILLS_DIR" fetch -q --depth 1 origin "$SKILLS_REF"
    run git -C "$SKILLS_DIR" checkout -q --detach FETCH_HEAD
else
    run git clone -q --depth 1 --branch "$SKILLS_REF" "$SKILLS_REPO" "$SKILLS_DIR"
fi
if [[ -e ~/.pi/skills && ! -L ~/.pi/skills ]]; then run mv ~/.pi/skills ~/.pi/skills.bak-"$STAMP"; fi
run ln -sfn "$SKILLS_DIR/skills" ~/.pi/skills
echo "  → ~/.pi/skills (from $SKILLS_REPO @ $SKILLS_REF)"

# --- Proxy ---
echo "proxy:"
PROXY_REPO=$(jq -r '.components.proxy.repo' "$WORKBENCH_DIR/manifest.json")
PROXY_REF=$(jq -r '.components.proxy.ref' "$WORKBENCH_DIR/manifest.json")
# ponytail: an existing checkout may be someone's dev clone, so it is left alone, not updated.
if [[ -d ~/repos/arc-llm-proxy ]]; then
    echo "  ~/repos/arc-llm-proxy: present (not updated)"
else
    run git clone -q --depth 1 --branch "$PROXY_REF" "$PROXY_REPO" ~/repos/arc-llm-proxy
    echo "  → ~/repos/arc-llm-proxy (from $PROXY_REPO @ $PROXY_REF)"
fi

# --- Pi config ---
echo "pi config:"
install_file "$WORKBENCH_DIR/pi/models.json" ~/.pi/agent/models.json
install_file "$WORKBENCH_DIR/pi/agent-settings.json" ~/.pi/agent/settings.json
install_file "$WORKBENCH_DIR/pi/pi-settings.json" ~/.pi/settings.json
echo "  → ~/.pi/ (changed files kept as *.bak-$STAMP)"

# --- Pi extensions ---
echo "extensions:"
for f in "$WORKBENCH_DIR"/pi/extensions/*.ts "$WORKBENCH_DIR"/pi/extensions/*.json; do
    if [[ -e "$f" ]]; then install_file "$f" ~/.pi/agent/extensions/"${f##*/}"; fi
done
echo "  → ~/.pi/agent/extensions/"

# --- QA role dependencies (optional: a failure warns, it does not abort) ---
echo "QA dependencies:"
chrome=${WORKER_CHROME:-$(ls -d "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64 2>/dev/null | sort -V | tail -1 || true)}
if [ -x "$chrome/chrome-headless-shell" ]; then
    echo "  chrome-headless-shell: present ($chrome)"
elif ! run npx -y @puppeteer/browsers install chrome-headless-shell --path "$HOME/.cache/puppeteer"; then
    echo "  WARN: chrome-headless-shell install failed (is node/npx installed?)"
    WARN=1
fi
if python3 -c 'import PIL, numpy' 2>/dev/null; then
    echo "  pillow+numpy: present"
elif ! run python3 -m pip install --user pillow numpy; then
    echo "  WARN: pip refused (PEP 668 on Debian/Ubuntu?). Run: sudo apt install python3-pil python3-numpy"
    WARN=1
fi

echo ""
if [[ $WARN -eq 1 ]]; then echo "done, with warnings above."; exit 3; fi
echo "done."
echo "verify: ~/repos/harness-bench/bin/bench run smoke --label verify"
