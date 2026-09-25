#!/bin/bash
# bootstrap.sh: resolve !pass show references and copy configs into place
# Run once after clone, or after rotating keys in pass.
#
# Usage: ./bootstrap.sh [--dry-run]

set -euo pipefail
DRY_RUN=0
if [[ "$1" == "--dry-run" ]]; then DRY_RUN=1; fi

WORKBENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi"

copy_file() {
    local src="$1" dst="$2"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "would copy: $src -> $dst"
    else
        cp "$src" "$dst"
        echo "copied: $src -> $dst"
    fi
}

copy_dir() {
    local src="$1" dst="$2"
    if [[ $DRY_RUN -eq 1 ]]; then
        echo "would copy dir: $src -> $dst"
    else
        cp -r "$src"/* "$dst/"
        echo "copied dir: $src -> $dst"
    fi
}

echo "workbench bootstrap (dry-run=$DRY_RUN)"

# 1. Skills
copy_dir "$WORKBENCH_DIR/skills" "$PI_DIR/skills"

# 2. Pi config (models.json has !pass show refs — resolved at runtime by pi)
copy_file "$WORKBENCH_DIR/pi/models.json" "$PI_DIR/agent/models.json"
copy_file "$WORKBENCH_DIR/pi/settings.json" "$PI_DIR/agent/settings.json"
copy_file "$WORKBENCH_DIR/pi/pi-settings.json" "$PI_DIR/settings.json"

# 3. Extensions
copy_dir "$WORKBENCH_DIR/pi/extensions" "$PI_DIR/agent/extensions"

echo ""
echo "done. pass references in models.json resolve at runtime (pi reads them)."
echo "if a key is missing from pass, the provider will fail with 401."
