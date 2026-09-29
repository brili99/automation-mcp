import { describe, expect, test } from 'bun:test';

describe('project runtime', () => {
  test('runs under the declared minimum Bun version', () => {
    const [major = '0', minor = '0'] = Bun.version.split('.');
    const version = Number(major) * 100 + Number(minor);

    expect(version).toBeGreaterThanOrEqual(104);
  });
});
