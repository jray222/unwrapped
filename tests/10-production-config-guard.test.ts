import { describe, it, expect, afterEach } from 'vitest';
import { assertProductionConfig, findProductionConfigProblems, safeEqual } from '../src/config-check.js';

describe('Unwrapped v2 — Section 10: Production configuration guard', () => {
  const original = process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN;
    else process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN = original;
  });

  it('does nothing outside production', () => {
    delete process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN;
    expect(() =>
      assertProductionConfig({ isProd: false, bootstrapInstanceAdminToken: 'dev-instance-admin-bootstrap-token' })
    ).not.toThrow();
  });

  it('refuses production start when the token is unset, a placeholder, or short', () => {
    delete process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN;
    expect(findProductionConfigProblems({ bootstrapInstanceAdminToken: 'dev-instance-admin-bootstrap-token' })).not.toHaveLength(0);

    for (const bad of ['change-me-instance-admin-bootstrap-token', 'replace_with_a_secure_bootstrap_token', 'short-token']) {
      process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN = bad;
      expect(() => assertProductionConfig({ isProd: true, bootstrapInstanceAdminToken: bad })).toThrow(/unsafe configuration/);
    }
  });

  it('accepts a long random token in production', () => {
    const good = 'k3J9xQ2vLm8Zr5TpWc7YdN1aBf6HsUe0';
    process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN = good;
    expect(() => assertProductionConfig({ isProd: true, bootstrapInstanceAdminToken: good })).not.toThrow();
  });

  it('safeEqual compares strings of different lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
