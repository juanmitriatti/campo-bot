import { Router } from 'express';
import { AuthService, AuthError } from '../domain/auth/auth.service.js';
import { ObservationService, ObservationError } from '../domain/auth/observation.service.js';
import { ChannelVerificationService, VerificationError } from '../domain/auth/channel-verification.service.js';
import { AccountDeletionService, AccountDeletionError } from '../domain/auth/account-deletion.service.js';
import { PasswordRecoveryService, PasswordRecoveryError } from '../domain/auth/password-recovery.service.js';
import {
  sendVerificationEmail,
  confirmVerificationToken,
  getVerificationStatus,
  EmailVerificationError,
} from '../domain/auth/email-verification.service.js';
import { DataExportService } from '../services/data-export.service.js';
import { SubscriptionService, SubscriptionError } from '../domain/billing/subscription.service.js';
import { PlanRepository } from '../domain/billing/plan.repository.js';
import { FeatureGate } from '../domain/billing/feature-gate.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import type { Request, Response, NextFunction } from 'express';
import { logError } from '../services/error-logger.js';
import { pool } from '../config/db.js';
import { asUserId } from '../types/index.js';
import type { FeatureKey } from '../types/index.js';

const router = Router();
const authService = new AuthService();
const observationService = new ObservationService();
const planRepo = new PlanRepository();
const featureGate = new FeatureGate();
const verificationService = new ChannelVerificationService();
const accountDeletionService = new AccountDeletionService();
const dataExportService = new DataExportService();
const subscriptionService = new SubscriptionService();
const passwordRecoveryService = new PasswordRecoveryService();

function requireFeature(feature: FeatureKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const hasAccess = await featureGate.hasFeature(asUserId(req.auth!.userId), feature);
    if (!hasAccess) {
      res.status(403).json({ error: 'Feature not available in your plan' });
      return;
    }
    next();
  };
}

// --- Public routes ---

router.get('/plans', async (_req: Request, res: Response) => {
  try {
    const plans = await planRepo.getAllPlans();
    res.json(plans.map(p => ({ id: p.id, name: p.name, display_name: p.display_name, price_ars: p.price_ars })));
  } catch (err) {
    handleError(err, res);
  }
});

// Public values the frontend needs at boot. Whitelisted; never include
// anything that isn't safe to leak.
router.get('/public-config', async (_req: Request, res: Response) => {
  try {
    const { getSetting } = await import('../services/settings.service.js');
    const [sentryDsn, environment, sampleRate] = await Promise.all([
      getSetting('SENTRY_DSN_FRONTEND'),
      getSetting('SENTRY_ENVIRONMENT'),
      getSetting('SENTRY_TRACES_SAMPLE_RATE'),
    ]);
    res.json({
      sentry: {
        dsn: sentryDsn || null,
        environment: environment || 'production',
        tracesSampleRate: Number(sampleRate ?? '0.1'),
      },
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const result = await authService.register(req.body);
    res.status(201).json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const result = await authService.login(req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken es obligatorio' });
      return;
    }
    const tokens = await authService.refreshTokens(refreshToken);
    res.json(tokens);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Forgot password / email verification (public) ---

router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body || {};
    await passwordRecoveryService.requestReset(email);
    // Always 200 — never reveal whether the email exists.
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof PasswordRecoveryError && err.status === 400) {
      res.status(400).json({ error: err.message });
      return;
    }
    handleError(err, res);
  }
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body || {};
    await passwordRecoveryService.resetPassword(token, password);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/verify-email', async (req: Request, res: Response) => {
  try {
    const { token } = req.body || {};
    const result = await confirmVerificationToken(token);
    res.json({ ok: true, userId: result.userId });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/resend-verification', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await sendVerificationEmail(req.auth!.userId);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/verify-email/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await getVerificationStatus(req.auth!.userId);
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Protected routes ---

router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await authService.logout(refreshToken);
    }
    res.json({ message: 'Sesión cerrada' });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await authService.getProfile(req.auth!.userId);
    if (!profile) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    res.json(profile);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await authService.updateProfile(req.auth!.userId, req.body);
    res.json({ user });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Channel verification (WhatsApp OTP + Telegram deep-link) ---

router.get('/verify/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await verificationService.getStatus(asUserId(req.auth!.userId));
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/verify/whatsapp/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body as { phone?: string };
    if (!phone) {
      res.status(400).json({ error: 'El campo phone es obligatorio.' });
      return;
    }
    const result = await verificationService.startWhatsApp(asUserId(req.auth!.userId), phone);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/verify/whatsapp/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ error: 'El campo code es obligatorio.' });
      return;
    }
    const status = await verificationService.confirmWhatsApp(asUserId(req.auth!.userId), code);
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/verify/whatsapp', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await verificationService.unlinkWhatsApp(asUserId(req.auth!.userId));
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/verify/telegram/start', requireAuth, async (req: Request, res: Response) => {
  try {
    const result = await verificationService.startTelegramLink(asUserId(req.auth!.userId));
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/verify/telegram', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await verificationService.unlinkTelegram(asUserId(req.auth!.userId));
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Data portability (GDPR) ---

router.get('/me/export', requireAuth, async (req: Request, res: Response) => {
  try {
    await dataExportService.streamUserExport(asUserId(req.auth!.userId), res);
  } catch (err) {
    if (!res.headersSent) {
      handleError(err, res);
    } else {
      console.error('[me/export] error after headers sent:', err);
      res.end();
    }
  }
});

router.delete('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ error: 'Tenés que confirmar tu contraseña actual.', code: 'PASSWORD_REQUIRED' });
      return;
    }
    await accountDeletionService.deleteAccount(asUserId(req.auth!.userId), password);
    res.json({ deleted: true });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Subscriptions / billing ---

router.get('/subscription', requireAuth, async (req: Request, res: Response) => {
  try {
    const status = await subscriptionService.getStatus(asUserId(req.auth!.userId));
    res.json(status);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/subscription/checkout', requireAuth, async (req: Request, res: Response) => {
  try {
    const { plan, period } = req.body as { plan?: string; period?: 'monthly' | 'yearly' };
    if (!plan) {
      res.status(400).json({ error: 'plan es obligatorio.' });
      return;
    }
    if (period && period !== 'monthly' && period !== 'yearly') {
      res.status(400).json({ error: 'period debe ser monthly o yearly.' });
      return;
    }
    const profile = await authService.getProfile(req.auth!.userId);
    if (!profile?.user.email) {
      res.status(400).json({ error: 'Necesitamos tu email registrado para procesar el pago.' });
      return;
    }
    const verifyRequired = ((await import('../services/settings.service.js')).getSettingBool);
    if (await verifyRequired('EMAIL_VERIFY_REQUIRED')) {
      const status = await getVerificationStatus(req.auth!.userId);
      if (!status.emailVerified) {
        res.status(400).json({ error: 'Verificá tu email antes de iniciar el pago. Te mandamos un link de verificación cuando te registraste.', code: 'EMAIL_NOT_VERIFIED' });
        return;
      }
    }
    const result = await subscriptionService.startCheckout({
      userId: asUserId(req.auth!.userId),
      payerEmail: profile.user.email,
      planName: plan,
      billingPeriod: period ?? 'monthly',
    });
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/subscription/cancel', requireAuth, async (req: Request, res: Response) => {
  try {
    await subscriptionService.cancel(asUserId(req.auth!.userId));
    res.json({ cancelled: true });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Dashboard overview ---

router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldIdRaw = req.query.field_id;
    const fieldId = typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN;
    if (isNaN(fieldId)) {
      res.status(400).json({ error: 'field_id query parameter is required' });
      return;
    }
    const accessibleFields = `SELECT field_id FROM field_members WHERE user_id = $1`;

    // Current month boundaries (Argentina TZ)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);

    // Expenses: current + previous month, split by currency.
    const expensesQuery = pool.query(
      `SELECT
        COALESCE(currency, 'ARS') AS currency,
        COALESCE(SUM(CASE WHEN expense_date >= $2::date THEN amount ELSE 0 END), 0) AS current_month,
        COALESCE(SUM(CASE WHEN expense_date >= $3::date AND expense_date < $2::date THEN amount ELSE 0 END), 0) AS prev_month
       FROM expenses
       WHERE (user_id = $1 OR field_id IN (${accessibleFields}))
         AND deleted_at IS NULL
         AND expense_date >= $3::date
         AND COALESCE(field_id, (SELECT field_id FROM plots WHERE id = expenses.plot_id)) = $4
       GROUP BY COALESCE(currency, 'ARS')`,
      [userId, monthStart, prevMonthStart, fieldId]
    );

    // Incomes: current + previous month, split by currency.
    const incomesQuery = pool.query(
      `SELECT
        COALESCE(currency, 'ARS') AS currency,
        COALESCE(SUM(CASE WHEN income_date >= $2::date THEN amount ELSE 0 END), 0) AS current_month,
        COALESCE(SUM(CASE WHEN income_date >= $3::date AND income_date < $2::date THEN amount ELSE 0 END), 0) AS prev_month
       FROM incomes
       WHERE (user_id = $1 OR field_id IN (${accessibleFields}))
         AND deleted_at IS NULL
         AND income_date >= $3::date
         AND COALESCE(field_id, (SELECT field_id FROM plots WHERE id = incomes.plot_id)) = $4
       GROUP BY COALESCE(currency, 'ARS')`,
      [userId, monthStart, prevMonthStart, fieldId]
    );

    // Activities count this month (excluding livestock-only events shown elsewhere)
    const activitiesQuery = pool.query(
      `SELECT COUNT(*)::int AS count
       FROM domain_events
       WHERE user_id = $1
         AND event_date >= $2::date
         AND event_type NOT IN ('health_event', 'repro_event', 'weighing')
         AND (plot_id IS NULL OR plot_id IN (SELECT id FROM plots WHERE field_id = $3))`,
      [userId, monthStart, fieldId]
    );

    // Recent items: last 5 expenses + incomes + activities mixed
    const recentQuery = pool.query(
      `(SELECT 'expense' AS type, e.id, e.description, e.amount, e.currency, NULL AS event_type,
              e.expense_date AS date, f.name AS field_name, p.name AS plot_name
        FROM expenses e
        LEFT JOIN fields f ON e.field_id = f.id
        LEFT JOIN plots p ON e.plot_id = p.id
        WHERE (e.user_id = $1 OR e.field_id IN (${accessibleFields}))
          AND e.deleted_at IS NULL
          AND COALESCE(e.field_id, p.field_id) = $2
        ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 5)
       UNION ALL
       (SELECT 'income' AS type, i.id, i.description, i.amount, i.currency, NULL AS event_type,
              i.income_date AS date, f.name AS field_name, p.name AS plot_name
        FROM incomes i
        LEFT JOIN fields f ON i.field_id = f.id
        LEFT JOIN plots p ON i.plot_id = p.id
        WHERE (i.user_id = $1 OR i.field_id IN (${accessibleFields}))
          AND i.deleted_at IS NULL
          AND COALESCE(i.field_id, p.field_id) = $2
        ORDER BY i.income_date DESC, i.created_at DESC LIMIT 5)
       UNION ALL
       (SELECT 'activity' AS type, de.id, NULL AS description, NULL::numeric AS amount, NULL AS currency, de.event_type,
              de.event_date AS date, f.name AS field_name, p.name AS plot_name
        FROM domain_events de
        LEFT JOIN plots p ON de.plot_id = p.id
        LEFT JOIN fields f ON p.field_id = f.id
        WHERE de.user_id = $1
          AND de.event_type NOT IN ('health_event', 'repro_event', 'weighing')
          AND p.field_id = $2
        ORDER BY de.event_date DESC, de.created_at DESC LIMIT 5)
       ORDER BY date DESC LIMIT 5`,
      [userId, fieldId]
    );

    const [expensesRes, incomesRes, activitiesRes, recentRes] = await Promise.all([
      expensesQuery, incomesQuery, activitiesQuery, recentQuery,
    ]);

    // Aggregate by currency. Default to 0 for currencies with no data so the
    // frontend doesn't have to handle undefined cases.
    const sumByCurrency = (rows: any[]): Record<string, { current: number; prev: number }> => {
      const out: Record<string, { current: number; prev: number }> = {
        ARS: { current: 0, prev: 0 },
        USD: { current: 0, prev: 0 },
      };
      for (const r of rows) {
        out[r.currency] = {
          current: Number(r.current_month),
          prev: Number(r.prev_month),
        };
      }
      return out;
    };
    const expensesByCcy = sumByCurrency(expensesRes.rows);
    const incomesByCcy = sumByCurrency(incomesRes.rows);

    const result: Record<string, unknown> = {
      // New shape: per-currency totals (ARS + USD)
      expenses_month: { ARS: expensesByCcy.ARS.current, USD: expensesByCcy.USD.current },
      expenses_prev_month: { ARS: expensesByCcy.ARS.prev, USD: expensesByCcy.USD.prev },
      incomes_month: { ARS: incomesByCcy.ARS.current, USD: incomesByCcy.USD.current },
      incomes_prev_month: { ARS: incomesByCcy.ARS.prev, USD: incomesByCcy.USD.prev },
      // Backward compat — old fields hardcoded to ARS
      expenses_month_ars: expensesByCcy.ARS.current,
      expenses_prev_month_ars: expensesByCcy.ARS.prev,
      incomes_month_ars: incomesByCcy.ARS.current,
      incomes_prev_month_ars: incomesByCcy.ARS.prev,
      activities_month_count: activitiesRes.rows[0].count,
      recent_items: recentRes.rows,
    };

    // Optional: stock alerts (feature-gated)
    try {
      const { StockRepository } = await import('../domain/stock/stock.repository.js');
      const stockRepo = new StockRepository();
      const items = await stockRepo.getStockItems(userId);
      const lowStock = items.filter(i => i.min_stock && i.current_quantity <= i.min_stock);
      result.stock_alerts_count = lowStock.length;
    } catch { /* stock feature not available */ }

    // Optional: livestock total
    try {
      const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
      const livestockRepo = new LivestockRepository();
      const total = await livestockRepo.countTotal(userId, { fieldId });
      result.livestock_total = total;
    } catch { /* livestock feature not available */ }

    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Expense & Income routes ---

router.get('/expenses', requireAuth, requireFeature('expenses'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; dateFrom?: string; dateTo?: string; category?: string; expenseType?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.dateFrom && typeof req.query.dateFrom === 'string') filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo && typeof req.query.dateTo === 'string') filters.dateTo = req.query.dateTo;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;
    if (req.query.expenseType && typeof req.query.expenseType === 'string') filters.expenseType = req.query.expenseType;

    const result = await observationService.getUserExpenses(req.auth!.userId, page, limit, filters);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/incomes', requireAuth, requireFeature('incomes'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; dateFrom?: string; dateTo?: string; category?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.dateFrom && typeof req.query.dateFrom === 'string') filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo && typeof req.query.dateTo === 'string') filters.dateTo = req.query.dateTo;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;

    const result = await observationService.getUserIncomes(req.auth!.userId, page, limit, filters);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Activity routes ---

router.get('/activities', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; dateFrom?: string; dateTo?: string; eventType?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.dateFrom && typeof req.query.dateFrom === 'string') filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo && typeof req.query.dateTo === 'string') filters.dateTo = req.query.dateTo;
    if (req.query.eventType && typeof req.query.eventType === 'string') filters.eventType = req.query.eventType;

    const result = await observationService.getUserActivities(req.auth!.userId, page, limit, filters);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Edit routes ---

router.patch('/expenses/:id', requireAuth, requireFeature('expenses'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const result = await observationService.editExpense(id, req.auth!.userId, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/incomes/:id', requireAuth, requireFeature('incomes'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const result = await observationService.editIncome(id, req.auth!.userId, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/activities/:id', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const result = await observationService.editActivity(id, req.auth!.userId, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Observation routes ---

router.get('/observations/filters', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const fields = await observationService.getUserFieldsWithPlots(req.auth!.userId);
    res.json({ fields });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/observations', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; dateFrom?: string; dateTo?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.dateFrom && typeof req.query.dateFrom === 'string') filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo && typeof req.query.dateTo === 'string') filters.dateTo = req.query.dateTo;

    const result = await observationService.getUserObservations(req.auth!.userId, page, limit, filters);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/observations/:id', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      res.status(400).json({ error: 'El texto de la observación es obligatorio' });
      return;
    }
    const observationId = parseInt(String(req.params.id), 10);
    if (isNaN(observationId)) {
      res.status(400).json({ error: 'ID de observación inválido' });
      return;
    }
    const result = await observationService.editObservation(observationId, req.auth!.userId, text.trim());
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/observations/:id/history', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const observationId = parseInt(String(req.params.id), 10);
    if (isNaN(observationId)) {
      res.status(400).json({ error: 'ID de observación inválido' });
      return;
    }
    const history = await observationService.getObservationHistory(observationId, req.auth!.userId);
    res.json({ history });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Agro reports ---

router.get('/reports', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const { getReportsByUserId } = await import('../services/agro-report.js');
    const rows = await getReportsByUserId(req.auth!.userId);
    res.json({
      reports: rows.map((r: {
        id: number;
        field_id: number;
        plot_id: number | null;
        field_name: string | null;
        plot_name: string | null;
        week_number: number;
        year: number;
        created_at: Date;
      }) => ({
        id: r.id,
        fieldId: r.field_id,
        plotId: r.plot_id,
        fieldName: r.field_name,
        plotName: r.plot_name,
        weekNumber: r.week_number,
        year: r.year,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/reports/:id/pdf', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const reportId = parseInt(String(req.params.id), 10);
    if (isNaN(reportId)) {
      res.status(400).json({ error: 'ID de reporte inválido' });
      return;
    }
    const { getReportByIdForUser } = await import('../services/agro-report.js');
    const report = await getReportByIdForUser(reportId, req.auth!.userId);
    if (!report || !report.pdf_path) {
      res.status(404).json({ error: 'Reporte no encontrado' });
      return;
    }
    const fs = await import('fs');
    if (!fs.existsSync(report.pdf_path)) {
      res.status(410).json({ error: 'El archivo ya no está disponible (expiró o fue eliminado)' });
      return;
    }
    const scopeLabel = report.plot_name
      ? `${report.field_name || 'campo'}-${report.plot_name}`
      : (report.field_name || 'campo');
    res.download(report.pdf_path, `reporte-${scopeLabel}-W${report.week_number}-${report.year}.pdf`);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Crop scoutings ---

router.get('/scoutings', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const plotId = req.query.plotId ? parseInt(String(req.query.plotId), 10) : null;
    const fieldId = req.query.fieldId ? parseInt(String(req.query.fieldId), 10) : null;
    const dateFrom = (req.query.dateFrom as string) || null;
    const dateTo = (req.query.dateTo as string) || null;
    const minSeverity = req.query.minSeverity ? parseInt(String(req.query.minSeverity), 10) : null;
    const stageCode = (req.query.stageCode as string) || null;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 50));

    const { queryScoutings } = await import('../services/expenses.js');
    const rows = await queryScoutings({
      userId,
      plotId,
      fieldId,
      dateFrom,
      dateTo,
      minSeverity,
      stageCode,
      limit,
    });
    res.json({
      scoutings: rows.map((r: {
        id: number; plot_id: number; field_id: number | null; plot_crop_id: number | null;
        scouting_date: Date; stage_code: string | null;
        weed_coverage_pct: string | number | null; weed_species: string[] | null;
        pest_species: string | null; pest_severity_1_5: number | null; pest_affected_pct: string | number | null;
        soil_moisture_1_5: number | null; emergence_pct: string | number | null; plant_density_m2: string | number | null;
        notes: string | null; created_at: Date;
        plot_name: string | null; field_name: string | null; crop: string | null;
      }) => ({
        id: r.id,
        plotId: r.plot_id,
        fieldId: r.field_id,
        plotCropId: r.plot_crop_id,
        scoutingDate: r.scouting_date,
        stageCode: r.stage_code,
        weedCoveragePct: r.weed_coverage_pct != null ? Number(r.weed_coverage_pct) : null,
        weedSpecies: r.weed_species,
        pestSpecies: r.pest_species,
        pestSeverity: r.pest_severity_1_5,
        pestAffectedPct: r.pest_affected_pct != null ? Number(r.pest_affected_pct) : null,
        soilMoisture: r.soil_moisture_1_5,
        emergencePct: r.emergence_pct != null ? Number(r.emergence_pct) : null,
        plantDensityM2: r.plant_density_m2 != null ? Number(r.plant_density_m2) : null,
        notes: r.notes,
        createdAt: r.created_at,
        plotName: r.plot_name,
        fieldName: r.field_name,
        crop: r.crop,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Harvest loads (per truck, with humidity + quality) ---

router.get('/harvest-loads', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 50));

    const plotId = req.query.plotId ? parseInt(String(req.query.plotId), 10) : null;
    const fieldId = req.query.fieldId ? parseInt(String(req.query.fieldId), 10) : null;
    const desde = (req.query.dateFrom as string) || null;
    const hasta = (req.query.dateTo as string) || null;
    const driverName = (req.query.driver as string) || null;
    const destinatario = (req.query.destinatario as string) || null;

    const { queryHarvestLoads } = await import('../services/expenses.js');
    const allRows = await queryHarvestLoads(userId, {
      plotId: plotId && !isNaN(plotId) ? plotId : null,
      fieldId: fieldId && !isNaN(fieldId) ? fieldId : null,
      desde,
      hasta,
      driverName,
      destinatario,
    });

    const total = allRows.length;
    const offset = (page - 1) * limit;
    const slice = allRows.slice(offset, offset + limit);

    res.json({
      data: slice.map((r) => ({
        id: r.id,
        driverName: r.driver_name,
        weightKg: Number(r.weight_kg),
        destination: r.destination,
        destinatario: r.destinatario,
        truckPlate: r.truck_plate,
        notes: r.notes,
        humidityPct: r.humidity_pct != null ? Number(r.humidity_pct) : null,
        qualityMetrics: r.quality_metrics,
        eventDate: r.event_date,
        crop: r.crop,
        plotName: r.plot_name,
        fieldName: r.field_name,
        createdAt: r.created_at,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Stock routes ---

router.get('/stock', requireAuth, requireFeature('stock'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; warehouseId?: number; category?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const warehouseId = parseInt(String(req.query.warehouseId), 10);
    if (!isNaN(warehouseId)) filters.warehouseId = warehouseId;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;

    const { StockRepository } = await import('../domain/stock/stock.repository.js');
    const repo = new StockRepository();
    const items = await repo.getStockItems(req.auth!.userId, filters.fieldId, filters.warehouseId);

    // Filter by category in-memory (small dataset)
    const filtered = filters.category ? items.filter(i => i.category === filters.category) : items;

    // Paginate
    const total = filtered.length;
    const offset = (page - 1) * limit;
    const pageItems = filtered.slice(offset, offset + limit);

    res.json({
      items: pageItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/warehouses', requireAuth, requireFeature('stock'), async (req: Request, res: Response) => {
  try {
    const { StockRepository } = await import('../domain/stock/stock.repository.js');
    const repo = new StockRepository();
    const warehouses = await repo.getAccessibleWarehouses(req.auth!.userId);
    res.json({
      warehouses: warehouses.map(w => ({
        id: w.id,
        name: w.name,
        fieldId: w.field_id,
        fieldName: (w as { field_name?: string }).field_name ?? null,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/stock/:id/movements', requireAuth, requireFeature('stock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { StockRepository } = await import('../domain/stock/stock.repository.js');
    const repo = new StockRepository();

    const item = await repo.getStockItemById(id);
    if (!item) { res.status(404).json({ error: 'Producto no encontrado' }); return; }

    const movements = await repo.getMovements(id, 50);
    res.json({ item, movements });
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/stock/:id', requireAuth, requireFeature('stock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const pool = (await import('../services/db.js')).default;
    const sets: string[] = ['updated_at = NOW()'];
    const params: (string | number | null)[] = [];
    let idx = 0;

    const { name, category, unit, min_stock } = req.body;
    if (name !== undefined) { idx++; sets.push(`name = $${idx}`); params.push(name); }
    if (category !== undefined) { idx++; sets.push(`category = $${idx}`); params.push(category); }
    if (unit !== undefined) { idx++; sets.push(`unit = $${idx}`); params.push(unit); }
    if (min_stock !== undefined) { idx++; sets.push(`min_stock = $${idx}`); params.push(min_stock); }

    idx++;
    const result = await pool.query(
      `UPDATE stock_items SET ${sets.join(', ')} WHERE id = $${idx} AND deleted_at IS NULL RETURNING *`,
      [...params, id]
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Producto no encontrado' }); return; }
    res.json(result.rows[0]);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Livestock routes ---

router.get('/livestock', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; corralId?: number; category?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    const corralId = parseInt(String(req.query.corralId), 10);
    if (!isNaN(corralId)) filters.corralId = corralId;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;

    const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
    const repo = new LivestockRepository();
    const groups = await repo.listGroups(req.auth!.userId, filters as {
      fieldId?: number; plotId?: number; corralId?: number; category?: import('../domain/livestock/livestock.types.js').LivestockCategory;
    });
    const total = await repo.countTotal(req.auth!.userId, { fieldId: filters.fieldId, plotId: filters.plotId, corralId: filters.corralId });

    const offset = (page - 1) * limit;
    const pageItems = groups.slice(offset, offset + limit);

    res.json({
      items: pageItems,
      totalAnimals: total,
      totalGroups: groups.length,
      page,
      limit,
      totalPages: Math.ceil(groups.length / limit),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/livestock/movements', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const offset = (page - 1) * limit;

    const opts: {
      fieldId?: number;
      plotId?: number;
      corralId?: number;
      category?: import('../domain/livestock/livestock.types.js').LivestockCategory;
      movementType?: import('../domain/livestock/livestock.types.js').LivestockMovementType;
      desde?: string;
      hasta?: string;
      limit: number;
      offset: number;
    } = { limit, offset };

    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) opts.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) opts.plotId = plotId;
    const corralId = parseInt(String(req.query.corralId), 10);
    if (!isNaN(corralId)) opts.corralId = corralId;
    if (req.query.category && typeof req.query.category === 'string') {
      opts.category = req.query.category as import('../domain/livestock/livestock.types.js').LivestockCategory;
    }
    if (req.query.movementType && typeof req.query.movementType === 'string') {
      opts.movementType = req.query.movementType as import('../domain/livestock/livestock.types.js').LivestockMovementType;
    }
    if (req.query.desde && typeof req.query.desde === 'string') opts.desde = req.query.desde;
    if (req.query.hasta && typeof req.query.hasta === 'string') opts.hasta = req.query.hasta;

    const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
    const repo = new LivestockRepository();
    const { rows, total } = await repo.listMovements(req.auth!.userId, opts);

    res.json({
      items: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/livestock/events', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const eventType = String(req.query.type || '');
    const allowed = new Set(['health_event', 'repro_event', 'weighing']);
    if (!allowed.has(eventType)) {
      res.status(400).json({ error: 'type debe ser health_event | repro_event | weighing' });
      return;
    }

    const fieldId = req.query.fieldId ? parseInt(String(req.query.fieldId), 10) : null;
    const plotId = req.query.plotId ? parseInt(String(req.query.plotId), 10) : null;
    const corralId = req.query.corralId ? parseInt(String(req.query.corralId), 10) : null;
    const category = (req.query.category as string) || null;
    const subtype = (req.query.subtype as string) || null;
    const desde = (req.query.desde as string) || null;
    const hasta = (req.query.hasta as string) || null;
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit), 10) || 100));

    const { queryLivestockEvents } = await import('../services/expenses.js');
    const rows = await queryLivestockEvents(req.auth!.userId, eventType, {
      fieldId: fieldId && !isNaN(fieldId) ? fieldId : null,
      plotId: plotId && !isNaN(plotId) ? plotId : null,
      corralId: corralId && !isNaN(corralId) ? corralId : null,
      category,
      subtype,
      desde,
      hasta,
      limit,
    });

    res.json({
      data: rows.map((r: {
        id: number; event_date: Date; event_type: string;
        product: string | null; product_type: string | null;
        quantity: string | number | null; unit: string | null; implement: string | null;
        animal_category: string | null; animals_affected: number | null;
        notes: string | null; created_at: Date;
        plot_id: number | null; plot_name: string | null;
        field_name: string | null; corral_name: string | null; feedlot_name: string | null;
      }) => ({
        id: r.id,
        eventDate: r.event_date,
        eventType: r.event_type,
        subtype: r.product_type,
        product: r.product,
        quantity: r.quantity != null ? Number(r.quantity) : null,
        unit: r.unit,
        implement: r.implement,
        category: r.animal_category,
        animalsAffected: r.animals_affected,
        notes: r.notes,
        createdAt: r.created_at,
        plotId: r.plot_id,
        plotName: r.plot_name,
        fieldName: r.field_name,
        corralName: r.corral_name,
        feedlotName: r.feedlot_name,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/livestock/:id/movements', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
    const repo = new LivestockRepository();

    const group = await repo.getGroupById(id);
    if (!group) { res.status(404).json({ error: 'Grupo de hacienda no encontrado' }); return; }

    // Access control: group must belong to an accessible field
    const { FieldSharingService } = await import('../domain/sharing/field-sharing.service.js');
    const sharing = new FieldSharingService();
    const canAccess = await sharing.isFieldAccessible(asUserId(req.auth!.userId), group.field_id);
    if (!canAccess) { res.status(403).json({ error: 'Sin acceso a este grupo' }); return; }

    const movements = await repo.getMovementsForGroup(id, 50);
    res.json({ group, movements });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/livestock/filters', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const fields = await observationService.getUserFieldsWithPlots(req.auth!.userId);
    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const feedlotRepo = new FeedlotRepository();
    const feedlots = await feedlotRepo.listFeedlots(asUserId(req.auth!.userId));
    const corrals = await feedlotRepo.listCorralsByUser(asUserId(req.auth!.userId));
    res.json({
      fields,
      feedlots,
      corrals,
      categories: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'],
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/livestock/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!id) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
    const repo = new LivestockRepository();

    const group = await repo.getGroupById(id);
    if (!group) { res.status(404).json({ error: 'Grupo no encontrado' }); return; }

    // Access control
    const { FieldSharingService } = await import('../domain/sharing/field-sharing.service.js');
    const sharing = new FieldSharingService();
    const canAccess = await sharing.isFieldAccessible(asUserId(req.auth!.userId), group.field_id);
    if (!canAccess) { res.status(403).json({ error: 'Sin acceso a este grupo' }); return; }

    const { breed, avg_weight_kg, notes } = req.body;
    await repo.updateGroupMetadata(id, { breed, avg_weight_kg, notes });
    const updated = await repo.getGroupById(id);
    res.json(updated);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Feedlot & Corral routes ---

router.get('/feedlots', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();
    const feedlots = await repo.listFeedlots(asUserId(req.auth!.userId));
    res.json({ items: feedlots });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/feedlots', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { name, fieldId, capacity, notes } = req.body;
    if (!name || !fieldId) { res.status(400).json({ error: 'name y fieldId son requeridos' }); return; }

    // Access control
    const { FieldSharingService } = await import('../domain/sharing/field-sharing.service.js');
    const sharing = new FieldSharingService();
    const canAccess = await sharing.isFieldAccessible(asUserId(req.auth!.userId), fieldId);
    if (!canAccess) { res.status(403).json({ error: 'Sin acceso a este campo' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();
    const feedlot = await repo.createFeedlot(asUserId(req.auth!.userId), fieldId, name, { capacity, notes });
    res.status(201).json(feedlot);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('ya tiene un feedlot')) {
      res.status(409).json({ error: err.message });
      return;
    }
    handleError(err, res);
  }
});

router.patch('/feedlots/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    // Verify feedlot exists and user has access
    const feedlots = await repo.listFeedlots(asUserId(req.auth!.userId));
    const feedlot = feedlots.find(f => f.id === id);
    if (!feedlot) { res.status(404).json({ error: 'Feedlot no encontrado' }); return; }

    const { name, capacity, notes } = req.body;
    await pool.query(
      `UPDATE feedlots SET name = COALESCE($1, name), capacity = COALESCE($2, capacity), notes = COALESCE($3, notes), updated_at = NOW() WHERE id = $4`,
      [name || null, capacity ?? null, notes ?? null, id],
    );
    res.json({ success: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/feedlots/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    const feedlots = await repo.listFeedlots(asUserId(req.auth!.userId));
    const feedlot = feedlots.find(f => f.id === id);
    if (!feedlot) { res.status(404).json({ error: 'Feedlot no encontrado' }); return; }

    await repo.deleteFeedlot(id);
    res.json({ success: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/feedlots/:id/corrals', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const feedlotId = parseInt(String(req.params.id), 10);
    if (isNaN(feedlotId)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    // Access control via feedlot list
    const feedlots = await repo.listFeedlots(asUserId(req.auth!.userId));
    const feedlot = feedlots.find(f => f.id === feedlotId);
    if (!feedlot) { res.status(404).json({ error: 'Feedlot no encontrado' }); return; }

    const corrals = await repo.listCorrals(feedlotId);
    res.json({ items: corrals });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/corrals', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { name, feedlotId, capacity, notes } = req.body;
    if (!name || !feedlotId) { res.status(400).json({ error: 'name y feedlotId son requeridos' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    // Access control via feedlot
    const feedlots = await repo.listFeedlots(asUserId(req.auth!.userId));
    const feedlot = feedlots.find(f => f.id === feedlotId);
    if (!feedlot) { res.status(403).json({ error: 'Sin acceso a este feedlot' }); return; }

    const corral = await repo.createCorral(feedlotId, name, { capacity, notes });
    res.status(201).json(corral);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('ya existe')) {
      res.status(409).json({ error: err.message });
      return;
    }
    handleError(err, res);
  }
});

router.patch('/corrals/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    // Access control via corral list
    const corrals = await repo.listCorralsByUser(asUserId(req.auth!.userId));
    const corral = corrals.find(c => c.id === id);
    if (!corral) { res.status(404).json({ error: 'Corral no encontrado' }); return; }

    const { name, capacity, notes } = req.body;
    await pool.query(
      `UPDATE corrals SET name = COALESCE($1, name), capacity = COALESCE($2, capacity), notes = COALESCE($3, notes), updated_at = NOW() WHERE id = $4`,
      [name || null, capacity ?? null, notes ?? null, id],
    );
    res.json({ success: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/corrals/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { FeedlotRepository } = await import('../domain/feedlot/feedlot.repository.js');
    const repo = new FeedlotRepository();

    const corrals = await repo.listCorralsByUser(asUserId(req.auth!.userId));
    const corral = corrals.find(c => c.id === id);
    if (!corral) { res.status(404).json({ error: 'Corral no encontrado' }); return; }

    await repo.deleteCorral(id);
    res.json({ success: true });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Document routes ---

router.get('/documents', requireAuth, requireFeature('documents'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const filters: Record<string, string> = {};
    if (req.query.documentType && typeof req.query.documentType === 'string') filters.documentType = req.query.documentType;
    if (req.query.desde && typeof req.query.desde === 'string') filters.desde = req.query.desde;
    if (req.query.hasta && typeof req.query.hasta === 'string') filters.hasta = req.query.hasta;

    const { DocumentRepository } = await import('../domain/documents/document.repository.js');
    const repo = new DocumentRepository();
    const { rows, total } = await repo.getUserDocuments(req.auth!.userId, page, limit, filters);

    res.json({
      data: rows,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/documents/filters', requireAuth, requireFeature('documents'), async (req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT document_type FROM documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY document_type`,
      [req.auth!.userId],
    );
    res.json({ documentTypes: result.rows.map(r => r.document_type) });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/documents/:id', requireAuth, requireFeature('documents'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { DocumentRepository } = await import('../domain/documents/document.repository.js');
    const repo = new DocumentRepository();
    const doc = await repo.findById(id, req.auth!.userId);
    if (!doc) { res.status(404).json({ error: 'Documento no encontrado' }); return; }
    res.json(doc);
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/documents/:id/file', requireAuth, requireFeature('documents'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }

    const { DocumentService } = await import('../domain/documents/document.service.js');
    const svc = new DocumentService();
    const file = await svc.getDocumentFile(id, req.auth!.userId);
    if (!file) { res.status(404).json({ error: 'Archivo no encontrado' }); return; }

    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `inline; filename="${file.filename}"`);
    res.send(file.buffer);
  } catch (err) {
    handleError(err, res);
  }
});

// --- Analytics (charts) ---

router.get('/analytics', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldIdRaw = req.query.field_id;
    const fieldId = typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN;
    if (isNaN(fieldId)) {
      res.status(400).json({ error: 'field_id query parameter is required' });
      return;
    }

    // Monthly trend - last 6 months
    const { rows: monthlyTrend } = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '5 months',
           date_trunc('month', NOW()),
           '1 month'
         )::date AS month_start
       )
       SELECT
         to_char(m.month_start, 'YYYY-MM') AS month,
         to_char(m.month_start, 'Mon') AS label,
         COALESCE((
           SELECT SUM(amount) FROM expenses
           WHERE user_id = $1 AND deleted_at IS NULL AND currency = 'ARS'
             AND expense_date >= m.month_start
             AND expense_date < m.month_start + interval '1 month'
             AND (field_id = $2 OR plot_id IN (SELECT id FROM plots WHERE field_id = $2))
         ), 0)::numeric AS expenses,
         COALESCE((
           SELECT SUM(amount) FROM incomes
           WHERE user_id = $1 AND deleted_at IS NULL AND currency = 'ARS'
             AND income_date >= m.month_start
             AND income_date < m.month_start + interval '1 month'
             AND (field_id = $2 OR plot_id IN (SELECT id FROM plots WHERE field_id = $2))
         ), 0)::numeric AS incomes
       FROM months m
       ORDER BY m.month_start`,
      [userId, fieldId]
    );

    // Rainfall - last 30 days
    const { rows: rainfallDaily } = await pool.query(
      `SELECT r.rainfall_date::text AS date,
              to_char(r.rainfall_date, 'DD/MM') AS label,
              SUM(r.millimeters)::numeric AS mm
         FROM rainfall r
         JOIN fields f ON f.id = r.field_id
        WHERE f.user_id = $1 AND f.deleted_at IS NULL
          AND r.rainfall_date >= CURRENT_DATE - interval '30 days'
          AND r.field_id = $2
        GROUP BY r.rainfall_date
        ORDER BY r.rainfall_date`,
      [userId, fieldId]
    );

    // Expense breakdown - current month, grouped by (plot, category, currency).
    // Frontend filters by currency in the donut UI; mixing ARS+USD in one
    // pie would be misleading.
    const { rows: expenseBreakdown } = await pool.query(
      `SELECT
         e.plot_id,
         p.name AS plot_name,
         f.name AS field_name,
         COALESCE(e.category, 'Sin categoría') AS category,
         COALESCE(e.currency, 'ARS') AS currency,
         SUM(e.amount)::numeric AS total
       FROM expenses e
       LEFT JOIN plots p ON p.id = e.plot_id
       LEFT JOIN fields f ON f.id = COALESCE(e.field_id, p.field_id)
       WHERE e.user_id = $1
         AND e.deleted_at IS NULL
         AND date_trunc('month', e.expense_date) = date_trunc('month', NOW())
         AND COALESCE(e.field_id, p.field_id) = $2
       GROUP BY e.plot_id, p.name, f.name, e.category, e.currency
       ORDER BY total DESC`,
      [userId, fieldId]
    );

    // Income breakdown - same shape as expenses (per plot, per category, per currency).
    const { rows: incomeBreakdown } = await pool.query(
      `SELECT
         i.plot_id,
         p.name AS plot_name,
         f.name AS field_name,
         COALESCE(i.category, 'Sin categoría') AS category,
         COALESCE(i.currency, 'ARS') AS currency,
         SUM(i.amount)::numeric AS total
       FROM incomes i
       LEFT JOIN plots p ON p.id = i.plot_id
       LEFT JOIN fields f ON f.id = COALESCE(i.field_id, p.field_id)
       WHERE i.user_id = $1
         AND i.deleted_at IS NULL
         AND date_trunc('month', i.income_date) = date_trunc('month', NOW())
         AND COALESCE(i.field_id, p.field_id) = $2
       GROUP BY i.plot_id, p.name, f.name, i.category, i.currency
       ORDER BY total DESC`,
      [userId, fieldId]
    );

    res.json({
      monthlyTrend: monthlyTrend.map(r => ({
        month: r.month,
        label: r.label,
        expenses: Number(r.expenses),
        incomes: Number(r.incomes),
      })),
      rainfallDaily: rainfallDaily.map(r => ({
        date: r.date,
        label: r.label,
        mm: Number(r.mm),
      })),
      expenseBreakdown: expenseBreakdown.map(r => ({
        plotId: r.plot_id,
        plotName: r.plot_name,
        fieldName: r.field_name,
        category: r.category,
        currency: r.currency,
        total: Number(r.total),
      })),
      incomeBreakdown: incomeBreakdown.map(r => ({
        plotId: r.plot_id,
        plotName: r.plot_name,
        fieldName: r.field_name,
        category: r.category,
        currency: r.currency,
        total: Number(r.total),
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/analytics/agronomic', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldIdRaw = req.query.field_id;
    const fieldId = typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN;
    if (isNaN(fieldId)) {
      res.status(400).json({ error: 'field_id query parameter is required' });
      return;
    }

    // Last 12 months of rainfall, monthly total in mm
    const { rows: rainfallMonthly } = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '11 months',
           date_trunc('month', NOW()),
           '1 month'
         )::date AS month_start
       )
       SELECT
         to_char(m.month_start, 'YYYY-MM') AS month,
         to_char(m.month_start, 'Mon') AS label,
         COALESCE((
           SELECT SUM(r.millimeters)::numeric
           FROM rainfall r
           JOIN fields f ON f.id = r.field_id
           WHERE f.user_id = $1
             AND f.deleted_at IS NULL
             AND r.rainfall_date >= m.month_start
             AND r.rainfall_date < m.month_start + interval '1 month'
             AND r.field_id = $2
         ), 0) AS mm
       FROM months m
       ORDER BY m.month_start`,
      [userId, fieldId]
    );

    // Last 12 months of harvest events — yield computed from quantity / area
    const { rows: harvestsMonthly } = await pool.query(
      `WITH harvests AS (
         SELECT
           e.event_date,
           e.crop,
           p.name AS plot_name,
           p.area_hectares,
           (e.quantity * CASE LOWER(COALESCE(e.unit, 'kg'))
                           WHEN 'tn' THEN 1000
                           WHEN 'tonelada' THEN 1000
                           WHEN 'toneladas' THEN 1000
                           WHEN 't' THEN 1000
                           WHEN 'qq' THEN 100
                           WHEN 'quintal' THEN 100
                           WHEN 'quintales' THEN 100
                           ELSE 1
                         END)::numeric AS quantity_kg
         FROM domain_events e
         JOIN plots p ON p.id = e.plot_id AND p.deleted_at IS NULL
         WHERE e.user_id = $1
           AND e.event_type = 'harvest'
           AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
           AND e.quantity IS NOT NULL
           AND p.field_id = $2
       )
       SELECT
         to_char(date_trunc('month', event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', event_date), 'Mon')    AS label,
         crop,
         plot_name,
         quantity_kg AS total_kg,
         CASE WHEN area_hectares > 0 THEN (quantity_kg / area_hectares)::numeric ELSE NULL END AS yield_kg_per_ha
       FROM harvests
       ORDER BY event_date`,
      [userId, fieldId]
    );

    // Latest scouting per plot (joined with field for the map)
    const { rows: scoutingByPlot } = await pool.query(
      `SELECT DISTINCT ON (s.plot_id)
         s.plot_id,
         p.name AS plot_name,
         f.id AS field_id,
         f.name AS field_name,
         f.latitude AS field_lat,
         f.longitude AS field_lng,
         s.weed_coverage_pct,
         s.weed_species,
         s.pest_species,
         s.pest_severity_1_5,
         s.scouting_date
       FROM crop_scoutings s
       JOIN plots p ON p.id = s.plot_id AND p.deleted_at IS NULL
       JOIN fields f ON f.id = p.field_id
       WHERE s.user_id = $1
         AND s.deleted_at IS NULL
         AND f.deleted_at IS NULL
         AND p.field_id = $2
       ORDER BY s.plot_id, s.scouting_date DESC, s.id DESC`,
      [userId, fieldId]
    );

    // Average kg/ha by crop, last 12 months
    const { rows: yieldByCrop } = await pool.query(
      `SELECT
         e.crop,
         AVG(
           (e.quantity * CASE LOWER(COALESCE(e.unit, 'kg'))
                           WHEN 'tn' THEN 1000
                           WHEN 'tonelada' THEN 1000
                           WHEN 'toneladas' THEN 1000
                           WHEN 't' THEN 1000
                           WHEN 'qq' THEN 100
                           WHEN 'quintal' THEN 100
                           WHEN 'quintales' THEN 100
                           ELSE 1
                         END) / NULLIF(p.area_hectares, 0)
         )::numeric AS avg_kg_per_ha,
         COUNT(*)::int AS harvests
       FROM domain_events e
       JOIN plots p ON p.id = e.plot_id AND p.deleted_at IS NULL
       WHERE e.user_id = $1
         AND e.event_type = 'harvest'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND e.quantity IS NOT NULL
         AND p.area_hectares > 0
         AND e.crop IS NOT NULL
         AND p.field_id = $2
       GROUP BY e.crop
       ORDER BY avg_kg_per_ha DESC NULLS LAST`,
      [userId, fieldId]
    );

    // Harvest loads with humidity AND quality_metrics, last 12 months
    const { rows: harvestQualityLoads } = await pool.query(
      `SELECT
         hl.id AS load_id,
         e.crop,
         hl.humidity_pct,
         hl.quality_metrics,
         p.name AS plot_name,
         e.event_date AS harvested_at
       FROM harvest_loads hl
       JOIN domain_events e ON e.id = hl.domain_event_id
       LEFT JOIN plots p ON p.id = e.plot_id AND p.deleted_at IS NULL
       WHERE e.user_id = $1
         AND e.event_type = 'harvest'
         AND hl.humidity_pct IS NOT NULL
         AND hl.quality_metrics IS NOT NULL
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND p.field_id = $2
       ORDER BY e.event_date DESC`,
      [userId, fieldId]
    );

    res.json({
      rainfallMonthly: rainfallMonthly.map(r => ({
        month: r.month,
        label: r.label,
        mm: Number(r.mm),
      })),
      harvestsMonthly: harvestsMonthly.map(r => ({
        month: r.month,
        label: r.label,
        crop: r.crop ?? null,
        plotName: r.plot_name ?? null,
        totalKg: r.total_kg !== null ? Number(r.total_kg) : null,
        yieldKgPerHa: r.yield_kg_per_ha !== null ? Number(r.yield_kg_per_ha) : null,
      })),
      scoutingByPlot: scoutingByPlot.map(r => ({
        plotId: r.plot_id,
        plotName: r.plot_name,
        fieldId: r.field_id,
        fieldName: r.field_name,
        fieldLat: r.field_lat !== null ? Number(r.field_lat) : null,
        fieldLng: r.field_lng !== null ? Number(r.field_lng) : null,
        weedCoveragePct: r.weed_coverage_pct !== null ? Number(r.weed_coverage_pct) : null,
        weedSpecies: r.weed_species ?? [],
        pestSpecies: r.pest_species ?? null,
        pestSeverity1to5: r.pest_severity_1_5 !== null ? Number(r.pest_severity_1_5) : null,
        scoutedAt: r.scouting_date,
      })),
      yieldByCrop: yieldByCrop.map(r => ({
        crop: r.crop,
        avgKgPerHa: r.avg_kg_per_ha !== null ? Number(r.avg_kg_per_ha) : null,
        harvests: Number(r.harvests),
      })),
      harvestQualityLoads: harvestQualityLoads.map(r => ({
        loadId: r.load_id,
        crop: r.crop ?? null,
        humidityPct: Number(r.humidity_pct),
        quality: r.quality_metrics ?? {},
        plotName: r.plot_name ?? null,
        harvestedAt: r.harvested_at,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/analytics/livestock', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldIdRaw = req.query.field_id;
    const fieldId = typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN;
    if (isNaN(fieldId)) {
      res.status(400).json({ error: 'field_id query parameter is required' });
      return;
    }

    // Current stock summed by category
    const { rows: stockByCategory } = await pool.query(
      `SELECT category::text AS category, SUM(count)::int AS headcount
       FROM livestock_groups
       WHERE user_id = $1 AND deleted_at IS NULL AND field_id = $2
       GROUP BY category
       ORDER BY headcount DESC`,
      [userId, fieldId]
    );

    // Monthly net movements per category, last 12 months. Convention:
    // entrada / nacimiento → +count to dest category
    // salida   / muerte    → -count from source category
    // For transfer / recategorizacion we use the dest category for the +,
    // and the source category for the -.
    const { rows: monthlyDelta } = await pool.query(
      `WITH months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '11 months',
           date_trunc('month', NOW()),
           '1 month'
         )::date AS month_start
       ),
       moves AS (
         SELECT
           date_trunc('month', m.movement_date)::date AS month_start,
           CASE
             WHEN m.movement_type IN ('entrada','nacimiento') THEN (SELECT category::text FROM livestock_groups WHERE id = m.dest_group_id)
             WHEN m.movement_type IN ('salida','muerte') THEN (SELECT category::text FROM livestock_groups WHERE id = m.source_group_id)
             WHEN m.movement_type IN ('transferencia','recategorizacion','ajuste') THEN (SELECT category::text FROM livestock_groups WHERE id = COALESCE(m.dest_group_id, m.source_group_id))
           END AS category,
           CASE
             WHEN m.movement_type IN ('entrada','nacimiento','transferencia','recategorizacion','ajuste') THEN m.count
             ELSE -m.count
           END AS delta
         FROM livestock_movements m
         WHERE m.user_id = $1
           AND m.movement_date >= date_trunc('month', NOW()) - interval '11 months'
           AND (
             (m.source_group_id IS NOT NULL AND EXISTS (SELECT 1 FROM livestock_groups WHERE id = m.source_group_id AND field_id = $2))
             OR
             (m.dest_group_id IS NOT NULL AND EXISTS (SELECT 1 FROM livestock_groups WHERE id = m.dest_group_id AND field_id = $2))
           )
       )
       SELECT
         to_char(months.month_start, 'YYYY-MM') AS month,
         to_char(months.month_start, 'Mon') AS label,
         moves.category,
         COALESCE(SUM(moves.delta), 0)::int AS delta
       FROM months
       LEFT JOIN moves ON moves.month_start = months.month_start
       GROUP BY months.month_start, moves.category
       ORDER BY months.month_start, moves.category`,
      [userId, fieldId]
    );

    // Per-group weight curve for groups currently in any corral, last 12 months
    const { rows: feedlotWeightCurve } = await pool.query(
      `SELECT
         g.id AS group_id,
         g.category::text AS category,
         g.breed,
         c.name AS corral_name,
         e.event_date,
         e.quantity::numeric AS avg_weight_kg
       FROM domain_events e
       JOIN corrals c ON c.id = e.corral_id
       JOIN livestock_groups g
         ON g.corral_id = c.id
        AND g.category::text = e.animal_category
        AND g.deleted_at IS NULL
       WHERE e.user_id = $1
         AND e.event_type = 'weighing'
         AND e.event_date >= NOW() - interval '12 months'
         AND e.quantity IS NOT NULL
         AND g.field_id = $2
       ORDER BY g.id, e.event_date`,
      [userId, fieldId]
    );

    // Latest avg weight per category, only weighings from last 90 days
    const { rows: avgWeightByCategory } = await pool.query(
      `SELECT DISTINCT ON (e.animal_category)
         e.animal_category::text AS category,
         e.quantity::numeric AS avg_weight_kg,
         e.event_date AS last_weighed_at
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'weighing'
         AND e.event_date >= CURRENT_DATE - interval '90 days'
         AND e.animal_category IS NOT NULL
         AND e.quantity IS NOT NULL
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = $2))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = $2))
         )
       ORDER BY e.animal_category, e.event_date DESC`,
      [userId, fieldId]
    );

    // Health events by month + sub-type, last 12 months
    const { rows: healthEventsMonthly } = await pool.query(
      `SELECT
         to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', e.event_date), 'Mon') AS label,
         e.product_type AS type,
         COUNT(*)::int AS n
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'health_event'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = $2))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = $2))
         )
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId, fieldId]
    );

    // Repro events by month + sub-type, last 12 months
    const { rows: reproEventsMonthly } = await pool.query(
      `SELECT
         to_char(date_trunc('month', e.event_date), 'YYYY-MM') AS month,
         to_char(date_trunc('month', e.event_date), 'Mon') AS label,
         e.product_type AS type,
         COUNT(*)::int AS n
       FROM domain_events e
       WHERE e.user_id = $1
         AND e.event_type = 'repro_event'
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = $2))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = $2))
         )
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId, fieldId]
    );

    // Feedlot occupancy per corral
    const { rows: feedlotOccupancy } = await pool.query(
      `SELECT
         c.id AS corral_id,
         c.name AS corral_name,
         c.capacity,
         COALESCE(SUM(g.count), 0)::int AS current_headcount
       FROM corrals c
       JOIN feedlots f ON f.id = c.feedlot_id AND f.field_id = $2
       LEFT JOIN livestock_groups g
         ON g.corral_id = c.id
        AND g.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
         AND f.user_id = $1
         AND f.deleted_at IS NULL
       GROUP BY c.id, c.name, c.capacity
       ORDER BY c.name`,
      [userId, fieldId]
    );

    // Stitch monthly deltas into the headcount trend (one row per month with byCategory map).
    // We don't reconstruct historic stock here — we expose the *deltas*, which is enough
    // for an area chart of monthly movement. (Computing historic stock would require
    // running totals back to time 0; not needed for the dashboard.)
    const trendMap = new Map<string, { month: string; label: string; byCategory: Record<string, number> }>();
    for (const r of monthlyDelta) {
      const key = r.month;
      const existing: { month: string; label: string; byCategory: Record<string, number> } = trendMap.get(key) ?? { month: r.month, label: r.label, byCategory: {} };
      if (r.category) existing.byCategory[r.category] = (existing.byCategory[r.category] ?? 0) + Number(r.delta);
      trendMap.set(key, existing);
    }

    // Stitch monthly health/repro event counts into the same per-month-by-type shape.
    const eventsToMonthly = (rows: Array<{ month: string; label: string; type: string | null; n: number }>) => {
      const map = new Map<string, { month: string; label: string; byType: Record<string, number> }>();
      for (const r of rows) {
        const k = r.month;
        const ex = map.get(k) ?? { month: r.month, label: r.label, byType: {} };
        if (r.type) ex.byType[r.type] = (ex.byType[r.type] ?? 0) + Number(r.n);
        map.set(k, ex);
      }
      return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
    };

    // Group feedlot points into per-group time series
    const groupMap = new Map<string, { groupId: string; groupLabel: string; corralName: string; points: Array<{ date: string; avgWeightKg: number }> }>();
    for (const r of feedlotWeightCurve) {
      const id = String(r.group_id);
      const ex: { groupId: string; groupLabel: string; corralName: string; points: Array<{ date: string; avgWeightKg: number }> } = groupMap.get(id) ?? {
        groupId: id,
        groupLabel: `${r.category}${r.breed ? ' ' + r.breed : ''}`,
        corralName: r.corral_name,
        points: [],
      };
      ex.points.push({ date: r.event_date, avgWeightKg: Number(r.avg_weight_kg) });
      groupMap.set(id, ex);
    }

    res.json({
      stockByCategory: stockByCategory.map(r => ({ category: r.category, headcount: Number(r.headcount) })),
      headcountTrendMonthly: [...trendMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
      feedlotWeightCurve: [...groupMap.values()],
      avgWeightByCategory: avgWeightByCategory.map(r => ({
        category: r.category,
        avgWeightKg: Number(r.avg_weight_kg),
        lastWeighedAt: r.last_weighed_at,
      })),
      healthEventsMonthly: eventsToMonthly(healthEventsMonthly as Array<{ month: string; label: string; type: string | null; n: number }>),
      reproEventsMonthly: eventsToMonthly(reproEventsMonthly as Array<{ month: string; label: string; type: string | null; n: number }>),
      feedlotOccupancy: feedlotOccupancy.map(r => ({
        corralId: Number(r.corral_id),
        corralName: r.corral_name,
        capacity: r.capacity !== null ? Number(r.capacity) : null,
        currentHeadcount: Number(r.current_headcount),
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Map data ---

router.get('/map-data', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;

    const { rows: fields } = await pool.query(
      `SELECT f.id, f.name, f.lat, f.lng, f.polygon, f.city
         FROM fields f
        WHERE (f.user_id = $1 OR f.id IN (SELECT field_id FROM field_members WHERE user_id = $1))
          AND f.deleted_at IS NULL
        ORDER BY f.name`,
      [userId]
    );

    const { rows: plots } = await pool.query(
      `SELECT p.id, p.name, p.field_id, p.area_hectares,
              pc.crop AS active_crop, pc.start_date AS crop_start_date,
              CASE
                WHEN pc.id IS NOT NULL AND pc.harvested_at IS NULL THEN 'active'
                WHEN pc.id IS NOT NULL AND pc.harvested_at IS NOT NULL AND pc.end_date IS NULL THEN 'harvested'
                ELSE 'idle'
              END AS crop_status
         FROM plots p
         LEFT JOIN LATERAL (
           SELECT id, crop, start_date, harvested_at, end_date
             FROM plot_crops
            WHERE plot_id = p.id AND end_date IS NULL
            ORDER BY start_date DESC
            LIMIT 1
         ) pc ON true
        WHERE p.field_id IN (SELECT id FROM fields WHERE (user_id = $1 OR id IN (SELECT field_id FROM field_members WHERE user_id = $1)) AND deleted_at IS NULL)
          AND p.deleted_at IS NULL
        ORDER BY p.name`,
      [userId]
    );

    res.json({
      fields: fields.map(f => ({
        id: f.id,
        name: f.name,
        lat: f.lat ? Number(f.lat) : null,
        lng: f.lng ? Number(f.lng) : null,
        polygon: f.polygon,
        city: f.city,
      })),
      plots: plots.map(p => ({
        id: p.id,
        name: p.name,
        fieldId: p.field_id,
        areaHectares: p.area_hectares ? Number(p.area_hectares) : null,
        activeCrop: p.active_crop,
        cropStatus: p.crop_status,
      })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Push notification routes ---

router.get('/push/vapid-key', requireAuth, async (_req: Request, res: Response) => {
  try {
    const { PushNotificationService } = await import('../services/push-notification.service.js');
    const svc = new PushNotificationService();
    res.json({ publicKey: svc.getVapidPublicKey() });
  } catch (err) {
    handleError(err, res);
  }
});

router.post('/push/subscribe', requireAuth, async (req: Request, res: Response) => {
  try {
    const { PushNotificationService } = await import('../services/push-notification.service.js');
    const svc = new PushNotificationService();
    await svc.subscribe(req.auth!.userId, req.body);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/push/unsubscribe', requireAuth, async (req: Request, res: Response) => {
  try {
    const { PushNotificationService } = await import('../services/push-notification.service.js');
    const svc = new PushNotificationService();
    await svc.unsubscribe(req.auth!.userId, req.body.endpoint);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

function handleError(err: unknown, res: Response): void {
  if (err instanceof AuthError || err instanceof ObservationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof VerificationError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AccountDeletionError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof SubscriptionError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof PasswordRecoveryError || err instanceof EmailVerificationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('Auth route error:', err);
  logError('auth', 'ROUTE_ERROR', err as Error);
  res.status(500).json({ error: 'Error interno del servidor' });
}

export default router;
