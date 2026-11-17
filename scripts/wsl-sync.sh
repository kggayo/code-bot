#!/usr/bin/env bash
# Copies this checkout into the Linux filesystem of WSL (or any Linux machine
# that sees the Windows drive) so the Linux build can be tested there:
#   wsl -d Ubuntu --exec bash scripts/wsl-sync.sh [target]
# node_modules, out and release are not copied: run `npm ci` in the copy.
set -euo pipefail
source="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-$HOME/code-bot-linux}"
mkdir -p "$target"
rsync -a --delete \
  --exclude node_modules --exclude out --exclude release --exclude .git --exclude data \
  "$source/" "$target/"
echo "Copied $source to $target"
