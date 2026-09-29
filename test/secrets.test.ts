import { describe, expect, test } from 'bun:test';
import {
  assertNoSecrets,
  containsPotentialSecret,
  redactSecrets,
} from '../src/security/secrets.js';

describe('secret handling', () => {
  test('detects credentials without stateful regex behavior', () => {
    expect(containsPotentialSecret('api_key=token-one')).toBe(true);
    expect(containsPotentialSecret('ordinary status')).toBe(false);
    expect(containsPotentialSecret('api_key=token-two')).toBe(true);
  });

  test('rejects secret-shaped inputs and redacts run output', () => {
    expect(() => assertNoSecrets({ prompt: 'password=hunter2' }, 'Job input')).toThrow(
      'credential or secret',
    );
    expect(() => assertNoSecrets({ apiKey: 'value' }, 'Job input')).toThrow(
      'credential-named field',
    );
    expect(redactSecrets('token: ghp_123456789012345678901234567890')).toContain(
      '[REDACTED TOKEN]',
    );
    expect(redactSecrets('Bearer abcdefghijklmnop')).toBe('Bearer [REDACTED]');
  });
});
