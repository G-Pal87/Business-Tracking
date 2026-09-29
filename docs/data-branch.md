# Moving the data to a `data` branch

**Status: prepared, not done.** The code below ships dormant. While
`data/github-config.json` on `main` says `"branch": "main"`, the app and every
workflow behave exactly as before. The move itself is a one-off, manual step
(`.github/scripts/cutover-data-branch.sh`), run by the maintainer when every
device is closed.

## What and why

The app keeps all its data in this repository: `data/db.json` (one AES-GCM
envelope holding the whole database) plus encrypted attachments. Today they
all sit on `main`, next to the code.

Every save commits a new `db.json`. It is ciphertext, so git can't
delta-compress one version against the last: each save adds about **160 KB**
to the history for good. `main`'s history is already about **631 MB**, almost
all of it old `db.json` versions. Every clone, every workflow checkout with
history (the privacy guard) and every Pages deploy that fetches `main` pays
for that, and it keeps growing with every save.

After the move:

| Branch       | Holds                                                                                                                                             | History                                                  |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------|
| `main`       | code, docs, workflows, `data/github-config.json` (`"branch": "data"`)                                                                             | code commits only                                        |
| `data`       | `data/db.json`, `backups/`, `invoices/`, `Properties/`, `Clients/`, `expenses/`, `debug/`, plus the three privacy-guard files (see [Privacy](#privacy-on-the-data-branch)) | squashed to one commit every week (`squash-data.yml`)    |
| `presence`   | unchanged (who's online)                                                                                                                          | squashed weekly (`squash-presence.yml`)                  |
| `rates-feed` | unchanged (public daily-rate feeds)                                                                                                               | one commit, replaced on every publish                    |

`main`'s existing history isn't rewritten. It stops growing.

## How devices find the data

The app reads and writes everything through `state.github.branch`/`dbPath`
(`js/core/github.js`). A device learns the branch from its own localStorage
settings, from `db.appConfig.github` inside the database (`applyDbConfig`), or
from the Pages-hosted bootstrap config `data/github-config.json` on a brand-new
device (`app.js` Phase 1.5). After the move, the first two still say `main`.
Three things carry devices over:

1. **The 404 follow (`fetchDb` → `followBootstrapMove`).** When `db.json`
   answers **404**, and only then, the app fetches `data/github-config.json`
   from the Pages site again (no-store). It switches only if all of these hold:
   - the config names the **same owner/repo** (it never switches repositories);
   - it names a different, well-formed branch and/or path;
   - the device still points where the 404 came from;
   - no switch has happened yet in this page session (at most one, so it can't
     ping-pong).

   If so, the app saves the new location (`writeCfg`) and retries the read
   once, inside the same `fetchDb` call. The caller then gets the data as if
   nothing had happened. So every read path (boot phases 2 and 4, the 60s
   background sync, sign-in retries, Settings) merges it and applies
   pending-edit journals exactly as usual. A 401, 403, 5xx or network error
   never triggers any of this. A push whose GET hits the 404 follows the same
   way and then fails. `doSave`'s automatic retry, seconds later, pushes to the
   new branch with a normal GET + 3-way merge.
2. **The pin.** A location adopted this way is stored as `pin` in the
   localStorage settings. While the device sits at its pinned location,
   `applyDbConfig` leaves branch/path alone, so the database's stale
   `appConfig.github.branch: "main"` can't switch it back after every load.
   A brand-new device that gets a non-default location from the bootstrap
   config (Phase 1.5, `adoptBootstrapConfig`) is pinned too. An explicit
   choice clears the pin: Settings → Save & Pull, a setup link, or Disconnect.
3. **The database catches up.** The next push from a pinned device writes the
   pinned branch/path into `appConfig.github` (copy-on-write, same repo only).
   From then on the database itself says `data`, and pins are only a
   belt-and-braces measure.

Settings → Save & Pull records where the data was actually read from. If you
type `main` after the move, the read follows the bootstrap config to `data`,
and `data` is what gets saved to `appConfig` and to the bootstrap config. The
bootstrap config is always written to the **Pages branch** (`main`,
`PAGES_BRANCH` in `settings.js`, through `uploadGithubFile`'s `branch`
override). It is never written to the data branch, which Pages never serves.
The plaintext allow-list (`PLAINTEXT_UPLOAD_ALLOWED`) is unchanged.

### Nothing recreates `db.json` on `main`

Every `db.json` write sends the sha of an existing file:

- **Push-first path** (cached sha): the PUT is refused (409/422) once the file
  is gone. The push falls back to the GET path.
- **GET path**: a 404 now throws `db.json not found…` (`code: DB_NOT_FOUND`).
  It never PUTs.
- **If GitHub ever created the file anyway** (a 201 for a PUT that carried a
  sha), the push checks the parent commit. If the parent had no `db.json`, the
  push deletes the file it just created (by its own blob sha, so nothing newer
  can be removed) and fails the same way. A 201 whose parent did have the file
  is treated as a normal update.
- **Attachments**: while the last read found `db.json` missing on a branch,
  uploads and deletes on that branch are refused too. A tab that hasn't
  followed yet can't scatter files onto the old branch.

In every case the edits stay in memory, in the local cache and in the
pending-edits journal, and go out with the next successful push.

Tests: `scripts/tests/data-branch.test.mjs`.

## Workflows

| Workflow                 | Data branch handling                                                                                                                                                                                                                                  |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `backup.yml`             | Reads the branch from `data/github-config.json` on the default branch. It reads `db.json` there, and writes and trims `backups/` there. It fails rather than guessing if the config is malformed.                                                   |
| `export-daily-rates.yml` | Copies `db.json` from the data branch into the checkout before running the script. This step is a no-op while the data is on `main`. The feeds still go to `rates-feed`.                                                                             |
| `notify-str-rebuild.yml` | Reads no data. Unchanged.                                                                                                                                                                                                                             |
| `pages.yml`, `tests.yml` | Run on `main` only. Unchanged. The Pages deploy after the cutover commit publishes the new bootstrap config.                                                                                                                                          |
| `privacy-guard.yml`      | See below.                                                                                                                                                                                                                                            |
| `squash-data.yml`        | New. Every Sunday it replaces `data` with one parentless commit of its current files (same blobs, force-with-lease). It runs only when the config says `data` and the branch exists and holds `db.json`; otherwise it does nothing.                  |

`.github/scripts/data-location.py` is the shared helper that reads the
bootstrap config (the same name rules as the app).

## Privacy on the data branch

A push runs only the workflows in the pushed branch's own tree. That is why
`data` carries `.github/workflows/privacy-guard.yml`,
`.github/scripts/privacy-guard.py` and `.github/privacy-guard-known.txt`: every
app save to `data` is still checked. The guard's `data` policy (`check_data`)
applies the normal rules, so every data file must be one of the app's
encrypted formats. It also rejects app code and docs on that branch. The daily
all-branches scan on `main` covers `data` like every other branch. It also
covers commits made with `GITHUB_TOKEN` (the backup job, the squash), which
trigger no workflows.

`squash-data.yml` refreshes the guard script and the known-findings list from
`main` every week. It runs the guard on the new tree before pushing. It can't
refresh the workflow file: a `GITHUB_TOKEN` may not create or change
`.github/workflows/*`. If `main`'s copy changes, the job logs a warning. You
then have two options:

- Refresh the copy by hand from a clone with push rights:

  ```sh
  git fetch origin data main
  git worktree add /tmp/data-wt origin/data --detach
  git -C /tmp/data-wt checkout origin/main -- .github/workflows/privacy-guard.yml
  git -C /tmp/data-wt commit -m "Refresh privacy guard workflow"
  git -C /tmp/data-wt push origin HEAD:data     # a normal fast-forward push
  git worktree remove /tmp/data-wt
  ```

- Or add a `DATA_SQUASH_TOKEN` secret (a fine-grained PAT for this repository
  only, with Contents and Workflows write access), which the squash job uses
  instead.

If GitHub refuses the squash push because of the workflow file, the job logs
a warning and changes nothing.

## History and recovery

The data branch keeps at most a week of per-save history. Older states come
from `backups/`: 14 daily, 8 weekly and 8 monthly snapshots (`backup.yml`),
plus in-app backups. `main`'s pre-move history also keeps every old
`db.json`.

## Cutover

### Before

1. Merge this preparation to `main` and let the Pages deploy finish.
2. **Reload every device and tab**, so everything open runs code that can
   follow a move. Tabs loaded before that deploy can't follow. They keep
   failing with `db.json not found` / `GitHub fetch failed (404)` until
   reloaded, and their attachment uploads could still land on `main`.
3. Use a clone with push rights that may push workflow files: SSH, `gh auth`,
   or a PAT with the `workflow` scope. The `data` commit contains
   `.github/workflows/privacy-guard.yml`. Enabling the git hooks
   (`git config core.hooksPath .githooks`) makes the pre-push guard check both
   new commits too.

### The move

1. **Close every device and tab running the app.** The app's presence indicator
   (who's online) helps. Settings → GitHub Storage → "Disconnect Other
   Sessions" stops tabs you can't reach from saving. A save during the move can't be lost (see
   below), but it makes the script refuse, and you have to run it again.
2. `.github/scripts/cutover-data-branch.sh --dry-run` shows the plan: file
   counts per folder, the new config, and the exact push. It builds both
   commits locally and runs the privacy guard on them, but pushes nothing.
3. `.github/scripts/cutover-data-branch.sh` does the move:
   - It checks for a clean worktree, fetches `main`, and refuses if `data`
     already exists, if the config doesn't say `main` now, if `main`'s code
     lacks the follow hook, or if there are unknown top-level folders.
   - `data` = a parentless commit with `main`'s data files (identical blobs)
     plus the three guard files.
   - `main` = a child of the tip it read: the data files deleted, and
     `data/github-config.json` with only `"branch"` changed to `"data"`.
   - It verifies the file listings, the `db.json` blob and the guard on both
     trees. Then it makes **one atomic push**:
     `--force-with-lease=refs/heads/data:` (the branch must not exist) and
     `--force-with-lease=refs/heads/main:<tip read>`. Both refs change, or
     neither does. A device that saved to `main` in the meantime makes the
     whole push fail, with nothing changed. Run the script again.
4. Follow the verification steps it prints:
   - The Pages deploy finishes and the live config says `data`.
   - One device reloads, follows the move, and shows `data` in Settings.
   - A test edit lands on `data`, and `main` has no `db.json`.
   - A manual backup run logs "Data branch: data".
   - A manual privacy-guard run passes.
5. Re-open the other devices one at a time. After that,
   `git ls-tree -r origin/main --name-only` should list no data files. If an
   old tab still wrote an attachment there, move it to `data` by hand.

### A tab left open during the move

- **Tab running the new code:** within about 60 seconds, its background read
  gets the 404 and re-reads the bootstrap config.
  - Until the Pages deploy has published the new config (a minute or two, up
    to about 10 minutes with the Pages CDN), the config still says `main`.
    Nothing switches: the tab shows "db.json not found", keeps its edits
    locally and refuses attachment writes.
  - Once the new config is live, the next read or push switches the tab to
    `data`. Pending edits then go out with a normal 3-way merge against what
    is on `data`.
- **Tab running older code:** its push fails with `db.json not found` or
  `GitHub fetch failed (404)`, and the edits stay in its local cache and
  journal. After a reload, which loads the new code, Phase 4 reads `main`,
  gets the 404 and follows to `data`. It merges the local cache and applies
  the journals to the data from `data`, then pushes there.

## Rollback

1. Close every device and tab.
2. `.github/scripts/cutover-data-branch.sh --rollback --dry-run`, then without
   `--dry-run`. In one atomic push, both leased:
   - `main` gets back the data files from `data` (identical blobs), and the
     config says `"main"` again;
   - `data` is deleted. Everything on it is now on `main`.
3. Wait for the Pages deploy. Then open one device. A tab that already
   followed one move in its current session won't follow a second one; it
   needs a reload. It gets a 404 on `data`,
   follows the bootstrap config back to `main` and pins that. Make a test
   edit, check that it lands on `main`, then open the rest.
4. Disable or delete `squash-data.yml` if the move won't be retried. It does
   nothing anyway while the config says `main`.

To move the data again later, run the cutover script again. It works as long
as there is no `data` branch.
