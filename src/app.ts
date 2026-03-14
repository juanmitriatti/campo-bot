import express from 'express';
import dotenv from 'dotenv';
import webhook from './controllers/whatsapp.controller.js';
import dashboard from './routes/dashboard.js';
import { startScheduler } from './services/scheduler.js';

dotenv.config();

const app = express();
app.use(express.json());

// Request logger
app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
  console.log(`[req] ${req.method} ${req.path}`);
  next();
});

// New TS webhook controller
app.use('/webhook', webhook);

// Legacy dashboard (stays as JS)
app.use('/dashboard', dashboard);

// Global error handler — Express 5 async errors
// @ts-ignore — Express 5 error handler requires 4 params
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('UNHANDLED ERROR:', err?.stack || err?.message || err);
  if (!res.headersSent) res.sendStatus(500);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Servidor corriendo en puerto ${port}`);
  startScheduler();
});

export default app;
