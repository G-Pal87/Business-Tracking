#!/usr/bin/env python3
"""Print where the app's data lives, from the bootstrap config.

The app keeps data/db.json and its encrypted attachments (backups/, invoices/,
Properties/, Clients/, expenses/, debug/) on the branch named by the
`branch` field of data/github-config.json on the Pages branch (main) - `main`
itself until the data is moved to its own branch (docs/data-branch.md).
Workflows that read or write data use this to follow it.

Usage:
  data-location.py CONFIG_FILE [--repo OWNER/REPO] [--strict]

CONFIG_FILE is a checked-out or `git show`n copy of data/github-config.json
("-" reads stdin). Prints, for $GITHUB_OUTPUT:

  branch=<data branch>
  path=<db.json path>
  moved=<true if the branch is not main>

A missing file means the defaults (main, data/db.json). With --repo, a config
naming another repository is ignored (defaults, with a warning). A malformed
config also falls back to the defaults with a warning - or, with --strict,
exits 2 so a caller that must not guess (the squash job) can stop.
"""
import json
import re
import sys

DEFAULT_BRANCH = "main"
DEFAULT_PATH = "data/db.json"
# Same rules as the app (js/core/github.js BRANCH_NAME_RE / DB_PATH_RE).
BRANCH_RE = re.compile(r"^(?!/)(?!.*//)(?!.*\.\.)(?!.*/$)(?!.*\.lock$)[A-Za-z0-9._/-]{1,100}$")
PATH_RE = re.compile(r"^(?!/)(?!.*//)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}\.json$")


def main():
    args = sys.argv[1:]
    strict = "--strict" in args
    if strict:
        args.remove("--strict")
    repo = None
    if "--repo" in args:
        i = args.index("--repo")
        repo = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)

    def fallback(reason):
        print(f"warning: {reason} - using {DEFAULT_BRANCH}:{DEFAULT_PATH}", file=sys.stderr)
        if strict:
            sys.exit(2)
        return DEFAULT_BRANCH, DEFAULT_PATH

    try:
        raw = sys.stdin.read() if args[0] == "-" else open(args[0], encoding="utf-8").read()
    except FileNotFoundError:
        raw = None
    if raw is None or not raw.strip():
        branch, path = DEFAULT_BRANCH, DEFAULT_PATH
    else:
        try:
            cfg = json.loads(raw)
        except ValueError:
            cfg = None
        if not isinstance(cfg, dict):
            branch, path = fallback("bootstrap config is not a JSON object")
        elif repo and f"{cfg.get('owner', '')}/{cfg.get('repo', '')}".lower() != repo.lower():
            branch, path = fallback("bootstrap config names another repository")
        else:
            branch = cfg.get("branch", DEFAULT_BRANCH)
            path = cfg.get("path", DEFAULT_PATH)
            if not (isinstance(branch, str) and BRANCH_RE.match(branch)) or \
               not (isinstance(path, str) and PATH_RE.match(path)):
                branch, path = fallback("bootstrap config has a malformed branch or path")
    print(f"branch={branch}")
    print(f"path={path}")
    print(f"moved={'true' if branch != DEFAULT_BRANCH else 'false'}")


if __name__ == "__main__":
    main()
