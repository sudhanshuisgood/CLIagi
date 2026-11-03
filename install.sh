#!/usr/bin/env bash
# Local Dost installer (macOS / Linux / WSL / Git-Bash)
#   curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/local-dost/main/install.sh | bash
set -euo pipefail

REPO="${LOCALDOST_REPO:-YOUR_GITHUB_USERNAME/local-dost}"
BRANCH="${LOCALDOST_BRANCH:-main}"
DATA_DIR="${LOCALDOST_HOME:-$HOME/.localdost}"
APP_DIR="$DATA_DIR/app"
BIN_DIR="${LOCALDOST_BIN:-$HOME/.local/bin}"

if [ -t 1 ]; then C=$'\033[36m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'; else C=''; B=''; D=''; R=''; G=''; N=''; fi
say() { printf '%s\n' "${C}▸${N} $*"; }
ok()  { printf '%s\n' "${G}✔${N} $*"; }
die() { printf '%s\n' "${R}✖ $*${N}" >&2; exit 1; }

printf '\n%s\n\n' "${B}${C}Local Dost${N} ${D}· free AI coding agent for your terminal${N}"

# 1. Node.js 18+
command -v node >/dev/null 2>&1 || die "Node.js 18+ is required but not installed.
  Install it from https://nodejs.org  (or: nvm install --lts / brew install node / sudo apt install nodejs)
  Then run this installer again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18+ is required (found $(node -v)). Please upgrade: https://nodejs.org"
ok "Node $(node -v)"

# 2. Get the code
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
mkdir -p "$DATA_DIR" "$BIN_DIR"

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/bin/localdost.js" ]; then
  say "Installing from local checkout"
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
  cp -R "$SCRIPT_DIR/bin" "$SCRIPT_DIR/src" "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/uninstall.sh" "$APP_DIR/"
elif command -v git >/dev/null 2>&1; then
  if [ -d "$APP_DIR/.git" ]; then
    say "Updating existing install"
    git -C "$APP_DIR" pull --ff-only --quiet
  else
    say "Downloading Local Dost"
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$BRANCH" --quiet "https://github.com/$REPO.git" "$APP_DIR" \
      || die "Could not download https://github.com/$REPO (check the repo name and your internet)."
  fi
elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
  say "Downloading Local Dost"
  rm -rf "$APP_DIR"; mkdir -p "$APP_DIR"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components=1 -C "$APP_DIR" \
    || die "Could not download https://github.com/$REPO (check the repo name and your internet)."
else
  die "Need either git, or curl + tar, to download Local Dost."
fi
[ -f "$APP_DIR/bin/localdost.js" ] || die "Install looks incomplete: $APP_DIR/bin/localdost.js is missing."
ok "Installed to $APP_DIR"

# 3. Launchers on PATH
for name in localdost dost; do
  cat > "$BIN_DIR/$name" <<EOF
#!/usr/bin/env bash
exec node "$APP_DIR/bin/localdost.js" "\$@"
EOF
  chmod +x "$BIN_DIR/$name"
done
ok "Commands created: localdost, dost"

# 4. Make sure BIN_DIR is on PATH for future shells
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    case "${SHELL:-}" in
      */zsh)  RC="$HOME/.zshrc" ;;
      */fish) RC="$HOME/.config/fish/config.fish" ;;
      *)      RC="$HOME/.bashrc"; [ -f "$RC" ] || { [ -f "$HOME/.bash_profile" ] && RC="$HOME/.bash_profile"; } ;;
    esac
    mkdir -p "$(dirname "$RC")"; touch "$RC"
    if ! grep -qs '# Local Dost' "$RC"; then
      if [ "${RC##*.}" = "fish" ] || [ "$(basename "$RC")" = "config.fish" ]; then
        printf '\n# Local Dost\nset -gx PATH "%s" $PATH\n' "$BIN_DIR" >> "$RC"
      else
        printf '\n# Local Dost\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"
      fi
      ok "Added $BIN_DIR to PATH in $RC"
    fi
    NEED_RELOAD=1
    ;;
esac

printf '\n%s\n' "${B}${G}All set!${N}"
printf '%s\n' "  1. ${NEED_RELOAD:+Open a new terminal (or run: ${C}export PATH=\"$BIN_DIR:\$PATH\"${N}), then }go to any project folder"
printf '%s\n' "  2. Run ${B}${C}localdost${N}  ${D}(first run walks you through free API keys)${N}"
printf '\n%s\n\n' "${D}Update: localdost update  (or re-run this installer)   Remove: ~/.localdost/app/uninstall.sh${N}"
