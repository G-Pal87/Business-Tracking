// Business Tracking – server-side gateway
// Stores GitHub PAT encrypted on disk; proxies all GitHub API calls.
// The browser never receives or stores the token.

import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATIC_ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

// ── Encryption (AES-256-GCM) ────────────────────────────────────────────────

const ENC_KEY = crypto.scryptSync(
  process.env.SERVER_SECRET || 'change-me-in-production',
  'bt-v1-salt',
  32
);

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(str) {
  const [ivHex, tagHex, encHex] = str.split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    ENC_KEY,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

// ── Config (server/config.json) ─────────────────────────────────────────────

const DEFAULT_CONFIG = {
  owner: '', repo: '', branch: 'main', dbPath: 'data/db.json', tokenEnc: ''
};

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_CONFIG };
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function getToken() {
  const { tokenEnc } = readConfig();
  if (!tokenEnc) return null;
  try { return decrypt(tokenEnc); } catch { return null; }
}

// ── GitHub API helper ────────────────────────────────────────────────────────

function ghRequest(method, apiPath, body, token) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'business-tracking-server/1.0'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body)  headers['Content-Type']  = 'application/json';

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(
      { hostname: 'api.github.com', path: apiPath, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = raw;
          try { data = JSON.parse(raw); } catch { /* leave as string */ }
          resolve({ status: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Admin auth ───────────────────────────────────────────────────────────────
// Client sends: Authorization: Bearer <base64(JSON.stringify({username,passwordHash}))>
// Server validates username + SHA-256 hash against users in db.json.

async function resolveAdminCreds(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  let creds;
  try {
    creds = JSON.parse(Buffer.from(auth.slice(7), 'base64').toString('utf8'));
  } catch { return null; }
  if (!creds.username || !creds.passwordHash) return null;

  const cfg = readConfig();
  const token = getToken();
  if (!cfg.owner || !cfg.repo || !token) return null;

  // Fetch db.json to validate user
  const res = await ghRequest(
    'GET',
    `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dbPath}?ref=${cfg.branch || 'main'}`,
    null,
    token
  ).catch(() => null);

  if (!res || res.status !== 200 || !res.data?.content) return null;

  let db;
  try {
    const raw = Buffer.from(res.data.content.replace(/\s/g, ''), 'base64').toString('utf8');
    db = JSON.parse(raw);
  } catch { return null; }

  return (db.users || []).find(
    u => u.username === creds.username &&
         u.passwordHash === creds.passwordHash &&
         u.role === 'admin'
  ) || null;
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(STATIC_ROOT));

// GET /api/github/config — public (no token returned)
app.get('/api/github/config', (_req, res) => {
  const cfg = readConfig();
  res.json({
    owner:           cfg.owner || '',
    repo:            cfg.repo  || '',
    branch:          cfg.branch || 'main',
    dbPath:          cfg.dbPath || 'data/db.json',
    tokenConfigured: !!cfg.tokenEnc
  });
});

// POST /api/github/config — admin only (or first-time setup)
app.post('/api/github/config', async (req, res) => {
  const cfg = readConfig();
  const isFirstSetup = !cfg.tokenEnc; // no token stored yet → allow bootstrap

  if (!isFirstSetup) {
    const user = await resolveAdminCreds(req);
    if (!user) return res.status(403).json({ error: 'Admin credentials required' });
  }

  const { owner, repo, branch, dbPath, token } = req.body || {};
  const next = {
    owner:    (owner  ?? cfg.owner)  || '',
    repo:     (repo   ?? cfg.repo)   || '',
    branch:   (branch ?? cfg.branch) || 'main',
    dbPath:   (dbPath ?? cfg.dbPath) || 'data/db.json',
    tokenEnc: cfg.tokenEnc
  };
  if (token && token.trim()) next.tokenEnc = encrypt(token.trim());

  writeConfig(next);
  res.json({
    owner: next.owner, repo: next.repo, branch: next.branch,
    dbPath: next.dbPath, tokenConfigured: !!next.tokenEnc
  });
});

// POST /api/github/test — admin only
app.post('/api/github/test', async (req, res) => {
  const user = await resolveAdminCreds(req);
  if (!user) return res.status(403).json({ error: 'Admin credentials required' });

  const cfg = readConfig();
  const token = getToken();
  if (!cfg.owner || !cfg.repo || !token) {
    return res.status(400).json({ error: 'GitHub not fully configured' });
  }

  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dbPath}?ref=${cfg.branch || 'main'}`;
  let result;
  try { result = await ghRequest('GET', apiPath, null, token); }
  catch (e) { return res.status(502).json({ error: `Network error: ${e.message}` }); }

  if (result.status === 200) {
    return res.json({ ok: true, message: `Connected — ${cfg.owner}/${cfg.repo}/${cfg.dbPath}` });
  }
  const map = {
    404: `File ${cfg.dbPath} not found in ${cfg.owner}/${cfg.repo}`,
    401: 'Token rejected (401) — check PAT permissions',
    403: 'Token rejected (403) — repo may be private or PAT lacks scope'
  };
  res.status(result.status < 500 ? result.status : 502)
     .json({ error: map[result.status] || `GitHub returned ${result.status}` });
});

// GET /api/db — public (needed before login to load db.json)
app.get('/api/db', async (_req, res) => {
  const cfg = readConfig();
  const token = getToken();
  if (!cfg.owner || !cfg.repo) {
    return res.status(503).json({ error: 'GitHub not configured on server' });
  }

  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dbPath}?ref=${cfg.branch || 'main'}`;
  let result;
  try { result = await ghRequest('GET', apiPath, null, token); }
  catch (e) { return res.status(502).json({ error: `Network error: ${e.message}` }); }

  if (result.status === 404) return res.status(404).json({ error: 'db.json not found in repo' });
  if (result.status === 401 || result.status === 403) {
    return res.status(401).json({ error: `GitHub auth failed (${result.status}) — check token in admin settings` });
  }
  if (result.status !== 200) {
    return res.status(502).json({ error: `GitHub API error ${result.status}` });
  }

  const { sha, content, download_url } = result.data;

  if (content) {
    // Normal path: content is inline base64
    return res.json({ sha, content });
  }

  // Large file (>1 MB): fetch via download_url without auth headers
  if (download_url) {
    try {
      const raw = await new Promise((resolve, reject) => {
        https.get(download_url, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          r.on('error', reject);
        }).on('error', reject);
      });
      // Re-encode so the client gets consistent base64
      return res.json({ sha, content: Buffer.from(raw).toString('base64') });
    } catch (e) {
      return res.status(502).json({ error: `Cannot download large db.json: ${e.message}` });
    }
  }

  res.status(502).json({ error: 'GitHub returned no content and no download_url' });
});

// PUT /api/db — push merged db.json to GitHub
// body: { content: base64String, message: string, sha: string }
app.put('/api/db', async (req, res) => {
  const cfg = readConfig();
  const token = getToken();
  if (!cfg.owner || !cfg.repo || !token) {
    return res.status(503).json({ error: 'GitHub not configured on server' });
  }

  const { content, message, sha } = req.body || {};
  if (!content || !sha) return res.status(400).json({ error: 'content and sha are required' });

  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dbPath}`;
  let result;
  try {
    result = await ghRequest('PUT', apiPath, {
      message: message || 'Update data',
      content,
      branch: cfg.branch || 'main',
      sha
    }, token);
  } catch (e) { return res.status(502).json({ error: `Network error: ${e.message}` }); }

  if (result.status === 200 || result.status === 201) {
    return res.json({ sha: result.data.content.sha });
  }
  if (result.status === 409) return res.status(409).json({ error: 'SHA conflict — re-fetch and retry' });
  if (result.status === 401 || result.status === 403) {
    return res.status(401).json({ error: `Token lacks write access (${result.status})` });
  }
  res.status(502).json({ error: `GitHub push failed: ${result.status}` });
});

// SPA fallback
app.get('*', (_req, res) => res.sendFile(path.join(STATIC_ROOT, 'index.html')));

app.listen(PORT, () => {
  console.log(`Business Tracking server on http://localhost:${PORT}`);
  const cfg = readConfig();
  if (!cfg.tokenEnc) {
    console.log('  GitHub not yet configured — visit Settings as admin to set it up.');
  } else {
    console.log(`  GitHub: ${cfg.owner}/${cfg.repo} (${cfg.branch})`);
  }
  if (!process.env.SERVER_SECRET) {
    console.warn('  WARNING: SERVER_SECRET not set. Set it in .env for production.');
  }
});
