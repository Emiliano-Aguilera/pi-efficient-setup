#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
GEMINI_DIR="${GEMINI_DIR:-$HOME/.gemini}"
BIN_DIR="${LOCAL_BIN_DIR:-$HOME/.local/bin}"

use_agy=1
force=0
dry_run=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--no-agy] [--force] [--dry-run]

Installs extensions, model prompts, roles/skills, AGENTS.md, and transcript-text
into ~/.pi/agent/, ~/.gemini/, and ~/.local/bin/.

Options:
  --no-agy   Skip ~/.gemini/ wiring; copy roles directly to ~/.pi/agent/roles/.
  --force    Overwrite an existing ~/.pi/agent/AGENTS.md (backs up old copy)
             and replace a non-symlink ~/.gemini/GEMINI.md.
             Never overwrites an existing ~/.pi/agent/settings.json.
  --dry-run  Print planned actions without writing anything.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-agy) use_agy=0 ;;
    --force) force=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; usage >&2; exit 1 ;;
  esac
done

run() {
  if (( dry_run )); then
    printf '[dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

backup_suffix() {
  date +%Y%m%d-%H%M%S
}

install_file() {
  local src="$1" dst="$2" mode="${3:-0644}"
  run mkdir -p "$(dirname "$dst")"
  if (( dry_run )); then
    printf '[dry-run] install -m %s %s -> %s\n' "$mode" "$src" "$dst"
  else
    install -m "$mode" "$src" "$dst"
  fi
}

echo "== Installing Pi extensions and model prompts =="
for ext in "$REPO_DIR/pi/extensions/"*.ts; do
  install_file "$ext" "$PI_DIR/extensions/$(basename "$ext")" 0644
done

for prompt in "$REPO_DIR/pi/model-prompts/"*.md; do
  install_file "$prompt" "$PI_DIR/model-prompts/$(basename "$prompt")" 0644
done

echo "== Installing roles =="
run mkdir -p "$PI_DIR/roles"
for role_file in "$REPO_DIR/pi/roles/"*.md; do
  name="$(basename "$role_file" .md)"
  if (( use_agy )); then
    skill_path="$GEMINI_DIR/config/skills/$name/SKILL.md"
    # Antigravity (agy) requires real files inside ~/.gemini/config/skills/.
    install_file "$role_file" "$skill_path" 0644
    run ln -sfn "$skill_path" "$PI_DIR/roles/$name.md"
  else
    install_file "$role_file" "$PI_DIR/roles/$name.md" 0644
  fi
done

echo "== Installing AGENTS.md =="
agents_src="$REPO_DIR/pi/AGENTS.md"
agents_dst="$PI_DIR/AGENTS.md"
if [[ ! -e "$agents_dst" && ! -L "$agents_dst" ]]; then
  install_file "$agents_src" "$agents_dst" 0644
elif cmp -s "$agents_src" "$agents_dst" 2>/dev/null; then
  echo "OK: $agents_dst already matches"
elif (( force )); then
  bak="$agents_dst.bak.$(backup_suffix)"
  echo "Backing up existing $agents_dst -> $bak"
  run mv "$agents_dst" "$bak"
  install_file "$agents_src" "$agents_dst" 0644
else
  echo "KEPT: $agents_dst already exists and differs (re-run with --force to replace, or copy the '## Roles' block from $agents_src)."
fi

if (( use_agy )); then
  run mkdir -p "$GEMINI_DIR"
  gemini_md="$GEMINI_DIR/GEMINI.md"
  if [[ ! -e "$gemini_md" && ! -L "$gemini_md" ]] || [[ -L "$gemini_md" ]]; then
    run ln -sfn "$agents_dst" "$gemini_md"
  elif (( force )); then
    bak="$gemini_md.bak.$(backup_suffix)"
    echo "Backing up existing $gemini_md -> $bak"
    run mv "$gemini_md" "$bak"
    run ln -sfn "$agents_dst" "$gemini_md"
  else
    echo "KEPT: $gemini_md is a regular file (re-run with --force to link to $agents_dst, or add the '## Roles' block manually)."
  fi
fi

echo "== Installing transcript-text =="
install_file "$REPO_DIR/bin/transcript-text" "$BIN_DIR/transcript-text" 0755
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "NOTE: $BIN_DIR is not on your current PATH. Add it to your shell profile so agents can run 'transcript-text'." ;;
esac

echo "== Checking settings.json =="
settings_dst="$PI_DIR/settings.json"
if [[ ! -e "$settings_dst" ]]; then
  install_file "$REPO_DIR/pi/settings.template.json" "$settings_dst" 0644
  echo "Created $settings_dst from settings.template.json"
else
  echo "KEPT: $settings_dst already exists. Ensure it has:"
  echo '  - "defaultProvider": "claude-code"'
  echo '  - "cacheWarming": "off"'
  echo '  - "packages": [..., "git:github.com/earendil-works/pi-claude-code"]'
fi

echo ""
echo "Done. Next steps:"
echo "  1. Ensure Claude Code CLI is installed and logged in ('claude auth login')."
echo "  2. If using Antigravity, set T3's antigravity binaryPath to 'agy' (not the bundled server)."
echo "  3. Set T3's Pi launchArgs to '--approve' and T3's idleCompaction to 'off'."
echo "  4. Run ./verify.sh$( (( use_agy )) || printf ' --no-agy' ) to verify the setup."
