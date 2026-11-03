import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  requestLoggerMiddleware,
  securityHeadersMiddleware,
  attachAuthContext,
} from './security/middleware.js';
import instanceAdminRouter from './routes/instance-admin.js';
import authRouter from './routes/auth.js';
import familyAdminRouter from './routes/family-admin.js';
import listsItemsRouter from './routes/lists-items.js';
import giftsRouter from './routes/gifts/index.js';
import linksRouter from './routes/links.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(requestLoggerMiddleware);
  app.use(...securityHeadersMiddleware);
  app.use(express.json({ limit: '6mb' }));
  app.use(cookieParser());
  app.use(attachAuthContext);

  // Zero-footprint token exchange routes (/g/:token, /a/:token, /invite/:token, /assisted/:token)
  app.use('/', linksRouter);

  // Core API routes
  app.use('/api/instance-admin', instanceAdminRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/families/:familyId', familyAdminRouter);
  app.use('/api/families/:familyId', listsItemsRouter);
  app.use('/api', giftsRouter);

  // Health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'unwrapped' });
  });

  // Static files & SPA fallback for /guest, /assignment, /accept-invite
  app.use(express.static(publicDir));
  app.get(['/guest', '/assignment', '/accept-invite'], (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Fallback 404 for unknown API routes
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const status = typeof err?.status === 'number' ? err.status : 500;
      const message = status === 500 ? 'Internal server error' : err.message || 'Request failed';
      res.status(status).json({ error: message });
    }
  );

  return app;
}
