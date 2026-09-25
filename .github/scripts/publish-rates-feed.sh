#!/usr/bin/env bash
# Publishes the files in exports/daily-rates/ (as generated in the working
# tree) to the `rates-feed` branch as ONE parentless commit, replacing whatever
# the branch held before — so past feed versions never pile up in history.
# Mirrors the in-app publisher (publishSnapshotBranch in js/core/github.js).
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

current_tree="$(git ls-remote --exit-code origin "refs/heads/$FEED_BRANCH" >/dev/null 2>&1 \
  && git fetch -q --depth=1 origin "$FEED_BRANCH" && git rev-parse FETCH_HEAD^{tree} || true)"
if [ "$tree" = "$current_tree" ]; then
  echo "Feeds unchanged — not republishing."
  exit 0
fi

commit="$(git commit-tree "$tree" -m "Publish daily-rate feeds")"
git push --force origin "$commit:refs/heads/$FEED_BRANCH"
echo "Published $FEED_DIR to $FEED_BRANCH ($commit)"
