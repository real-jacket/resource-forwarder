#!/usr/bin/env bash
# One-click installer for Resource Forwarder "agent control": builds the `rf` CLI,
# links it onto PATH, and installs the agent skill into Claude Code and/or Codex.
#
# Usage:
#   scripts/install-agent-control.sh [--no-build] [--claude-only|--codex-only]
#                                    [--bin-dir DIR] [--uninstall]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILL_NAME="agent-forwarder-control"
SKILL_SRC="$REPO_ROOT/skills/$SKILL_NAME"
RF_ENTRY="$REPO_ROOT/packages/forwarder-service/dist/rf.js"

DO_BUILD=1
DO_CLAUDE=1
DO_CODEX=1
DO_UNINSTALL=0
BIN_DIR="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --claude-only) DO_CODEX=0 ;;
    --codex-only) DO_CLAUDE=0 ;;
    --uninstall) DO_UNINSTALL=1 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "--bin-dir requires a directory" >&2; exit 2; }
      BIN_DIR="$2"; shift
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\033[1;34m[agent-control]\033[0m %s\n' "$*"; }

install_skill() {
  local dest_root="$1" label="$2"
  mkdir -p "$dest_root"
  rm -rf "${dest_root:?}/$SKILL_NAME"
  cp -R "$SKILL_SRC" "$dest_root/$SKILL_NAME"
  log "installed skill → $dest_root/$SKILL_NAME"
}

if [ "$DO_UNINSTALL" = 1 ]; then
  rm -f "$BIN_DIR/rf"
  [ "$DO_CLAUDE" = 1 ] && rm -rf "$HOME/.claude/skills/$SKILL_NAME"
  [ "$DO_CODEX" = 1 ] && rm -rf "$HOME/.codex/skills/$SKILL_NAME"
  log "uninstalled rf wrapper and selected Claude/Codex skill targets"
  exit 0
fi

if [ "$DO_BUILD" = 1 ]; then
  log "building forwarder-service (pnpm build)…"
  ( cd "$REPO_ROOT" && pnpm build )
fi

[ -f "$RF_ENTRY" ] || { echo "rf entry not built: $RF_ENTRY (run without --no-build)" >&2; exit 1; }

# Install `rf` as a wrapper (not a bare symlink): the CLI's main-module guard compares
# import.meta.url against process.argv[1], and a symlink path would not match, silently no-op.
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/rf" <<EOF
#!/bin/sh
if [ -z "\${RF_STORAGE_ROOT:-}" ]; then
  export RF_STORAGE_ROOT="$REPO_ROOT/packages/forwarder-service/.resource-forwarder"
fi
exec node "$RF_ENTRY" "\$@"
EOF
chmod +x "$BIN_DIR/rf"
log "installed rf wrapper → $BIN_DIR/rf  (execs $RF_ENTRY; defaults RF_STORAGE_ROOT to $REPO_ROOT/packages/forwarder-service/.resource-forwarder)"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) log "WARNING: $BIN_DIR is not on PATH — add it to your shell profile." ;;
esac

[ "$DO_CLAUDE" = 1 ] && install_skill "$HOME/.claude/skills" "Claude Code"
[ "$DO_CODEX" = 1 ] && install_skill "$HOME/.codex/skills" "Codex"

log "done. Next:"
log "  1) start the service:  pnpm dev:service   (from $REPO_ROOT)"
log "  2) open the token file path printed by the service and paste its contents into extension Settings"
log "  3) verify CLI:         rf service status"
log "  4) restart Claude Code / Codex so the '$SKILL_NAME' skill is loaded"
