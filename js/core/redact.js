// Strips credentials and personal data from a copy of the database, for the
// debug snapshot (Settings → Debug Data Export). Pragmatic, not exhaustive:
// it keeps the structure, ids, amounts, dates and flags a developer needs,
// and removes what identifies people or unlocks anything.

// Removed outright, whatever the value.
const DROP_KEY = /pass(word|wd)?$|password|salt|token|secret|api.?key|private.?key|wrapped|credential/i;

// String values under these keys (and everything nested inside them) are
// replaced with a placeholder.
const PII_KEY = new RegExp([
  'e-?mail', 'phone', 'mobile', '^tel$', '^fax$', 'iban', 'swift', '^bic$', 'account.?(number|no)$',
  'address', 'street', '^city$', 'zip', 'post.?code', 'postal', '^vat(number|no|id)?$', 'tax.?(id|number|no)$',
  'registration', 'passport', 'id.?(number|card|no)$', 'birth', '^dob$', 'nationality',
  'guest', 'tenant.?name', 'client.?name', 'customer', 'contact', 'payer', 'payee', 'owner.?name',
  'person.?name', 'signature', 'ical', 'url$', '^link$', '^notes?$', 'memo', 'comment', 'summary', 'description'
].join('|'), 'i');

// Name-like keys are personal only inside these parts of the database
// (a property or service name is kept; a tenant's or a file's name isn't).
const NAME_KEY = /^(name|full.?name|first.?name|last.?name|display.?name|user.?name|file.?name|original.?name)$/i;
const NAME_CONTEXTS = new Set([
  'users', 'tenants', 'clients', 'people', 'vendors', 'team', 'business', 'engagements',
  'documents', 'receipt', 'receipts', 'attachments', 'files', 'guests', 'contacts', 'owners'
]);

// Embedded file contents (legacy documents/receipts/PDFs kept inline).
const BLOB_KEY = /^(data|pdfData|content|b64|base64|blob|bytes)$/i;
const BLOB_MIN_LENGTH = 256;

const REDACTED = '[redacted]';

function redactLeaves(value) {
  if (typeof value === 'string') return value ? REDACTED : value;
  if (Array.isArray(value)) return value.map(redactLeaves);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!DROP_KEY.test(k)) out[k] = redactLeaves(v);
    return out;
  }
  return value;
}

function walk(value, ancestors) {
  if (Array.isArray(value)) return value.map(v => walk(v, ancestors));
  if (!value || typeof value !== 'object') return value;
  const inNameContext = ancestors.some(a => NAME_CONTEXTS.has(a));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEY.test(k)) continue;
    if (PII_KEY.test(k) || (inNameContext && NAME_KEY.test(k))) { out[k] = redactLeaves(v); continue; }
    if (BLOB_KEY.test(k) && typeof v === 'string' && v.length >= BLOB_MIN_LENGTH) {
      out[k] = `[removed: ${v.length} chars]`;
      continue;
    }
    out[k] = walk(v, [...ancestors, k]);
  }
  return out;
}

export function redactForDebug(db) {
  return walk(db, []);
}
