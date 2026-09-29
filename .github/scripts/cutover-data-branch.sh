#!/usr/bin/env bash
# Move the app's data from `main` to its own `data` branch - or back.
# See docs/data-branch.md for the why, the checklist around this script and
# what devices do during and after the move. Run it by hand, from a clone
# with push rights (and permission to push workflow files), AFTER every
# device/tab running the app has been closed.
#
#   .github/scripts/cutover-data-branch.sh --dry-run      # show what it would do
#   .github/scripts/cutover-data-branch.sh                # do it
#   .github/scripts/cutover-data-branch.sh --rollback --dry-run
#   .github/scripts/cutover-data-branch.sh --rollback
#
# Options: --remote NAME (default origin).
#
# Cutover, in ONE atomic push (both refs update, or neither does):
#   data  <- new parentless commit: main's data files (data/db.json, backups/,
#            invoices/, Properties/, Clients/, expenses/, debug/) byte-for-byte
#            (same blobs), plus the three privacy-guard files. Refused if the
#            branch already exists.
#   main  <- child of the main tip that was read: those data files deleted,
#            data/github-config.json "branch" set to "data" (nothing else
#            changed). Refused if main moved since it was read.
# Rollback, also atomic:
#   main  <- data files restored from the data branch, config branch "main".
#   data  <- deleted (only if it still points at the commit that was read).
#
# Nothing here decrypts anything: files are moved as git blobs. The privacy
# guard checks both new trees before anything is pushed.
set -euo pipefail

REMOTE="origin"
DRY_RUN=0
ROLLBACK=0
MAIN="main"
DATA_BRANCH="data"
CONFIG="data/github-config.json"
DB_PATH="data/db.json"
# Everything the app stores through state.github.branch (js/: the db.json
# push, uploadGithubFile/deleteGithubFile paths): db.json, the in-app and
# scheduled backups, invoice PDFs (+ invoices/backup), property and client
# documents (+ their backup/ folders), expense receipts, debug exports.
DATA_PATHS=("$DB_PATH" backups invoices Properties Clients expenses debug)
GUARD_FILES=(.github/workflows/privacy-guard.yml .github/scripts/privacy-guard.py .github/privacy-guard-known.txt)
# Top-level entries of main that are code (anything else unknown = stop).
CODE_ENTRIES=" .githooks .github assets css docs js scripts .gitignore .nojekyll CLAUDE.md README.md index.html CNAME LICENSE robots.txt data "

die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
run()  { if [ "$DRY_RUN" = 1 ]; then echo "[dry-run] would run: $*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1 ;;
    --rollback) ROLLBACK=1 ;;
    --remote)   shift; REMOTE="${1:?--remote needs a name}" ;;
    -h|--help)  sed -n '2,31p' "$0"; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

command -v python3 >/dev/null || die "python3 is required"
top="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
cd "$top"

# ── (a) clean state, fresh refs ─────────────────────────────────────────────
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the working tree has uncommitted changes - commit or stash them first"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "no remote named $REMOTE"
info "Fetching $MAIN (and $DATA_BRANCH, if it exists) from $REMOTE"
git fetch -q --no-tags "$REMOTE" "+refs/heads/$MAIN:refs/remotes/$REMOTE/$MAIN"
main_tip="$(git rev-parse "refs/remotes/$REMOTE/$MAIN^{commit}")"
data_tip=""
if git ls-remote --exit-code "$REMOTE" "refs/heads/$DATA_BRANCH" >/dev/null 2>&1; then
  git fetch -q --no-tags "$REMOTE" "+refs/heads/$DATA_BRANCH:refs/remotes/$REMOTE/$DATA_BRANCH"
  data_tip="$(git rev-parse "refs/remotes/$REMOTE/$DATA_BRANCH^{commit}")"
fi
info "$MAIN is at $main_tip${data_tip:+, $DATA_BRANCH is at $data_tip}"

# The guard used for the checks below is main's CURRENT one.
guard_tmp="$(mktemp -d)"
tmp_index="$(mktemp)"
trap 'rm -rf "$guard_tmp" "$tmp_index"' EXIT
git show "$main_tip:.github/scripts/privacy-guard.py" > "$guard_tmp/privacy-guard.py" || die "main has no privacy guard"
git show "$main_tip:.github/scripts/data-location.py" > "$guard_tmp/data-location.py" \
  || die "main has no .github/scripts/data-location.py - ship the data-branch preparation first"

# The config on main: which repo, and where the data is now.
git show "$main_tip:$CONFIG" > "$guard_tmp/config.json" 2>/dev/null || die "main has no $CONFIG"
cfg_repo="$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); print(str(c.get("owner", "")) + "/" + str(c.get("repo", "")))' "$guard_tmp/config.json")"
loc="$(python3 "$guard_tmp/data-location.py" "$guard_tmp/config.json" --strict)" || die "$CONFIG on main is malformed"
cur_branch="$(printf '%s\n' "$loc" | sed -n 's/^branch=//p')"
cur_path="$(printf '%s\n' "$loc" | sed -n 's/^path=//p')"
[ "$cur_path" = "$DB_PATH" ] || die "$CONFIG names path '$cur_path'; this script only handles $DB_PATH"
remote_url="$(git remote get-url "$REMOTE")"
case "$(printf '%s' "$remote_url" | tr 'A-Z' 'a-z')" in
  *"$(printf '%s' "$cfg_repo" | tr 'A-Z' 'a-z')"*) ;;
  *) die "$CONFIG names $cfg_repo, but $REMOTE is $remote_url" ;;
esac

# Writes a copy of main's config with only "branch" changed; prints its blob.
config_blob_with_branch() {
  python3 - "$guard_tmp/config.json" "$1" > "$guard_tmp/config.new.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
cfg["branch"] = sys.argv[2]
# Same formatting as the app (JSON.stringify(cfg, null, 2), no trailing newline).
sys.stdout.write(json.dumps(cfg, indent=2))
PY
  git hash-object -w -- "$guard_tmp/config.new.json"
}

# Lists "mode type sha<TAB>path" of the data files present in a commit.
data_listing() { git ls-tree -r "$1" -- "${DATA_PATHS[@]}"; }

guard_check() { # <commit> <branch policy>
  info "Privacy guard: tree of $1 under the '$2' rules"
  python3 "$guard_tmp/privacy-guard.py" --tree "$1" --branch "$2"
}

commit_msg_trailer="Run by .github/scripts/cutover-data-branch.sh - see docs/data-branch.md."

if [ "$ROLLBACK" = 0 ]; then
  # ── Cutover preconditions ─────────────────────────────────────────────────
  [ -z "$data_tip" ] || die "$REMOTE already has a '$DATA_BRANCH' branch - refusing (rollback first, or delete it by hand if it is a leftover)"
  [ "$cur_branch" = "$MAIN" ] || die "$CONFIG already says the data lives on '$cur_branch'"
  git cat-file -e "$main_tip:$DB_PATH" 2>/dev/null || die "$MAIN has no $DB_PATH"
  git show "$main_tip:js/core/github.js" > "$guard_tmp/github.js"
  grep -q 'followBootstrapMove' "$guard_tmp/github.js" \
    || die "$MAIN's app code can't follow a data move yet - deploy the data-branch preparation and reload every device first"
  for f in "${GUARD_FILES[@]}"; do git cat-file -e "$main_tip:$f" 2>/dev/null || die "$MAIN has no $f"; done
  # Every top-level entry must be known code or known data - an unknown one
  # could be data this script would leave behind.
  while IFS= read -r entry; do
    case " ${DATA_PATHS[*]} " in *" $entry "*) continue ;; esac
    case "$CODE_ENTRIES" in *" $entry "*) continue ;; esac
    die "unknown top-level entry '$entry' on $MAIN - add it to DATA_PATHS or CODE_ENTRIES in this script first"
  done < <(git ls-tree --name-only "$main_tip")
  while IFS= read -r f; do
    case "$f" in "$DB_PATH"|"$CONFIG") ;; *) die "unexpected file '$f' under data/ on $MAIN - decide where it belongs first" ;; esac
  done < <(git ls-tree -r --name-only "$main_tip" -- data)

  # ── (b) the data branch commit ────────────────────────────────────────────
  export GIT_INDEX_FILE="$tmp_index"
  git read-tree --empty
  data_listing "$main_tip" | git update-index --index-info
  git ls-tree "$main_tip" -- "${GUARD_FILES[@]}" | git update-index --index-info
  data_tree="$(git write-tree)"
  unset GIT_INDEX_FILE
  data_commit="$(git commit-tree "$data_tree" -m "Data: moved from $MAIN at ${main_tip:0:12}" -m "$commit_msg_trailer")"

  # ── (d) the main commit ───────────────────────────────────────────────────
  export GIT_INDEX_FILE="$tmp_index"
  git read-tree "$main_tip"
  git rm -r -q --cached --ignore-unmatch -- "${DATA_PATHS[@]}"
  cfg_blob="$(config_blob_with_branch "$DATA_BRANCH")"
  git update-index --cacheinfo "100644,$cfg_blob,$CONFIG"
  main_tree="$(git write-tree)"
  unset GIT_INDEX_FILE
  main_commit="$(git commit-tree "$main_tree" -p "$main_tip" \
    -m "Move app data to the '$DATA_BRANCH' branch" \
    -m "data/github-config.json now names '$DATA_BRANCH'; db.json and attachments were copied there unchanged (commit ${data_commit:0:12}) and removed here." \
    -m "$commit_msg_trailer")"

  # ── Verify before pushing ─────────────────────────────────────────────────
  [ "$(data_listing "$main_tip")" = "$(data_listing "$data_commit")" ] || die "data file listing differs between $MAIN and the new data commit"
  [ "$(git rev-parse "$main_tip:$DB_PATH")" = "$(git rev-parse "$data_commit:$DB_PATH")" ] || die "db.json blob differs"
  [ -z "$(data_listing "$main_commit")" ] || die "the new $MAIN commit still has data files"
  [ -z "$(git ls-tree -r --name-only "$data_commit" | grep -Ev "^($(IFS='|'; echo "${DATA_PATHS[*]}" | sed 's/\./\\./g'))(/|$)|^\.github/" || true)" ] \
    || die "the new data commit holds something other than data + guard files"
  new_loc="$(python3 "$guard_tmp/data-location.py" "$guard_tmp/config.new.json" --strict)"
  printf '%s\n' "$new_loc" | grep -qx "branch=$DATA_BRANCH" || die "the new config doesn't parse as branch=$DATA_BRANCH"
  diff <(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); c.pop("branch",None); print(json.dumps(c,sort_keys=True))' "$guard_tmp/config.json") \
       <(python3 -c 'import json,sys; c=json.load(open(sys.argv[1])); c.pop("branch",None); print(json.dumps(c,sort_keys=True))' "$guard_tmp/config.new.json") >/dev/null \
    || die "the new config changes more than 'branch'"
  guard_check "$data_commit" "$DATA_BRANCH"
  guard_check "$main_commit" "$MAIN"

  n_files="$(data_listing "$main_tip" | wc -l | tr -d ' ')"
  info "Plan:"
  echo "   $DATA_BRANCH: create at $data_commit ($n_files data file(s) + ${#GUARD_FILES[@]} guard files, no parent)"
  echo "   $MAIN: $main_tip -> $main_commit (removes those $n_files file(s); $CONFIG branch: $MAIN -> $DATA_BRANCH)"
  data_listing "$main_tip" | awk -F'\t' '{split($2,p,"/"); top=(p[1]=="data")?$2:p[1]; c[top]++} END {for (k in c) printf "     %-22s %d file(s)\n", k, c[k]}' | sort
  echo "   $CONFIG after:"; sed 's/^/     /' "$guard_tmp/config.new.json"

  # ── (c)+(d) one atomic push ───────────────────────────────────────────────
  run git push --atomic \
    --force-with-lease="refs/heads/$DATA_BRANCH:" \
    --force-with-lease="refs/heads/$MAIN:$main_tip" \
    "$REMOTE" "$data_commit:refs/heads/$DATA_BRANCH" "$main_commit:refs/heads/$MAIN"

  # ── (e) what to check next ────────────────────────────────────────────────
  owner="${cfg_repo%%/*}"; repo="${cfg_repo#*/}"
  pages_url="https://$(printf '%s' "$owner" | tr 'A-Z' 'a-z').github.io/$repo/$CONFIG"
  cat <<EOF

Next steps$( [ "$DRY_RUN" = 1 ] && echo " (after the real run)"):
 1. Wait for "Deploy app to GitHub Pages" on $MAIN to finish, then check the
    live bootstrap config says "$DATA_BRANCH":
      curl -s "$pages_url"
 2. Open the app on ONE device and reload. It reads $MAIN, gets a 404, follows
    the bootstrap config to '$DATA_BRANCH' and loads normally. Settings ->
    GitHub Storage shows branch "$DATA_BRANCH".
 3. Make a small edit; confirm the commit lands on '$DATA_BRANCH' and not $MAIN:
      git fetch $REMOTE && git log --oneline -3 $REMOTE/$DATA_BRANCH
      git ls-tree $REMOTE/$MAIN -- $DB_PATH    # must print nothing
    and that the "Privacy guard" workflow ran (green) for that push.
 4. Actions -> "Daily Database Backup" -> Run workflow: it must log
    "Data branch: $DATA_BRANCH" and write backups/ on '$DATA_BRANCH'.
 5. Actions -> "Privacy guard" -> Run workflow (full scan of every branch).
 6. Then open the other devices, one at a time.
 Rollback: .github/scripts/cutover-data-branch.sh --rollback --dry-run
EOF
else
  # ── Rollback ──────────────────────────────────────────────────────────────
  [ -n "$data_tip" ] || die "$REMOTE has no '$DATA_BRANCH' branch - nothing to roll back"
  [ "$cur_branch" = "$DATA_BRANCH" ] || die "$CONFIG says the data lives on '$cur_branch', not '$DATA_BRANCH'"
  git cat-file -e "$data_tip:$DB_PATH" 2>/dev/null || die "'$DATA_BRANCH' has no $DB_PATH - refusing"
  [ -z "$(data_listing "$main_tip")" ] || die "$MAIN already has data files again - sort that out by hand first"

  export GIT_INDEX_FILE="$tmp_index"
  git read-tree "$main_tip"
  data_listing "$data_tip" | git update-index --index-info
  cfg_blob="$(config_blob_with_branch "$MAIN")"
  git update-index --cacheinfo "100644,$cfg_blob,$CONFIG"
  main_tree="$(git write-tree)"
  unset GIT_INDEX_FILE
  main_commit="$(git commit-tree "$main_tree" -p "$main_tip" \
    -m "Move app data back to $MAIN" \
    -m "Restored db.json and attachments from '$DATA_BRANCH' at ${data_tip:0:12} (unchanged blobs); data/github-config.json names $MAIN again." \
    -m "$commit_msg_trailer")"

  [ "$(data_listing "$data_tip")" = "$(data_listing "$main_commit")" ] || die "restored data listing differs from '$DATA_BRANCH'"
  guard_check "$main_commit" "$MAIN"

  info "Plan:"
  echo "   $MAIN: $main_tip -> $main_commit (restores $(data_listing "$data_tip" | wc -l | tr -d ' ') data file(s); $CONFIG branch -> $MAIN)"
  echo "   $DATA_BRANCH: delete (was $data_tip) - its files are all in the new $MAIN commit"
  run git push --atomic \
    --force-with-lease="refs/heads/$MAIN:$main_tip" \
    --force-with-lease="refs/heads/$DATA_BRANCH:$data_tip" \
    "$REMOTE" "$main_commit:refs/heads/$MAIN" ":refs/heads/$DATA_BRANCH"
  cat <<EOF

Next steps: wait for the Pages deploy, open ONE device and reload (it gets a
404 on '$DATA_BRANCH', follows the bootstrap config back to $MAIN), make an
edit, confirm it lands on $MAIN, then open the other devices.
EOF
fi
