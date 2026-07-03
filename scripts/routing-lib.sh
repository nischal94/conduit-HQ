# shellcheck shell=sh
# Shared routing logic for the commit-routing gates (CLAUDE.md
# "Commit routing"). Sourced by githooks/pre-push and scripts/push-docs
# so the rules live in exactly one place.
#
# Two tiers:
#   1. The PROTECTED FLOOR below — paths that may NEVER be direct-pushed,
#      hardcoded here so that widening it is a code change and therefore
#      takes the PR route by definition.
#   2. .pushallowlist — data, direct-pushable, one filename per line.
#      Entries that fall under the floor are ignored loudly, so the list
#      can grow for prose but structurally cannot open code paths.

is_protected() {
  case "$1" in
    packages/* | githooks/* | scripts/* | .github/*) return 0 ;;
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml | .nvmrc) return 0 ;;
    biome.json | html2md.py | conduitspec.html | conduitspec.md) return 0 ;;
    INVARIANTS.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Populates $ROUTING_ALLOWED (newline-separated) from .pushallowlist at
# the repo root. Blank lines and #-comments skipped; floor entries dropped.
load_allowlist() {
  ROUTING_ALLOWED=""
  [ -f .pushallowlist ] || return 0
  while IFS= read -r entry; do
    case "$entry" in '' | '#'*) continue ;; esac
    if is_protected "$entry"; then
      echo "routing: WARNING — .pushallowlist entry '$entry' is under the protected floor; ignored." >&2
      continue
    fi
    ROUTING_ALLOWED="${ROUTING_ALLOWED}${entry}
"
  done <.pushallowlist
}

is_allowed() {
  printf '%s' "$ROUTING_ALLOWED" | grep -qxF "$1"
}

# Prints the subset of a newline-separated file list that is NOT allowed
# for direct push. Empty output means the push may proceed.
blocked_paths() {
  printf '%s\n' "$1" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_allowed "$f" || printf '%s\n' "$f"
  done
}
