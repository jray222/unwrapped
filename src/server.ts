import { config } from './config.js';
import { initDb } from './db/index.js';
import { createApp } from './app.js';
import { assertProductionConfig } from './config-check.js';

async function main() {
  assertProductionConfig(config);
  await initDb();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Unwrapped server listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Failed to start Unwrapped server:', err);
  process.exit(1);
});
