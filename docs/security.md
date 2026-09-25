# Security notes: privacy guard, CI and what the history keeps

This repository is public. The app encrypts everything it stores (see the
README's *Encryption* and *Security model and limits*). This page covers the
checks that keep plaintext out of the repository, and their limits.

## The privacy guard

`.github/scripts/privacy-guard.py` inspects file versions and commit messages
and fails when something must not be public. It prints only commit, path and a
reason — never contents, because Actions logs of a public repository are public.

What it checks:

| Where | Rule |
|---|---|
| `data/db.json`, `backups/`, `debug/` | Exactly the app's JSON envelope `{enc:1, iv, ct[, kid][, v, z]}`: no other fields, `iv` = base64 of 12 bytes, `ct` = base64 of ≥ 16 bytes that is statistically random (not readable text, enough distinct byte values, entropy). Scheduled backups may wrap the envelope in `{exportVersion, schemaVersion, exportedAt, source, snapshotName, data}` and nothing else. |
| `invoices/`, document folders, anything else that isn't source | A `BTX1` container (magic + 12-byte IV + ciphertext ≥ 16 bytes, random-looking) or the JSON envelope above. Invoice PDFs must also have an encrypted file name. |
| `data/github-config.json` | Plain JSON with only `owner`, `repo`, `branch`, `path` (short strings). |
| `exports/` | Never on main — rate feeds live on the `rates-feed` branch. |
| Source folders | Only their file types: `js/` `.js`/`.mjs`, `css/` `.css`, `docs/` `.md`/`.txt`/`.svg`, `assets/fonts/` fonts, `assets/` icons (≤ 512 KB, no screenshot-like names), `scripts/`, `.github/`, `.githooks/` code. A `.csv`, `.json`, `.pdf` or spreadsheet there fails. |
| Source files, commit messages, plain-JSON branches | No secrets: GitHub/AWS/Slack/Google/Stripe/npm/AI tokens, private keys, JWKs with key material, raw base64 AES keys, literal `Authorization` headers, password hashes/salts, private calendar links (Airbnb, Booking.com, Vrbo, Google and other `.ics?…token` shapes). |
| `rates-feed` branch | Only `exports/daily-rates/*.json`, in the schema of [daily-rate-feed](daily-rates-feed.md): no amounts on unavailable nights or on hidden-price properties, no calendar link, no extra fields. |
| `presence` branch | Only `data/presence.json`, `data/session-history.json`, `data/session-signal.json`, with no secrets and no token/key/password/URL fields. |

Modes:

```bash
python3 .github/scripts/privacy-guard.py <before> <after> [--branch NAME]  # a push / PR range
python3 .github/scripts/privacy-guard.py --all        # every commit of every local branch and tag
python3 .github/scripts/privacy-guard.py --tree HEAD  # one tree
python3 .github/scripts/privacy-guard.py --staged     # the index (pre-commit hook)
```

There is no commit limit: every commit in the range is checked.

### When it runs

- **Before a commit / push (recommended):** `git config core.hooksPath .githooks`
  enables `.githooks/pre-commit` (staged files) and `.githooks/pre-push` (every
  commit about to be pushed). This is the only check that runs *before* data
  becomes public. The app's own saves go through the GitHub API and are guarded
  in the app itself (`uploadGithubFile` refuses anything unencrypted).
- **On every push** (`privacy-guard.yml`, job `push`): checks the pushed commits.
  This runs after the push — a failure means the data is already public.
- **On every pull request** (job `pull-request`): the guard is taken from the
  **base** branch, so a PR can't weaken the check that judges it. A PR that
  legitimately extends the guard's rules therefore fails until it is merged by
  a maintainer who has reviewed it.
- **Daily** (job `all-branches`, also runnable by hand): `--all` over the full
  history of every branch, including `presence` and `rates-feed`, which have no
  workflow files and are never checked on push.

### Known historic findings

History can't be changed after the fact without a rewrite. Findings that were
reviewed and can't (or needn't) be removed are listed by blob or commit SHA in
`.github/privacy-guard-known.txt`; only the daily `--all` scan honours that file.
Never list a real leak there instead of removing it.

### Limits

- A push or PR can edit the workflow itself. Only branch rules (below) prevent that.
- Statistical checks can't tell ciphertext from other random-looking data, such
  as a compressed or already-encrypted file from elsewhere.
- Deliberately obfuscated secrets won't match any pattern. For broader coverage,
  enable GitHub secret scanning and push protection (below).

## If something leaked

1. Stop pushing. Rewrite the history to remove it (`git filter-repo`), force-push
   every affected branch, and rotate whatever leaked (PAT, encryption key,
   calendar links).
2. Rewritten or force-pushed commits are **not gone yet**: they stay reachable by
   SHA on GitHub until it garbage-collects them, and their SHAs appear in the
   public Events API and in Actions logs. Pull-request refs (`refs/pull/*`) are
   permanent. Forks and clones keep their copies.
3. Ask GitHub Support to purge the removed SHAs and cached views
   (<https://support.github.com> → "Remove sensitive data").

The same applies to replaced `rates-feed` commits and to the old
`exports/daily-rates/` files that used to be committed to `main`: early feeds
published real payouts per booked night. If those are still reachable in
`main`'s history, request a purge from GitHub Support.

## CI hardening in place

- Actions are pinned to full commit SHAs (Dependabot keeps them current:
  `.github/dependabot.yml`). Every workflow declares minimal `permissions`.
- Workflow values (`secrets.*`, event fields) reach scripts through `env:`,
  never expanded inside `run:` or script source.
- Writers of the `rates-feed` branch use `--force-with-lease` and share the
  `rates-feed` concurrency group.
- The daily backup reads `data/db.json` by blob SHA at an exact commit (not via
  the raw CDN, which can lag), checks the SHA-1 of what it got, validates the
  envelope strictly and never stores plaintext. It keeps the newest backup of
  each of the last 14 days, 8 ISO weeks and 8 months (≤ ~28 files, below the
  app's own 30-file trim).
- The plaintext-era iCal refresh workflow and script were removed; the app
  refreshes iCal blocks itself.
- Front-end libraries are pinned to exact versions with SRI; the pdf.js and
  Tesseract worker scripts are fetched with an integrity check and started from
  a `blob:` URL (`js/core/libs.js`); pdf.js runs with `isEvalSupported: false`
  (CVE-2024-4367). The Tesseract core and language data are pinned by version
  but can't be integrity-checked (the worker loads them itself).

## Not done yet

- **Cache-busting of ES modules.** `js/bootstrap.js` stamps only `app.js` with a
  fresh `?v=`; the modules it imports use fixed or no version strings, so for up
  to GitHub Pages' cache lifetime (~10 min) after a deploy a browser may run a new
  `app.js` against older cached modules. The robust fix is an import map
  (`<script type="importmap">`) with one build version for every module, but an
  inline import map needs its hash in the page's Content-Security-Policy, and
  keeping that hash and version in sync needs a small build/deploy step. The
  `http-equiv` cache meta tags in `index.html` only affect the page itself, not
  its scripts.

## Repository settings to apply by hand

These can't be set from the repository's files:

1. **Branch ruleset on `main`**: require a pull request with one approval and a
   passing `Privacy guard / pull-request` check; block force-pushes and deletion.
   (If the app's direct saves to `main` must keep working, add the app's token
   owner as a bypass actor, or at least protect `.github/**`.)
2. **CODEOWNERS for `.github/**`** (+ "Require review from Code Owners" in the
   ruleset), so the guard and workflows can't be changed without review.
3. **Rulesets for `presence` and `rates-feed`**: restrict who can push; allow
   force-pushes on `rates-feed` only (it is replaced on every publish).
4. **Secret scanning + push protection** (Settings → Code security): blocks
   known token formats at push time, before they become public.
5. **Actions settings**: "Require approval for all outside collaborators" for
   fork PR workflows; default `GITHUB_TOKEN` permissions = read-only; allow only
   GitHub-owned and SHA-pinned actions.
6. **Tokens**: the app PAT fine-grained, this repository only, Contents
   read/write, with an expiry; `STR_DEPLOY_TOKEN` limited to the
   Short-Term-Rentals repository.
7. **Dependabot**: enable Dependabot version updates / alerts so the pinned
   action SHAs are kept current.
