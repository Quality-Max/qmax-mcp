// Redaction pass applied to every free-text string that leaves the Bugsink
// read-only tools. Bugsink issue metadata (exception type/value, transaction
// name) can occasionally carry secrets that leaked into an error message, so
// we scrub them before an autonomous agent ever sees them. This mirrors the
// `security.RedactSensitive` pass that qmax-code applies on its Bugsink
// reporting path — the safety boundary must hold on both write and read.

const REDACTION_RULES: Array<[RegExp, string]> = [
  // PEM private key blocks.
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  // Sentry / Bugsink DSNs: scheme://publicKey(:secret)@host/projectId
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+(?::[^\s@/]+)?@[^\s/]+\/\d+\b/gi, '[REDACTED_DSN]'],
  // URLs carrying inline credentials (user:pass@host).
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi, '[REDACTED_URL_CREDENTIALS]://'],
  // JWTs.
  [/\beyJ[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}\.[a-zA-Z0-9_-]{4,}/g, '[REDACTED_JWT]'],
  // AWS access key ids.
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  // Bearer / token / secret / password / api-key assignments.
  [
    /\b(bearer|authorization|token|secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret)\b(\s*[:=]\s*|\s+)["']?[^\s"',;}]+/gi,
    '$1=[REDACTED]',
  ],
  // Email addresses.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  // Long hex blobs (session ids, hashes, hex-encoded secrets).
  [/\b[0-9a-f]{32,}\b/gi, '[REDACTED_HEX]'],
];

/**
 * Scrub credentials and other sensitive tokens from a free-text string.
 * Returns an empty string for nullish input.
 */
export function redactSensitive(value: string | null | undefined): string {
  if (!value) return '';
  let out = String(value);
  for (const [pattern, replacement] of REDACTION_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
