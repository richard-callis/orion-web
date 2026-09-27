#!/usr/bin/env bash
# ORION Git Worktree Manager
# Usage:
#   orion-worktree.sh create <branch-name> [worktree-path]
#   orion-worktree.sh list
#   orion-worktree.sh delete <branch-name>
#   orion-worktree.sh open <branch-name>
#
# All worktrees live under .worktrees/ and share the same .git dir.

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
GIT_DIR="$REPO_ROOT/.git"
WT_DIR="$REPO_ROOT/.worktrees"

usage() {
  echo "Usage: $(basename "$0") {create|list|delete|open} [args...]"
  exit 1
}

cmd_create() {
  local branch="${1:?Branch name required}"
  local path="${2:-$WT_DIR/$branch}"

  if git -C "$REPO_ROOT" branch --list -q "$branch" | grep -q "$branch"; then
    echo "ERROR: branch '$branch' already exists"
    exit 1
  fi

  if [ -d "$path" ]; then
    echo "ERROR: directory '$path' already exists (remove it first)"
    exit 1
  fi

  git -C "$REPO_ROOT" worktree add -b "$branch" "$path" origin/main
  echo "Created: $path  (branch: $branch)"
  echo "  cd $path"
  echo "  git checkout $branch"
}

cmd_list() {
  echo "ORION worktrees (sharing $REPO_ROOT/.git):"
  git -C "$REPO_ROOT" worktree list
}

cmd_delete() {
  local branch="${1:?Branch name required}"

  # Find the worktree dir
  # Exact branch match (porcelain output) — a substring match could pick, and
  # rm -rf, the wrong worktree.
  local path
  path=$(git -C "$REPO_ROOT" worktree list --porcelain | awk -v ref="refs/heads/$branch" '
    /^worktree / { wt = substr($0, 10) }
    $0 == "branch " ref { print wt; exit }
  ')

  if [ -z "$path" ]; then
    echo "ERROR: no worktree for branch '$branch'"
    exit 1
  fi

  # If the worktree is checked out with changes, force-remove
  git -C "$REPO_ROOT" worktree remove -f "$path" 2>/dev/null || true
  rm -rf "$path"

  # Delete the branch
  git -C "$REPO_ROOT" branch -D "$branch" 2>/dev/null || true

  echo "Deleted: branch '$branch', worktree '$path'"
}

cmd_open() {
  local branch="${1:?Branch name required}"
  local path="$WT_DIR/$branch"

  if [ ! -d "$path" ]; then
    echo "ERROR: no worktree for branch '$branch' (run: $0 create $branch)"
    exit 1
  fi

  echo "Opening: $path"
  cd "$path" && exec bash -i
}

# Dispatch on the subcommand; each handler gets the remaining arguments.
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  create) cmd_create "$@" ;;
  list)   cmd_list ;;
  delete) cmd_delete "$@" ;;
  open)   cmd_open "$@" ;;
  *)      usage ;;
esac
