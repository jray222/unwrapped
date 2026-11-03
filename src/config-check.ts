import crypto from 'node:crypto';

const PLACEHOLDER = /^(change-?me|replace[_-]?with|dev-instance-admin|example|secret|password|admin|test)/i;

/** Constant-time string comparison (hashes both sides so length differences don't leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Returns human-readable problems that make the given settings unsafe for production. */
export function findProductionConfigProblems(settings: { bootstrapInstanceAdminToken: string }): string[] {
  const problems: string[] = [];
  const token = settings.bootstrapInstanceAdminToken;
  if (!process.env.BOOTSTRAP_INSTANCE_ADMIN_TOKEN) {
    problems.push('BOOTSTRAP_INSTANCE_ADMIN_TOKEN is not set (the built-in dev default is publicly known).');
  } else if (PLACEHOLDER.test(token)) {
    problems.push('BOOTSTRAP_INSTANCE_ADMIN_TOKEN is still a placeholder value; set a long random secret.');
  } else if (token.length < 24) {
    problems.push('BOOTSTRAP_INSTANCE_ADMIN_TOKEN is too short; use at least 24 random characters.');
  }
  return problems;
}

/** Throws with a clear message when running in production with unsafe settings. */
export function assertProductionConfig(settings: { isProd: boolean; bootstrapInstanceAdminToken: string }): void {
  if (!settings.isProd) return;
  const problems = findProductionConfigProblems(settings);
  if (problems.length > 0) {
    throw new Error(`Refusing to start in production with unsafe configuration:\n - ${problems.join('\n - ')}`);
  }
}
