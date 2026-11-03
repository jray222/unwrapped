import { defineConfig } from '@playwright/test';

const PORT = 3217;

// Browser smoke tests for the SPA (public/). Run with `npm run test:e2e`.
// Uses the in-memory PGlite database, so no external services are needed.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx src/server.ts',
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT), NODE_ENV: 'development', APP_ORIGIN: `http://127.0.0.1:${PORT}` },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
