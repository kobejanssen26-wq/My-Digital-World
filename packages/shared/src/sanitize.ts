/**
 * Privacy helpers. These run in the local bridge before anything is uploaded and
 * again (defensively) in the worker.
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bmdw_[A-Za-z0-9]{20,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g, // long hex blobs (keys, hashes)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long base64-ish blobs
];

/** Replace likely credentials with a marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

const PATH_RE = /(?:[A-Za-z]:\\|\/)(?:[\w.@~+-]+[\\/])+[\w.@~+-]*/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * Produce a short, single-line, privacy-conscious summary of a prompt:
 * secrets redacted, absolute paths and emails removed, whitespace collapsed.
 */
export function summarizePrompt(prompt: string, max = 140): string {
  let t = prompt.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted text]');
  t = t.replace(/```[\s\S]*?```/g, '[code]');
  t = redactSecrets(t);
  t = t.replace(PATH_RE, '[path]').replace(EMAIL_RE, '[email]');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + '…';
  return t;
}

/** Strip control characters and clamp length for any display string. */
export function cleanText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
