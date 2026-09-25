#!/usr/bin/env python3
"""Privacy guard: fail if a pushed commit adds data that must not be public.

This repository is public. Everything except the app's source code must be
encrypted by the app before it is committed (db.json, backups, invoices,
documents, debug exports). This check looks at every file added or changed by
the pushed commits and fails the run (which emails the pusher) when it finds:

  - an unencrypted data file (anything outside the source-code paths below
    that isn't one of the app's encrypted formats);
  - rate feeds on this branch (they belong on the single-commit rates-feed
    branch, see docs/daily-rates-feed.md);
  - secrets or password hashes inside source-code files.

It never prints file contents - only paths and reasons - because Actions logs
of a public repository are public too.

Usage: privacy-guard.py <before-sha> <after-sha>   (push)
       privacy-guard.py --all                      (audit the whole HEAD tree)
"""
import json
import re
import subprocess
import sys

# Paths that hold source code and may be committed as plain text.
PLAINTEXT_OK = re.compile(
    r"^(js|css|assets|\.github|\.claude|docs|scripts)/"
    r"|^(index\.html|README\.md|CLAUDE\.md|\.gitignore)$"
)
# The bootstrap config is plain JSON but may only hold these keys.
BOOTSTRAP_CONFIG = "data/github-config.json"
BOOTSTRAP_KEYS = {"owner", "repo", "branch", "path"}
# Never on this branch: the public rate feeds live on the rates-feed branch.
FORBIDDEN = re.compile(r"^exports/")

SECRET_PATTERNS = {
    "a GitHub token": re.compile(rb"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}"),
    "an AWS access key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "a private key": re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "a password hash": re.compile(rb"\"passwordHash\"\s*:\s*\"[0-9a-f]{32,}\""),
    "an Airbnb calendar link with its access token": re.compile(rb"airbnb\.[a-z.]+/calendar/ical/\d+\.ics\?[^\s\"']*\bs=[0-9a-f]{16,}"),
}
ZERO_SHA = re.compile(r"^0+$")


def git(*args, binary=False):
    out = subprocess.run(["git", *args], capture_output=True, check=True).stdout
    return out if binary else out.decode()


def is_envelope(obj):
    return isinstance(obj, dict) and obj.get("enc") == 1 \
        and isinstance(obj.get("iv"), str) and isinstance(obj.get("ct"), str)


def check_file(path, data):
    """Return a reason string if this file must not be public, else None."""
    if FORBIDDEN.search(path):
        return "rate feeds must be published to the rates-feed branch, never committed here"
    if path == BOOTSTRAP_CONFIG:
        try:
            cfg = json.loads(data)
        except ValueError:
            return "bootstrap config is not valid JSON"
        extra = set(cfg) - BOOTSTRAP_KEYS if isinstance(cfg, dict) else {"(not an object)"}
        return f"bootstrap config may only hold {sorted(BOOTSTRAP_KEYS)}, found {sorted(extra)}" if extra else None
    if PLAINTEXT_OK.search(path):
        for name, rx in SECRET_PATTERNS.items():
            if rx.search(data):
                return f"contains what looks like {name}"
        return None
    # Everything else is data and must be in one of the app's encrypted formats.
    if data[:4] == b"BTX1":
        return None  # encryptBytes container (documents, invoices, file names)
    try:
        obj = json.loads(data)
    except ValueError:
        return "unencrypted data file (not an encrypted container or envelope)"
    if is_envelope(obj):
        return None  # encryptJsonToEnvelope (db.json, manual backups, debug exports)
    if isinstance(obj, dict) and is_envelope(obj.get("data")):
        return None  # scheduled backup: metadata wrapper around an encrypted envelope
    return "unencrypted JSON data (not an encrypted envelope)"


def changed_files(commit):
    """Files added/modified/renamed by one commit (against its first parent)."""
    parents = git("rev-list", "--parents", "-n", "1", commit).split()[1:]
    if parents:
        out = git("diff-tree", "-r", "--no-commit-id", "--name-only", "--diff-filter=AMRC", parents[0], commit)
    else:
        out = git("ls-tree", "-r", "--name-only", commit)
    return [p for p in out.splitlines() if p]


def commits_to_check(before, after):
    if before and not ZERO_SHA.match(before):
        try:
            return git("rev-list", "--max-count=200", f"{before}..{after}").split()
        except subprocess.CalledProcessError:
            pass  # before is unknown here (e.g. after a force-push): fall through
    # New branch or force-push: commits not reachable from any other branch.
    others = [r for r in git("for-each-ref", "--format=%(refname)", "refs/remotes/origin").split()
              if git("rev-parse", r).strip() != git("rev-parse", after).strip()]
    return git("rev-list", "--max-count=200", after, "--not", *others).split() if others \
        else git("rev-list", "--max-count=200", after).split()


def main():
    if sys.argv[1:] == ["--all"]:
        targets = [("HEAD", p) for p in git("ls-tree", "-r", "--name-only", "HEAD").splitlines()]
    elif len(sys.argv) == 3:
        targets = []
        for c in commits_to_check(sys.argv[1], sys.argv[2]):
            targets += [(c, p) for p in changed_files(c)]
    else:
        sys.exit(__doc__)

    problems, seen = [], set()
    for commit, path in targets:
        blob = git("rev-parse", f"{commit}:{path}").strip()
        if blob in seen:
            continue
        seen.add(blob)
        if git("cat-file", "-t", blob).strip() != "blob":
            continue
        reason = check_file(path, git("cat-file", "blob", blob, binary=True))
        if reason:
            problems.append(f"{commit[:12]}  {path}: {reason}")

    print(f"Checked {len(seen)} file version(s).")
    if problems:
        print("\nPRIVACY GUARD FAILED - these files must not be public:")
        for p in problems:
            print("  " + p)
        print("\nRemove them from the history (git filter-repo) before anything else is pushed;"
              " see docs/daily-rates-feed.md and CLAUDE.md.")
        sys.exit(1)
    print("OK - nothing unencrypted or secret found.")


if __name__ == "__main__":
    main()
