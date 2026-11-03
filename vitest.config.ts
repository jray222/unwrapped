import { defineConfig } from 'vitest/config';

// Every test file boots its own app and its own in-memory PGlite database
// (DATABASE_URL defaults to pglite://memory; the Pool lives in the per-file module graph,
// and vitest isolates modules per file), so files may run in parallel safely.
// scrypt hashing + PGlite WASM bootstrap are CPU-heavy, so give hooks/tests headroom
// when several files run at once.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
