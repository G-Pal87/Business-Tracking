#!/usr/bin/env python3
"""Privacy guard: fail if commits add data that must not be public.

This repository is public. Everything except the app's source code must be
encrypted by the app before it is committed (db.json, backups, invoices,
documents, debug exports). The guard looks at every file version added or
changed by the commits it is given, and at their commit messages, and fails
when it finds:

  - an unencrypted data file: anything outside the source-code folders that
    isn't structurally one of the app's encrypted formats (strict checks, see
    check_envelope / check_btx1 below);
  - a file type that doesn't belong in a source folder (a .csv in docs/, a
    screenshot in assets/, ...);
  - rate feeds on the main branch (they belong on the single-commit rates-feed
    branch, see docs/daily-rates-feed.md);
  - secrets (tokens, keys, password hashes, private calendar links) in source
    files, in the plain-JSON branches, or in commit messages.

Branches with their own rules (only relevant to --all and --branch):
  rates-feed  only exports/daily-rates/*.json, in the documented public schema
  presence    only the three presence/session JSON files, with no secrets

It never prints file contents - only commit, path and reason - because Actions
logs of a public repository are public too.

Usage:
  privacy-guard.py <before-sha> <after-sha> [--branch NAME]   push / PR range
  privacy-guard.py --all                     every commit of every local ref
  privacy-guard.py --tree [REV]              the tree of REV (default HEAD)
  privacy-guard.py --staged                  the index (pre-commit hook)

In --all mode, findings whose blob or commit SHA is listed in
.github/privacy-guard-known.txt are reported as acknowledged and don't fail
the run (history can't be changed after the fact; see docs/security.md).
"""
import base64
import binascii
import collections
import json
import math
import os
import re
import subprocess
import sys

# ── Source folders: plain text allowed, but only these file types ─────────────
# (prefix, allowed extensions). First match wins, so list sub-folders first.
# "" as an extension means "no extension" (e.g. git hook files).
SOURCE_RULES = [
    ("assets/fonts/", {".ttf", ".otf", ".woff", ".woff2"}),
    ("assets/vendor/", {".js", ".mjs", ".wasm", ".map", ".css"}),
    ("assets/", {".png", ".svg", ".ico", ".webp", ".jpg", ".jpeg", ".gif"}),
    ("css/", {".css"}),
    ("js/", {".js", ".mjs"}),
    ("docs/", {".md", ".txt", ".svg"}),
    ("scripts/", {".js", ".mjs", ".cjs", ".py", ".sh"}),
    (".github/", {".yml", ".yaml", ".md", ".py", ".js", ".mjs", ".cjs", ".sh", ".txt", ""}),
    (".githooks/", {"", ".sh", ".py"}),
    (".claude/", {".json", ".md", ".sh", ".py", ".js"}),
]
ROOT_SOURCE_FILES = {"index.html", "README.md", "CLAUDE.md", ".gitignore",
                     ".nojekyll", "CNAME", "LICENSE", "robots.txt"}
# An image in assets/ bigger than this is more likely a screenshot than an icon.
MAX_ASSET_IMAGE_BYTES = 512 * 1024
IMAGE_EXTS = {".png", ".webp", ".jpg", ".jpeg", ".gif"}
SCREENSHOT_NAME = re.compile(r"(?i)screen[\s_-]?shot|screen[\s_-]?cap|capture|^img[_-]\d|^photo")

# The bootstrap config is plain JSON but may only hold these keys (strings).
BOOTSTRAP_CONFIG = "data/github-config.json"
BOOTSTRAP_KEYS = {"owner", "repo", "branch", "path"}
# Never on the main line: the public rate feeds live on the rates-feed branch.
FORBIDDEN = re.compile(r"^exports/")
# Invoice PDFs are stored under an encrypted file name (encryptFilename:
# base64url of a BTX1 container) + ".pdf"; the name itself (invoice number,
# client, date) is sensitive.
INVOICE_NAME = re.compile(r"^invoices/(backup/)?([^/]+)\.pdf$")

# ── Secrets ───────────────────────────────────────────────────────────────────
# Each is (description, regex). Applied to source files, plain-JSON branches and
# commit messages - never to encrypted payloads (random base64 would only add
# noise). Patterns deliberately require the high-entropy part to be literal
# ([A-Za-z0-9...]), so template placeholders like `token ${token}` or
# `${{ secrets.X }}` don't match.
B64 = rb"A-Za-z0-9+/"
SECRET_PATTERNS = [
    ("a GitHub token", rb"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}"),
    ("an AWS access key", rb"\b(AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("a private key", rb"-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----"),
    ("a password hash or salt",
     rb"\"(passwordHash|passwordSalt|pwHash|salt)\"\s*:\s*\"([0-9a-f]{32,}|[A-Za-z0-9+/]{22,}={0,2})\""),
    ("a private calendar (iCal) link",
     rb"airbnb\.[a-z.]+/calendar/ical/\d+\.ics\?[^\s\"'<>]*\bs=[0-9a-f]{16,}"
     rb"|\.ics\?[^\s\"'<>]*\b(s|t|k|key|token|secret|hash|sig|signature|auth)=[A-Za-z0-9_\-]{12,}"
     rb"|/ical\.html\?[^\s\"'<>]*\bt=[A-Za-z0-9\-]{16,}"            # Booking.com
     rb"|/icalendar/[0-9a-f]{20,}"                                   # Vrbo / HomeAway
     rb"|/calendar/ical/[^\s\"'<>/]+/private-[0-9a-f]{16,}/"          # Google Calendar
     rb"|/ical/[^\s\"'<>]*\?[^\s\"'<>]*=[A-Za-z0-9_\-]{20,}"),
    ("an Authorization header with a literal credential",
     rb"(?i)authorization[\"']?\s*[:=]\s*[\"'`]?\s*(token|bearer|basic)\s+[A-Za-z0-9._~+/\-]{20,}=*"),
    ("a Slack token or webhook",
     rb"\bxox[abposr]-[A-Za-z0-9-]{10,}|hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{16,}"),
    ("a Google API key or OAuth secret", rb"\bAIza[0-9A-Za-z_\-]{35}\b|\bGOCSPX-[A-Za-z0-9_\-]{20,}|\bya29\.[0-9A-Za-z_\-]{30,}"),
    ("a Stripe key", rb"\b(sk|rk)_(live|test)_[0-9A-Za-z]{16,}|\bwhsec_[A-Za-z0-9]{24,}"),
    ("an npm token", rb"\bnpm_[A-Za-z0-9]{36}\b"),
    ("an AI API key", rb"\bsk-ant-[A-Za-z0-9_\-]{20,}|\bsk-(proj|svcacct)-[A-Za-z0-9_\-]{20,}"),
    # A JSON Web Key carrying key material (symmetric "k" or private "d").
    ("a JSON Web Key (JWK) with key material",
     rb"\"kty\"\s*:\s*\"(oct|RSA|EC|OKP)\"[^{}]{0,2000}\"(k|d)\"\s*:\s*\"[A-Za-z0-9_\-]{16,}"
     rb"|\"(k|d)\"\s*:\s*\"[A-Za-z0-9_\-]{16,}={0,2}\"[^{}]{0,2000}\"kty\"\s*:"),
    # A raw AES key as the app exports it (exportActiveDataKeyBase64: standard
    # base64 of 32 bytes = 43 chars + "="; 16-byte keys = 22 chars + "=="),
    # as a quoted literal. sha256-/sha384- SRI hashes are excluded.
    ("what looks like a raw base64 AES key",
     rb"(?<![A-Za-z0-9+/\-])[\"'`](?!sha(256|384|512)-)([" + B64 + rb"]{43}=|[" + B64 + rb"]{22}==)[\"'`]"),
    ("a credential assigned in source",
     rb"(?i)\b[a-z0-9_]*(secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_]*[\"']?\s*[:=]\s*[\"'`]"
     rb"(?=[A-Za-z0-9+/=_\-]*[0-9])(?=[A-Za-z0-9+/=_\-]*[A-Za-z])[A-Za-z0-9+/=_\-]{32,}[\"'`]"),
]
SECRET_PATTERNS = [(name, re.compile(rx)) for name, rx in SECRET_PATTERNS]
# Assignment rule only makes sense for code, not for base64-ish JSON data.
CODE_ONLY = {"a credential assigned in source", "what looks like a raw base64 AES key"}
BINARY_EXTS = {".ttf", ".otf", ".woff", ".woff2", ".png", ".ico", ".webp", ".jpg", ".jpeg", ".gif", ".wasm"}

# JSON key names that must never appear in the plain-JSON branches.
FORBIDDEN_JSON_KEYS = {"token", "pat", "passwordhash", "passwordsalt", "password", "salt",
                       "datakey", "debugkey", "wrappedkey", "privatekey", "secret",
                       "airbnbcalurl", "icalurl", "calurl", "url"}

ZERO_SHA = re.compile(r"^0+$")
KNOWN_FILE = ".github/privacy-guard-known.txt"


# ── git plumbing ──────────────────────────────────────────────────────────────

def git(*args, binary=False, check=True):
    out = subprocess.run(["git", *args], capture_output=True, check=check).stdout
    return out if binary else out.decode()


class Blobs:
    """One long-lived `git cat-file --batch` for reading objects quickly."""

    def __init__(self):
        self.p = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE)

    def read(self, sha):
        self.p.stdin.write(sha.encode() + b"\n")
        self.p.stdin.flush()
        header = self.p.stdout.readline().split()
        if len(header) < 3 or header[1] == b"missing":
            return None, None
        size = int(header[2])
        data = self.p.stdout.read(size)
        self.p.stdout.read(1)  # trailing newline
        return header[1].decode(), data


def log_changes(revs):
    """Yield (commit, [(path, blob)]) for every commit in `revs` (git log args),
    with the files each one adds/modifies/renames/copies against its first
    parent (root commits: their whole tree)."""
    if not revs:
        return
    out = git("log", "--format=%x00C%H", "--raw", "--no-abbrev", "-z", "-m",
              "--diff-merges=first-parent", "--root", *revs, "--", binary=True)
    toks = out.split(b"\0")
    commit, files, i = None, [], 0
    while i < len(toks):
        t = toks[i].lstrip(b"\n")
        i += 1
        if t.startswith(b"C") and len(t) == 41:
            if commit:
                yield commit, files
            commit, files = t[1:].decode(), []
        elif t.startswith(b":"):
            meta = t.split()
            status, blob = meta[-1][:1], meta[3].decode()
            path = toks[i].decode("utf-8", "surrogateescape")
            i += 1
            if status in (b"R", b"C"):
                path = toks[i].decode("utf-8", "surrogateescape")
                i += 1
            if status in (b"A", b"M", b"R", b"C", b"T") and meta[1] != b"160000":
                files.append((path, blob))
    if commit:
        yield commit, files


# ── format checks ─────────────────────────────────────────────────────────────

def ext_of(path):
    name = path.rsplit("/", 1)[-1]
    return ("." + name.rsplit(".", 1)[1].lower()) if "." in name.lstrip(".") else ""


def b64strict(s, urlsafe=False):
    if not isinstance(s, str) or not s:
        return None
    try:
        if urlsafe:
            if not re.fullmatch(r"[A-Za-z0-9_\-]+", s):
                return None
            return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
        return base64.b64decode(s, validate=True)
    except (binascii.Error, ValueError):
        return None


PRINTABLE = set(range(0x20, 0x7F)) | {9, 10, 13}


def randomness_problem(b):
    """None if `b` is statistically compatible with AES-GCM ciphertext, else a
    reason. Thresholds sit >5 standard deviations from what random bytes give,
    so real ciphertext never trips them; short payloads are only lightly
    checked because there isn't enough data to tell."""
    sample = b[:1 << 20]
    n = len(sample)
    if n >= 64:
        printable = sum(1 for x in sample[:65536] if x in PRINTABLE) / min(n, 65536)
        if printable > 0.7:
            return "payload is mostly readable text, not ciphertext"
    if n >= 256:
        counts = collections.Counter(sample)
        expected = 256 * (1 - (255 / 256) ** n)
        if len(counts) < 0.8 * expected:
            return "payload uses too few distinct byte values for ciphertext"
        if n >= 4096:
            ent = -sum(c / n * math.log2(c / n) for c in counts.values())
            if ent < 7.5:
                return f"payload entropy too low for ciphertext ({ent:.2f} bits/byte)"
    return None


ENVELOPE_KEYS = {"enc", "iv", "ct", "kid", "v", "z"}


def check_envelope(obj):
    """encryptJsonToEnvelope / encryptJsonWithDebugKey output:
    {enc:1, iv, ct[, kid][, v, z:'gzip']} - nothing else."""
    if not isinstance(obj, dict):
        return "not an encrypted envelope"
    if type(obj.get("enc")) is not int or obj.get("enc") != 1:
        return "not an encrypted envelope (enc must be 1)"
    extra = set(obj) - ENVELOPE_KEYS
    if extra:
        return f"encrypted envelope has unexpected field(s) {len(extra)} - only {sorted(ENVELOPE_KEYS)} are allowed"
    iv = b64strict(obj.get("iv"))
    if iv is None or len(iv) != 12:
        return "encrypted envelope has an invalid iv (must be base64 of 12 bytes)"
    ct = b64strict(obj.get("ct"))
    if ct is None or len(ct) < 16:
        return "encrypted envelope has an invalid ct (must be base64 of >= 16 bytes)"
    if "kid" in obj and not (isinstance(obj["kid"], str) and len(obj["kid"]) <= 64
                             and b64strict(obj["kid"]) is not None):
        return "encrypted envelope has an invalid kid"
    if "v" in obj and not (type(obj["v"]) is int and 1 <= obj["v"] <= 16):
        return "encrypted envelope has an invalid v"
    if "z" in obj and obj["z"] != "gzip":
        return "encrypted envelope has an invalid z"
    return randomness_problem(ct)


# Scheduled backup (backup.yml): metadata wrapper around an encrypted envelope.
WRAPPER_FIELDS = {
    "exportVersion": lambda v: type(v) is int,
    "schemaVersion": lambda v: type(v) is int,
    "exportedAt": lambda v: isinstance(v, str) and re.fullmatch(r"[0-9T:.\-+Z]{10,35}", v),
    "source": lambda v: isinstance(v, str) and re.fullmatch(r"[a-z0-9\-]{1,64}", v),
    "snapshotName": lambda v: isinstance(v, str) and re.fullmatch(r"bt-backup-[0-9T\-]{10,20}\.json", v),
}


def check_backup_wrapper(obj):
    extra = set(obj) - set(WRAPPER_FIELDS) - {"data"}
    if extra:
        return f"backup wrapper has {len(extra)} unexpected plain field(s)"
    for k, ok in WRAPPER_FIELDS.items():
        if k in obj and not ok(obj[k]):
            return f"backup wrapper field {k!r} has an unexpected value"
    return check_envelope(obj.get("data"))


def check_btx1(data):
    """encryptBytes output: b"BTX1" + 12-byte IV + AES-GCM ciphertext (>= 16-byte tag)."""
    if len(data) < 4 + 12 + 16:
        return "encrypted container is too short to be valid"
    return randomness_problem(data[16:])


def check_encrypted(path, data):
    """Data files must be one of the app's encrypted formats."""
    if data[:4] == b"BTX1":
        if path == "data/db.json" or path.startswith(("backups/", "debug/")):
            return "expected a JSON envelope here, found a byte container"
        return check_btx1(data)
    try:
        obj = json.loads(data)
    except ValueError:
        return "unencrypted data file (not an encrypted container or envelope)"
    if not isinstance(obj, dict):
        return "unencrypted JSON data (not an encrypted envelope)"
    if "enc" in obj:
        return check_envelope(obj)
    if path.startswith("backups/") and "data" in obj:
        return check_backup_wrapper(obj)
    return "unencrypted JSON data (not an encrypted envelope)"


def find_secret(data, code=True):
    for name, rx in SECRET_PATTERNS:
        if not code and name in CODE_ONLY:
            continue
        if rx.search(data):
            return name
    return None


def json_key_problem(obj, depth=0):
    """Look for forbidden key names anywhere in a JSON document."""
    if depth > 50:
        return "JSON nested too deeply"
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and k.lower() in FORBIDDEN_JSON_KEYS and v not in ("", None, False):
                return f"holds a non-empty {k!r} field"
            r = json_key_problem(v, depth + 1)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = json_key_problem(v, depth + 1)
            if r:
                return r
    return None


def source_rule(path):
    if path in ROOT_SOURCE_FILES:
        return {ext_of(path)}
    for prefix, exts in SOURCE_RULES:
        if path.startswith(prefix):
            return exts
    return None


def check_main(path, data):
    """Rules for main and every other code branch."""
    if FORBIDDEN.search(path):
        return "rate feeds must be published to the rates-feed branch, never committed here"
    if path == BOOTSTRAP_CONFIG:
        try:
            cfg = json.loads(data)
        except ValueError:
            return "bootstrap config is not valid JSON"
        if not isinstance(cfg, dict):
            return "bootstrap config is not a JSON object"
        extra = set(cfg) - BOOTSTRAP_KEYS
        if extra:
            return f"bootstrap config may only hold {sorted(BOOTSTRAP_KEYS)}, found {len(extra)} other field(s)"
        if not all(isinstance(v, str) and len(v) <= 200 for v in cfg.values()):
            return "bootstrap config values must be short strings"
        return find_secret(data, code=False) and "bootstrap config contains what looks like a secret"
    exts = source_rule(path)
    if exts is not None:
        ext = ext_of(path)
        if ext not in exts:
            return (f"file type {ext or '(none)'!r} is not allowed here (allowed: "
                    f"{', '.join(sorted(e or '(none)' for e in exts))}); data files must be encrypted by the app")
        if path.startswith("assets/") and ext in IMAGE_EXTS:
            name = path.rsplit("/", 1)[-1]
            if len(data) > MAX_ASSET_IMAGE_BYTES or SCREENSHOT_NAME.search(name):
                return "image looks like a screenshot or photo, not an app asset"
        if ext in BINARY_EXTS:
            return None
        name = find_secret(data)
        return f"contains what looks like {name}" if name else None
    # Everything else is data and must be in one of the app's encrypted formats.
    m = INVOICE_NAME.match(path)
    if m:
        raw = b64strict(m.group(2), urlsafe=True)
        if raw is None or raw[:4] != b"BTX1" or len(raw) < 32:
            return "invoice PDF stored under a plain (unencrypted) file name"
    return check_encrypted(path, data)


FEED_TOP = {"schema", "generatedAt", "property", "showPrices", "horizonDays", "guestFeePct",
            "taxPct", "cleaningFee", "cleaningGuestTotal", "rates"}
FEED_PROPERTY = {"id", "name", "currency", "airbnbCalUrl"}
FEED_RATE = {"date", "currency", "status", "basis", "originalAmount", "discountPct", "amount", "airbnbCheckout"}
FEED_PRICE_FIELDS = {"basis", "originalAmount", "discountPct", "amount", "airbnbCheckout"}
INDEX_TOP = {"schema", "generatedAt", "properties"}
INDEX_ENTRY = {"id", "name", "currency", "file", "nights", "showPrices"}


def check_rates_feed(path, data):
    """rates-feed branch: only the public feed files, in the documented schema
    (docs/daily-rates-feed.md) - no payouts, no booked/blocked distinction."""
    if not re.fullmatch(r"exports/daily-rates/[A-Za-z0-9_\-]+\.json", path):
        return "only exports/daily-rates/*.json may be on the rates-feed branch"
    try:
        doc = json.loads(data)
    except ValueError:
        return "feed is not valid JSON"
    if not isinstance(doc, dict):
        return "feed is not a JSON object"
    name = find_secret(data, code=False)
    if name:
        return f"contains what looks like {name}"
    if path.endswith("/index.json"):
        if doc.get("schema") != "str-daily-rates-index/v1" or set(doc) - INDEX_TOP:
            return "index.json does not match the documented schema"
        for e in doc.get("properties") or []:
            if not isinstance(e, dict) or set(e) - INDEX_ENTRY:
                return "index.json entry has fields outside the documented schema"
        return None
    if doc.get("schema") != "str-daily-rates/v1" or set(doc) - FEED_TOP:
        return "feed does not match the documented schema (unexpected top-level field)"
    prop = doc.get("property") or {}
    if not isinstance(prop, dict) or set(prop) - FEED_PROPERTY or prop.get("airbnbCalUrl", ""):
        return "feed property block has fields outside the documented schema (or a calendar link)"
    show = doc.get("showPrices") is not False
    if not show and set(doc) & {"guestFeePct", "taxPct", "cleaningFee", "cleaningGuestTotal"}:
        return "feed with showPrices:false carries price fields"
    for r in doc.get("rates") or []:
        if not isinstance(r, dict) or set(r) - FEED_RATE:
            return "feed night has fields outside the documented schema"
        if r.get("status") not in ("open", "unavailable"):
            return "feed night has a status other than open/unavailable"
        if (r.get("status") == "unavailable" or not show) and set(r) & FEED_PRICE_FIELDS:
            return "feed publishes an amount for an unavailable night or a hidden-price property"
    return None


PRESENCE_FILES = {"data/presence.json", "data/session-history.json", "data/session-signal.json"}


def check_presence(path, data):
    if path not in PRESENCE_FILES:
        return f"only {sorted(PRESENCE_FILES)} may be on the presence branch"
    try:
        doc = json.loads(data)
    except ValueError:
        return "not valid JSON"
    name = find_secret(data, code=False)
    if name:
        return f"contains what looks like {name}"
    return json_key_problem(doc)


POLICIES = {"rates-feed": check_rates_feed, "presence": check_presence}


def policy_for(branch):
    return POLICIES.get(branch or "", check_main)


# ── target selection ─────────────────────────────────────────────────────────

def range_revs(before, after):
    """git log arguments for the commits a push/PR from `before` to `after` adds."""
    if before and not ZERO_SHA.match(before):
        if subprocess.run(["git", "cat-file", "-e", f"{before}^{{commit}}"],
                          capture_output=True).returncode == 0:
            return [f"{before}..{after}"]
    # New branch or force-push (before unknown): commits not on any other branch.
    after_sha = git("rev-parse", f"{after}^{{commit}}").strip()
    others = []
    for line in git("for-each-ref", "--format=%(refname) %(objectname)", "refs/remotes").splitlines():
        ref, sha = line.split()
        if not ref.endswith("/HEAD") and sha != after_sha:
            others.append(ref)
    return [after, "--not", *others] if others else [after]


def all_refs():
    """(branch name, ref) for every branch and tag; remote-tracking refs first so
    a branch that only exists locally is still covered."""
    out = []
    for line in git("for-each-ref", "--format=%(refname)",
                    "refs/remotes", "refs/heads", "refs/tags").splitlines():
        if not line or line.endswith("/HEAD"):
            continue
        if line.startswith("refs/remotes/"):
            name = line.split("/", 3)[3]
        elif line.startswith("refs/heads/"):
            name = line[len("refs/heads/"):]
        else:
            name = None  # tags: code rules
        out.append((name, line))
    return out


def load_known():
    known = set()
    try:
        with open(os.path.join(git("rev-parse", "--show-toplevel").strip(), KNOWN_FILE)) as f:
            for line in f:
                tok = line.split("#", 1)[0].split()
                if tok and re.fullmatch(r"[0-9a-f]{7,40}", tok[0]):
                    known.add(tok[0])
    except OSError:
        pass
    return known


def main():
    args = sys.argv[1:]
    branch = os.environ.get("PRIVACY_GUARD_BRANCH")
    if "--branch" in args:
        i = args.index("--branch")
        branch = args[i + 1] if i + 1 < len(args) else None
        del args[i:i + 2]

    blobs = Blobs()
    problems, acknowledged = [], []
    checked, commits_seen, messages = set(), set(), 0
    known = set()

    def check_blob(commit, path, blob, policy):
        key = (blob, path, policy.__name__)
        if key in checked:
            return
        checked.add(key)
        kind, data = blobs.read(blob)
        if kind is None:
            # Fail closed: a file we can't read (e.g. a lazy fetch in a partial
            # clone failed) must not pass unchecked.
            problems.append(f"{commit[:12]}  {path}: could not be read, so it could not be checked")
            return
        if kind != "blob":
            return
        reason = policy(path, data)
        if reason:
            entry = f"{commit[:12]}  {path}: {reason}"
            (acknowledged if (blob in known or commit in known or commit[:12] in known)
             else problems).append(entry)

    def check_message(commit):
        nonlocal messages
        kind, raw = blobs.read(commit)
        if kind != "commit":
            return
        msg = raw.split(b"\n\n", 1)[1] if b"\n\n" in raw else b""
        messages += 1
        name = find_secret(msg, code=False)
        if name:
            entry = f"{commit[:12]}  (commit message): contains what looks like {name}"
            (acknowledged if commit in known or commit[:12] in known else problems).append(entry)

    def run_revs(revs, policy):
        for commit, files in log_changes(revs):
            if (commit, policy) in commits_seen:
                continue
            commits_seen.add((commit, policy))
            check_message(commit)
            for path, blob in files:
                check_blob(commit, path, blob, policy)

    if args == ["--all"]:
        known = load_known()
        refs = all_refs()
        for name, ref in refs:
            run_revs([ref], policy_for(name))
        print(f"Scanned {len(refs)} ref(s).")
    elif args[:1] == ["--tree"] and len(args) <= 2:
        rev = args[1] if len(args) == 2 else "HEAD"
        policy = policy_for(branch)
        for line in git("ls-tree", "-r", "-z", rev, binary=True).split(b"\0"):
            if not line:
                continue
            meta, path = line.split(b"\t", 1)
            mode, kind, blob = meta.decode().split()
            if kind == "blob":
                check_blob(rev, path.decode("utf-8", "surrogateescape"), blob, policy)
    elif args == ["--staged"]:
        policy = policy_for(branch)
        staged = git("diff", "--cached", "--name-only", "-z", "--diff-filter=AMRCT", binary=True)
        for path in staged.split(b"\0"):
            if not path:
                continue
            p = path.decode("utf-8", "surrogateescape")
            blob = git("rev-parse", f":{p}").strip()
            check_blob("(staged)    ", p, blob, policy)
    elif len(args) == 2:
        run_revs(range_revs(args[0], args[1]), policy_for(branch))
    else:
        sys.exit(__doc__)

    print(f"Checked {len(checked)} file version(s) and {messages} commit message(s).")
    if acknowledged:
        print(f"{len(acknowledged)} known historic finding(s) acknowledged in {KNOWN_FILE}:")
        for p in acknowledged:
            print("  " + p)
    if problems:
        print("\nPRIVACY GUARD FAILED - these must not be public:")
        for p in problems:
            print("  " + p)
        print("\nIf this is already pushed: remove it from the history (git filter-repo) before"
              " anything else is pushed; see docs/security.md and CLAUDE.md.")
        sys.exit(1)
    print("OK - nothing unencrypted or secret found.")


if __name__ == "__main__":
    main()
