#!/usr/bin/env bash
# Publishes the files in exports/daily-rates/ (as generated in the working
# tree) to the `rates-feed` branch as ONE parentless commit, replacing whatever
# the branch held before — so past feed versions never pile up in history.
# Mirrors the in-app publisher (publishSnapshotBranch in js/core/github.js).
#
# The replace is a force-push, but with a lease: it only succeeds if the branch
# still points at the commit this script looked at. If the app (or another run)
# published in between, the push is refused instead of silently overwriting the
# newer feed. Workflows that call this share the `rates-feed` concurrency group.
set -euo pipefail

FEED_DIR="exports/daily-rates"
FEED_BRANCH="rates-feed"

if [ ! -f "$FEED_DIR/index.json" ]; then
  echo "No $FEED_DIR/index.json generated — nothing to publish."
  exit 0
fi

# Build the tree in a throwaway index so main's index/worktree are untouched.
tmp_index="$(mktemp)"
trap 'rm -f "$tmp_index"' EXIT
export GIT_INDEX_FILE="$tmp_index"
git read-tree --empty
git add -f "$FEED_DIR"   # -f: exports/ is gitignored on main
tree="$(git write-tree)"
unset GIT_INDEX_FILE

# Current tip of the branch ("" if it doesn't exist yet) — the lease.
current_commit=""
current_tree=""
if git ls-remote --exit-code origin "refs/heads/$FEED_BRANCH" >/dev/null 2>&1; then
  git fetch -q --depth=1 origin "$FEED_BRANCH"
  current_commit="$(git rev-parse FETCH_HEAD)"
  current_tree="$(git rev-parse "FETCH_HEAD^{tree}")"
fi
if [ "$tree" = "$current_tree" ]; then
  echo "Feeds unchanged — not republishing."
  exit 0
fi

commit="$(git commit-tree "$tree" -m "Publish daily-rate feeds")"
# --force-with-lease=<ref>:<expected> ("" = the branch must not exist yet).
git push --force-with-lease="refs/heads/$FEED_BRANCH:$current_commit" origin "$commit:refs/heads/$FEED_BRANCH"
echo "Published $FEED_DIR to $FEED_BRANCH ($commit)"
