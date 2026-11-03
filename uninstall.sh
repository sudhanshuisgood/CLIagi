#!/usr/bin/env bash
# Remove Local Dost. Your saved API keys are kept unless you pass --purge.
set -euo pipefail
DATA_DIR="${LOCALDOST_HOME:-$HOME/.localdost}"
BIN_DIR="${LOCALDOST_BIN:-$HOME/.local/bin}"

rm -f "$BIN_DIR/localdost" "$BIN_DIR/dost"
rm -rf "$DATA_DIR/app"
echo "✔ Removed Local Dost program files."

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$DATA_DIR"
  echo "✔ Removed config and saved keys ($DATA_DIR)."
else
  [ -f "$DATA_DIR/config.json" ] && echo "  Your keys are still in $DATA_DIR/config.json (run with --purge to delete them)."
fi
echo "  A leftover '# Local Dost' PATH line in your shell rc file is harmless; delete it if you like."
