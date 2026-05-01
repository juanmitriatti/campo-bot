import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import webhook from './controllers/whatsapp.controller.js';
import testBotRoutes from './controllers/test-bot.controller.js';
import telegramWebhook from './controllers/telegram.controller.js';
import { verifyTelegramWebhook } from './middleware/telegram-auth.js';
import dashboard from './routes/dashboard.js';
import authRoutes from './routes/auth.routes.js';
import webhookRoutes from './routes/webhooks.routes.js';
import { requireAuth, requireRole } from './middleware/auth.middleware.js';
import mapRoutes from './routes/map.routes.js';
import { startScheduler } from './services/scheduler.js';
import { runMigrations } from './scripts/run-migrations.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Payment webhooks need the raw body for signature verification — mount them
// BEFORE express.json() so the JSON parser doesn't consume the stream.
app.use('/webhooks', webhookRoutes);

app.use(express.json());

// Request logger
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

// WhatsApp webhook
app.use('/webhook', webhook);

// Telegram webhook
app.use('/telegram', verifyTelegramWebhook, telegramWebhook);

// Health check — used by CI smoke test post-deploy.
// Returns the running git sha (set at build time via RAILWAY_GIT_COMMIT_SHA)
// so we can confirm a specific deploy is live.
app.get('/api/health', (_req: express.Request, res: express.Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    sha: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
});

// Public + protected end-user auth routes
app.use('/api/auth', authRoutes);

// Test bot chat — requires JWT auth
app.use('/api/test-bot', requireAuth, testBotRoutes);

// Map page (public, token-authenticated)
app.use('/api/map', mapRoutes);
app.use('/map', express.static(path.join(__dirname, 'public/map')));

// Admin dashboard: protect API, then serve legacy dashboard
app.use('/admin/api', requireAuth, requireRole('admin'));
app.use('/admin', dashboard);

// React frontend app (dashboard) — served on explicit routes only
const frontendDist = path.resolve(__dirname, '../frontend/dist');
app.use('/app-assets', express.static(frontendDist));
const reactAppRoutes = ['/login', '/register', '/dashboard', '/chat'];
app.get(reactAppRoutes, (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.sendFile(path.join(frontendDist, 'index.html'), (err) => { if (err) next(); });
});

// Landing page (campo-chat-bot) — static assets + SPA fallback
const landingDist = path.resolve(__dirname, '../landing/dist');
app.use(express.static(landingDist));

// SPA fallback → landing page for all unknown routes
app.get('{*splat}', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin') ||
      req.path.startsWith('/webhook') || req.path.startsWith('/telegram') ||
      req.path.startsWith('/map') || req.path.startsWith('/app-assets')) {
    next();
    return;
  }
  res.sendFile(path.join(landingDist, 'index.html'), (err) => {
    if (err) next();
  });
});

// Global error handler — Express 5 async errors
// @ts-ignore — Express 5 error handler requires 4 params
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('UNHANDLED ERROR:', err?.stack || err?.message || err);
  if (!res.headersSent) res.sendStatus(500);
});

const port = process.env.PORT || 3000;

async function bootstrap() {
  // Run pending DB migrations BEFORE the server starts accepting traffic.
  // Disable with RUN_MIGRATIONS_ON_START=false (e.g. for unit tests).
  if (process.env.RUN_MIGRATIONS_ON_START !== 'false') {
    try {
      await runMigrations();
    } catch (err) {
      console.error('[bootstrap] Migration failure — aborting startup:', err);
      process.exit(1);
    }
  }

  app.listen(port, () => {
    console.log(`Servidor corriendo en puerto ${port}`);
    startScheduler();
  });
}

bootstrap();

export default app;
