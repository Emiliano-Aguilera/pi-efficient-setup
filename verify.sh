#!/usr/bin/env bash
# Read-only health check for the Pi + Claude + Antigravity setup.
set -euo pipefail

PI_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
GEMINI_DIR="${GEMINI_DIR:-$HOME/.gemini}"
use_agy=1
fail=0

for arg in "$@"; do
  case "$arg" in
    --no-agy) use_agy=0 ;;
    -h|--help)
      echo "Usage: ./verify.sh [--no-agy]"
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

echo "== Symlinks under $PI_DIR =="
if [[ -d "$PI_DIR" ]]; then
  while IFS= read -r link; do
    target=$(readlink "$link" || true)
    if [[ ! -e "$link" ]]; then
      echo "BROKEN: $link -> $target"
      fail=1
    elif [[ "$target" == *".claude"* ]]; then
      echo "CLAUDE-DEP: $link -> $target"
      fail=1
    else
      echo "OK: $link -> $target"
    fi
  done < <(find "$PI_DIR" -maxdepth 2 -type l | sort)
else
  echo "MISSING: $PI_DIR"
  fail=1
fi

echo "== Required helpers on PATH =="
if command -v transcript-text >/dev/null 2>&1; then
  echo "OK: transcript-text ($(command -v transcript-text))"
else
  echo "MISSING: transcript-text (expected in ~/.local/bin or PATH)"
  fail=1
fi

echo "== Settings JSON =="
settings="$PI_DIR/settings.json"
if [[ ! -f "$settings" ]]; then
  echo "MISSING: $settings"
  fail=1
elif command -v jq >/dev/null 2>&1; then
  if jq -e . "$settings" >/dev/null 2>&1; then
    echo "OK: settings.json valid JSON"
    cw=$(jq -r '.cacheWarming // empty' "$settings")
    if [[ "$cw" != "off" ]]; then
      echo "WARN: cacheWarming is '${cw:-unset}' (recommended: \"off\")"
    fi
  else
    echo "INVALID JSON: $settings"
    fail=1
  fi
elif python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$settings" 2>/dev/null; then
  echo "OK: settings.json valid JSON"
else
  echo "INVALID JSON: $settings"
  fail=1
fi

echo "== Pi binary & extensions =="
pi_bin=""
if command -v pi >/dev/null 2>&1; then
  pi_bin=$(command -v pi)
elif [[ -x "$PI_DIR/bin/pi" ]]; then
  pi_bin="$PI_DIR/bin/pi"
fi

if [[ -n "$pi_bin" ]]; then
  stale=$("$pi_bin" --help 2>&1 | grep -F "Warning: No models match pattern" || true)
  if [[ -n "$stale" ]]; then
    echo "$stale"
    fail=1
  else
    echo "OK: all enabledModels match"
  fi
  for ext in "$PI_DIR/extensions/"*.ts; do
    [[ -e "$ext" ]] || continue
    if "$pi_bin" -ne -e "$ext" --help >/dev/null 2>&1; then
      echo "OK: loads $(basename "$ext")"
    else
      echo "LOAD FAIL: $ext"
      fail=1
    fi
  done
else
  echo "SKIP: pi not found on PATH or $PI_DIR/bin/pi"
fi

echo "== Roles referenced in model-prompts / AGENTS.md =="
roles=$(grep -hEo 'Role:[[:space:]]*[a-zA-Z0-9_-]+' "$PI_DIR/AGENTS.md" "$PI_DIR/model-prompts/"*.md 2>/dev/null | sed -E 's/Role:[[:space:]]*//' | sort -u || true)
for r in $roles; do
  [[ "$r" == "name" ]] && continue
  if [[ -f "$PI_DIR/roles/$r.md" ]]; then
    echo "OK: role $r ($PI_DIR/roles/$r.md)"
  else
    echo "MISSING ROLE: $PI_DIR/roles/$r.md"
    fail=1
  fi
  if (( use_agy )); then
    skill="$GEMINI_DIR/config/skills/$r/SKILL.md"
    if [[ -L "$skill" ]]; then
      echo "WARN/FAIL: $skill is a symlink (agy requires real files inside skills/)"
      fail=1
    elif [[ -f "$skill" ]]; then
      echo "OK: skill $r ($skill)"
    else
      echo "MISSING SKILL: $skill"
      fail=1
    fi
  fi
done

if (( use_agy )); then
  echo "== Gemini global link =="
  expected=$(readlink -f "$PI_DIR/AGENTS.md" 2>/dev/null || echo "$PI_DIR/AGENTS.md")
  actual=$(readlink -f "$GEMINI_DIR/GEMINI.md" 2>/dev/null || true)
  if [[ "$actual" == "$expected" ]]; then
    echo "OK: $GEMINI_DIR/GEMINI.md -> $expected"
  else
    echo "MISMATCH: $GEMINI_DIR/GEMINI.md -> ${actual:-<missing>} (expected $expected)"
    fail=1
  fi
  if ! command -v agy >/dev/null 2>&1; then
    echo "WARN: 'agy' CLI not found on PATH"
  else
    echo "OK: agy ($(command -v agy))"
  fi
fi

exit "$fail"
