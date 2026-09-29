const assignmentDetectionPattern =
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/i;
const bearerDetectionPattern = /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/i;
const providerTokenDetectionPattern =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/;
const privateKeyDetectionPattern =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/;
const credentialFieldNamePattern =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|authorization)/i;

export function containsPotentialSecret(value: string): boolean {
  return (
    assignmentDetectionPattern.test(value) ||
    bearerDetectionPattern.test(value) ||
    providerTokenDetectionPattern.test(value) ||
    privateKeyDetectionPattern.test(value)
  );
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|authorization))\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g,
      '[REDACTED TOKEN]',
    );
}

export function assertNoSecrets(value: unknown, context: string): void {
  if (typeof value === 'string') {
    if (containsPotentialSecret(value)) {
      throw new Error(`${context} appears to contain a credential or secret and was rejected.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoSecrets(item, context);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (credentialFieldNamePattern.test(key)) {
        throw new Error(`${context} includes a credential-named field and was rejected.`);
      }
      assertNoSecrets(item, context);
    }
  }
}
