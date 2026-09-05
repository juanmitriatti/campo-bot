import { Router } from 'express';
import bcrypt from 'bcrypt';
import { AuthService, AuthError } from '../domain/auth/auth.service.js';
import { ObservationService, ObservationError } from '../domain/auth/observation.service.js';
import { ChannelVerificationService, VerificationError } from '../domain/auth/channel-verification.service.js';
import { AccountDeletionService, AccountDeletionError } from '../domain/auth/account-deletion.service.js';
import { PasswordRecoveryService, PasswordRecoveryError } from '../domain/auth/password-recovery.service.js';
import { TokenRepository } from '../domain/auth/token.repository.js';
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
import { CategoryRepository, type CategoryKind } from '../domain/financial/category.repository.js';
import { CategoryService } from '../domain/financial/category.service.js';
import { asUserId } from '../types/index.js';
import type { FeatureKey } from '../types/index.js';
import { sqlNormalizedName } from '../utils/entity-matcher.js';
import { invalidateUserContext } from '../ai/user-context.service.js';
import { resolveCampaign, recentCampaigns } from '../utils/campaign-range.js';
import { getOverview, resolveFieldIds, monthLabel } from '../services/overview.service.js';
import { getReviewFindings } from '../services/review-findings.service.js';

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
const categoryRepo = new CategoryRepository();
const categoryService = new CategoryService(categoryRepo);
const tokenRepository = new TokenRepository();

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

// --- Perfil (Mi cuenta): nombre / ciudad / email ---
router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : undefined;
    // FIX M1: guardar el email tal como lo tipea el usuario (solo .trim()),
    // NO lowercasearlo — el login es case-sensitive y toLowerCase aquí lockea al usuario.
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : undefined;
    const lastName = typeof req.body?.last_name === 'string' ? req.body.last_name.trim() : undefined;
    // Ciudad validada contra el censo (paridad con el bot): exact → nombre oficial + provincia;
    // sin match → se guarda tal cual y el response lo señala (cityWarning).
    let cityProvince: string | null = null;
    let cityWarning: string | null = null;
    let cityResolved = city;
    if (city) {
      const { localidadLookup } = await import('../services/localidad-lookup.service.js');
      const lk = localidadLookup.lookup(city);
      if (lk.status === 'exact' || lk.status === 'disambiguate') {
        cityResolved = lk.matches[0].nombre;
        cityProvince = lk.matches[0].provincia;
      } else {
        cityWarning = 'No encontré esa localidad en el censo — la guardé tal cual, pero el clima puede no encontrarla.';
      }
    }
    if (name === '') { res.status(400).json({ error: 'El nombre no puede quedar vacío.' }); return; }
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Ese email no parece válido.' }); return;
    }
    if (name === undefined && city === undefined && email === undefined && lastName === undefined) {
      res.status(400).json({ error: 'Nada para actualizar.' }); return;
    }
    let emailChanged = false;
    if (email !== undefined) {
      const cur = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.auth!.userId]);
      // Comparación case-insensitive para detectar si cambió (pero guardamos verbatim)
      emailChanged = (cur.rows[0]?.email ?? '').toLowerCase() !== email.toLowerCase();
      if (emailChanged) {
        // Dup-check case-insensitive: LOWER ambos lados, NO pasamos email lowercased
        const dup = await pool.query(`SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2`, [email, req.auth!.userId]);
        if (dup.rows.length > 0) { res.status(409).json({ error: 'Ese email ya está en uso.' }); return; }
      }
    }
    const sets: string[] = []; const vals: unknown[] = [];
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (city !== undefined) {
      vals.push(cityResolved || null); sets.push(`city = $${vals.length}`);
      if (cityProvince) { vals.push(cityProvince); sets.push(`province = $${vals.length}`); }
    }
    if (lastName !== undefined) { vals.push(lastName || null); sets.push(`last_name = $${vals.length}`); }
    if (email !== undefined && emailChanged) {
      vals.push(email); sets.push(`email = $${vals.length}`);
      sets.push(`email_verified_at = NULL`); // el banner de verificación se re-dispara
    }
    if (sets.length === 0) { res.json({ user: null, unchanged: true }); return; }
    vals.push(req.auth!.userId);
    let r;
    try {
      r = await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING id, name, last_name, city, email`,
        vals,
      );
    } catch (dbErr: unknown) {
      // FIX M4: race entre dos requests que compiten por el mismo email → 409 en lugar de 500
      if ((dbErr as { code?: string }).code === '23505') {
        res.status(409).json({ error: 'Ese email ya está en uso.' });
        return;
      }
      throw dbErr;
    }
    if (r.rows.length === 0) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    console.log(`[account] perfil actualizado user=${req.auth!.userId}${emailChanged ? ' (email cambiado, verificación reseteada)' : ''}`);
    res.json({ user: r.rows[0] });
  } catch (err) { handleError(err, res); }
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

/**
 * Campaign-scoped Resumen. `field_id` accepts a numeric id or "all";
 * `season` accepts a season year ("2025") or a label ("25/26"), defaulting to
 * the current campaign. See services/overview.service.ts for why this is a
 * separate endpoint from /dashboard.
 */
router.get('/overview', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldId = parseFieldIdParam(req.query.field_id);
    if (fieldId === undefined) {
      res.status(400).json({ error: 'field_id query parameter is required (or use "all")' });
      return;
    }
    const range = resolveCampaign(req.query.season);
    const fieldIds = await resolveFieldIds(userId, fieldId);
    // Rows with no field and no plot count only under "Todos los campos".
    const payload = await getOverview(userId, fieldIds, range, { includeUnassigned: fieldId == null });
    res.json({
      ...payload,
      campaigns: recentCampaigns().map(c => ({ seasonYear: c.seasonYear, label: c.label })),
    });
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * "Para revisar" — deterministic checks over what the bot saved. Advisory only:
 * a failing rule degrades to fewer findings, never to a broken Resumen.
 */
router.get('/review', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldId = parseFieldIdParam(req.query.field_id);
    if (fieldId === undefined) {
      res.status(400).json({ error: 'field_id query parameter is required (or use "all")' });
      return;
    }
    const range = resolveCampaign(req.query.season);
    const fieldIds = await resolveFieldIds(userId, fieldId);
    const findings = await getReviewFindings({ userId, fieldIds, range });
    res.json({ findings });
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

// --- Campos y lotes (tab Campos del dashboard) ---

router.get('/fields-tree', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.city, f.location_method, (f.latitude IS NOT NULL) AS has_coords,
              f.renspa, f.cuig, f.senasa_titular,
              COALESCE(json_agg(json_build_object(
                'id', p.id, 'name', p.name, 'hectares', p.area_hectares,
                'activeCrop', (SELECT pc.crop FROM plot_crops pc WHERE pc.plot_id = p.id AND pc.end_date IS NULL ORDER BY pc.id DESC LIMIT 1)
              ) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS plots
       FROM fields f
       LEFT JOIN plots p ON p.field_id = f.id AND p.deleted_at IS NULL
       WHERE f.user_id = $1 AND f.deleted_at IS NULL
       GROUP BY f.id ORDER BY f.name`,
      [req.auth!.userId],
    );
    res.json({ fields: rows });
  } catch (err) { handleError(err, res); }
});

// GET /localidades?q= — typeahead del censo (4027 localidades) para inputs de ubicación.
router.get('/localidades', requireAuth, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) { res.json({ status: 'not_found', matches: [] }); return; }
    const { localidadLookup } = await import('../services/localidad-lookup.service.js');
    const result = localidadLookup.lookup(q);
    res.json({
      status: result.status,
      matches: result.matches.slice(0, 8).map(m => ({
        nombre: m.nombre, provincia: m.provincia, departamento: m.departamento,
      })),
    });
  } catch (err) { handleError(err, res); }
});

// POST /fields — alta manual de campo desde el dashboard (espejo del add_field del bot:
// dup-check case-insensitive, localidadLookup para ciudad/provincia, membership de owner).
router.post('/fields', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const cityRaw = typeof req.body?.city === 'string' ? req.body.city.trim() : '';
    if (!name) { res.status(400).json({ error: 'El nombre del campo es obligatorio.' }); return; }
    if (name.length > 100) { res.status(400).json({ error: 'El nombre es demasiado largo (máx. 100).' }); return; }
    const dup = await pool.query(
      `SELECT 1 FROM fields WHERE user_id = $1 AND LOWER(name) = LOWER($2) AND deleted_at IS NULL`,
      [req.auth!.userId, name],
    );
    if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya tenés un campo con ese nombre.' }); return; }

    const { getOrCreateField, setFieldCity } = await import('../services/expenses.js');
    const field = await getOrCreateField(req.auth!.userId, name);

    let cityStored: string | null = null;
    if (cityRaw) {
      const { localidadLookup } = await import('../services/localidad-lookup.service.js');
      const lookup = localidadLookup.lookup(cityRaw);
      if (lookup.status === 'exact' || lookup.status === 'disambiguate') {
        const loc = lookup.matches[0];
        await setFieldCity(req.auth!.userId, name, loc.nombre, loc.provincia);
        cityStored = loc.nombre;
      } else {
        // Sin match en el censo: guardamos el texto tal cual (igual que el bot en bulk)
        await setFieldCity(req.auth!.userId, name, cityRaw, null);
        cityStored = cityRaw;
      }
    }
    res.status(201).json({ field: { id: field.id, name: field.name, city: cityStored } });
  } catch (err) { handleError(err, res); }
});

router.patch('/fields/:id', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const cityIn = typeof req.body?.city === 'string' ? req.body.city.trim() : undefined;
    // Datos sanitarios del establecimiento. Se guardan como texto SIN validar el
    // formato: la máscara exacta de RENSPA y CUIG no está publicada en fuente
    // oficial primaria, y rechazar el número real de un productor por una
    // máscara inventada es peor que no validar (ver docs/ganaderia/senasa.md).
    const senasaKeys = ['renspa', 'cuig', 'senasa_titular'] as const;
    const senasaIn: Partial<Record<typeof senasaKeys[number], string>> = {};
    for (const k of senasaKeys) {
      if (typeof req.body?.[k] === 'string') senasaIn[k] = String(req.body[k]).trim().slice(0, 120);
    }
    const hasSenasa = Object.keys(senasaIn).length > 0;

    if (isNaN(id) || (name === undefined && cityIn === undefined && !hasSenasa) || name === '') {
      res.status(400).json({ error: 'Nada para actualizar' }); return;
    }
    if (name !== undefined) {
      // Unicidad case/acento-insensible dentro del usuario (entity-matcher)
      const dup = await pool.query(
        `SELECT 1 FROM fields WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL
         AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$3::text')}`,
        [req.auth!.userId, id, name],
      );
      if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya tenés un campo con ese nombre' }); return; }
    }

    // Ciudad validada contra el censo (paridad con el bot). Match → nombre oficial +
    // provincia + coords (COALESCE: no pisa mapa/GPS). Sin match → texto tal cual + warning.
    let cityWarning: string | null = null;
    const sets: string[] = []; const vals: unknown[] = [];
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (cityIn !== undefined) {
      if (cityIn === '') {
        sets.push(`city = NULL`);
      } else {
        const { localidadLookup } = await import('../services/localidad-lookup.service.js');
        const lk = localidadLookup.lookup(cityIn);
        if (lk.status === 'exact' || lk.status === 'disambiguate') {
          const loc = lk.matches[0];
          vals.push(loc.nombre); sets.push(`city = $${vals.length}`);
          vals.push(loc.provincia); sets.push(`province = $${vals.length}`);
          const coords = localidadLookup.coordsFor(loc.nombre, loc.provincia);
          if (coords) {
            vals.push(coords.lat); sets.push(`latitude = COALESCE(latitude, $${vals.length})`);
            vals.push(coords.lon); sets.push(`longitude = COALESCE(longitude, $${vals.length})`);
          }
        } else {
          vals.push(cityIn); sets.push(`city = $${vals.length}`);
          cityWarning = 'No encontré esa localidad en el censo — la guardé tal cual, pero el clima puede no encontrarla.';
        }
      }
    }
    for (const k of senasaKeys) {
      if (senasaIn[k] === undefined) continue;
      if (senasaIn[k] === '') { sets.push(`${k} = NULL`); continue; }
      vals.push(senasaIn[k]); sets.push(`${k} = $${vals.length}`);
    }
    vals.push(id); vals.push(req.auth!.userId);
    const r = await pool.query(
      `UPDATE fields SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND user_id = $${vals.length} AND deleted_at IS NULL
       RETURNING id, name, city, renspa, cuig, senasa_titular`,
      vals,
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Campo no encontrado' }); return; }
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json({ field: r.rows[0], cityWarning });
  } catch (err) { handleError(err, res); }
});

// Alta de lote desde el tab Campos del dashboard (Jul 2026)
router.post('/fields/:id/plots', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const fieldId = parseInt(String(req.params.id), 10);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const hectares = req.body?.hectares != null ? Number(req.body.hectares) : null;
    if (isNaN(fieldId) || !name) { res.status(400).json({ error: 'Nombre inválido' }); return; }
    if (hectares !== null && (!isFinite(hectares) || hectares <= 0 || hectares > 100000)) {
      res.status(400).json({ error: 'Hectáreas inválidas (0 a 100.000)' }); return;
    }
    const own = await pool.query(
      `SELECT 1 FROM fields WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [fieldId, req.auth!.userId],
    );
    if (own.rows.length === 0) { res.status(404).json({ error: 'Campo no encontrado' }); return; }
    // Unicidad case/acento-insensible dentro del campo (entity-matcher)
    const dup = await pool.query(
      `SELECT 1 FROM plots WHERE field_id = $1 AND deleted_at IS NULL
       AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$2::text')}`,
      [fieldId, name],
    );
    if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya hay un lote con ese nombre en ese campo' }); return; }
    const r = await pool.query(
      `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, $3)
       RETURNING id, name, area_hectares AS hectares`,
      [fieldId, name, hectares],
    );
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.status(201).json({ plot: r.rows[0] });
  } catch (err) { handleError(err, res); }
});

router.patch('/plots/:id', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const hectares = req.body?.hectares != null ? Number(req.body.hectares) : undefined;
    if (name === '') { res.status(400).json({ error: 'Nombre inválido' }); return; }
    if (hectares !== undefined && (!isFinite(hectares) || hectares <= 0 || hectares > 100000)) {
      res.status(400).json({ error: 'Hectáreas inválidas (0 a 100.000)' }); return;
    }
    if (name === undefined && hectares === undefined) { res.status(400).json({ error: 'Nada para actualizar' }); return; }
    // Ownership via JOIN + field_id para la unicidad
    const own = await pool.query(
      `SELECT p.field_id FROM plots p JOIN fields f ON f.id = p.field_id
       WHERE p.id = $1 AND f.user_id = $2 AND p.deleted_at IS NULL`,
      [id, req.auth!.userId],
    );
    if (own.rows.length === 0) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
    if (name !== undefined) {
      const dup = await pool.query(
        `SELECT 1 FROM plots WHERE field_id = $1 AND id <> $2 AND deleted_at IS NULL
         AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$3::text')}`,
        [own.rows[0].field_id, id, name],
      );
      if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya hay un lote con ese nombre en ese campo' }); return; }
    }
    const sets: string[] = []; const vals: unknown[] = [];
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (hectares !== undefined) { vals.push(hectares); sets.push(`area_hectares = $${vals.length}`); }
    vals.push(id);
    vals.push(req.auth!.userId);
    const r = await pool.query(
      `UPDATE plots SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND field_id IN (SELECT id FROM fields WHERE user_id = $${vals.length} AND deleted_at IS NULL) RETURNING id, name, area_hectares`,
      vals,
    );
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json({ plot: r.rows[0] });
  } catch (err) { handleError(err, res); }
});

// --- Soft-delete de registros (paridad con "borrá el último gasto" del bot) ---

router.delete('/expenses/:id', requireAuth, requireFeature('expenses'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE expenses SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Gasto no encontrado' }); return; }
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
});

router.delete('/incomes/:id', requireAuth, requireFeature('incomes'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE incomes SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Ingreso no encontrado' }); return; }
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
});

router.delete('/activities/:id', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE domain_events SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Actividad no encontrada' }); return; }
    // Invalidar caché de contexto: el validador anti-alucinación trabaja con la lista vieja hasta 60s
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
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
    const crop = (req.query.crop as string) || null;
    const humidityMinPct = req.query.humidityMin ? parseFloat(String(req.query.humidityMin)) : null;
    const humidityMaxPct = req.query.humidityMax ? parseFloat(String(req.query.humidityMax)) : null;

    const { queryHarvestLoads } = await import('../services/expenses.js');
    const allRows = await queryHarvestLoads(userId, {
      plotId: plotId && !isNaN(plotId) ? plotId : null,
      fieldId: fieldId && !isNaN(fieldId) ? fieldId : null,
      desde,
      hasta,
      driverName,
      destinatario,
      crop,
      humidityMinPct: humidityMinPct != null && !isNaN(humidityMinPct) ? humidityMinPct : null,
      humidityMaxPct: humidityMaxPct != null && !isNaN(humidityMaxPct) ? humidityMaxPct : null,
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

    // Antes hacía `(await import('../services/db.js')).default` — ese módulo no
    // existe (el pool vive en config/db.js y se exporta nombrado, sin default),
    // así que este PATCH reventaba con ERR_MODULE_NOT_FOUND. `pool` ya está
    // importado arriba; el const local solo lo tapaba.
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
    const typedFilters = filters as {
      fieldId?: number; plotId?: number; corralId?: number; category?: import('../domain/livestock/livestock.types.js').LivestockCategory;
    };
    const offset = (page - 1) * limit;

    // Paginación EN LA BASE: traer todos los grupos para cortarlos en memoria no
    // escala una vez que un usuario tiene miles de grupos.
    const [pageItems, totalGroups, total] = await Promise.all([
      repo.listGroups(req.auth!.userId, { ...typedFilters, limit, offset }),
      repo.countGroups(req.auth!.userId, typedFilters),
      repo.countTotal(req.auth!.userId, { fieldId: filters.fieldId, plotId: filters.plotId, corralId: filters.corralId }),
    ]);

    res.json({
      items: pageItems,
      totalAnimals: total,
      totalGroups,
      page,
      limit,
      totalPages: Math.ceil(totalGroups / limit),
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

// --- Animales individuales (capa híbrida, invariante 16) ---
//
// Mismo feature gate que el resto de hacienda: es la misma función del producto.
// Todo scopeado por user_id EN LA QUERY — los ids llegan del cliente y no se
// confía en ellos.

/** GET /animals — listado paginado con filtros. */
router.get('/animals', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 25));

    const filters: Record<string, unknown> = {};
    const num = (v: unknown) => { const n = parseInt(String(v), 10); return isNaN(n) ? undefined : n; };
    if (req.query.status) filters.status = String(req.query.status);
    else filters.status = 'activo';
    if (req.query.category) filters.category = String(req.query.category);
    if (req.query.sex) filters.sex = String(req.query.sex);
    if (num(req.query.breed_id) !== undefined) filters.breedId = num(req.query.breed_id);
    if (num(req.query.field_id) !== undefined) filters.fieldId = num(req.query.field_id);
    if (num(req.query.plot_id) !== undefined) filters.plotId = num(req.query.plot_id);
    if (num(req.query.corral_id) !== undefined) filters.corralId = num(req.query.corral_id);
    if (req.query.group_id) filters.groupId = String(req.query.group_id);
    if (req.query.identified === 'true') filters.identified = true;
    if (req.query.identified === 'false') filters.identified = false;

    const { AnimalService } = await import('../domain/livestock/animal.service.js');
    const service = new AnimalService();
    const userId = req.auth!.userId;

    const [items, total] = await Promise.all([
      service.list(userId, { ...filters, limit, offset: (page - 1) * limit } as never),
      service.count(userId, filters as never),
    ]);

    res.json({ items, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /animals/lookup?ref=... — resolver una caravana a su animal. */
router.get('/animals/lookup', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const ref = String(req.query.ref ?? '').trim();
    if (!ref) { res.status(400).json({ error: 'Falta el parámetro ref' }); return; }

    const { AnimalService } = await import('../domain/livestock/animal.service.js');
    const animal = await new AnimalService().findByIdentifier(req.auth!.userId, ref);
    if (!animal) { res.status(404).json({ error: 'No encontré ningún animal con esa caravana' }); return; }
    res.json(animal);
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /animals/consistency — discrepancias del modelo híbrido (advisory). */
router.get('/animals/consistency', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { AnimalService } = await import('../domain/livestock/animal.service.js');
    res.json({ issues: await new AnimalService().findInconsistencies(req.auth!.userId) });
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /animals/breeds — catálogo canónico para los selects del front. */
router.get('/animals/breeds', requireAuth, requireFeature('livestock'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, name, kind FROM livestock_breeds WHERE is_active ORDER BY sort_order, name`,
    );
    res.json({ breeds: rows });
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /animals/:id — ficha completa + identificaciones. */
router.get('/animals/:id', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { AnimalService } = await import('../domain/livestock/animal.service.js');
    const service = new AnimalService();
    const userId = req.auth!.userId;

    const animal = await service.getById(userId, String(req.params.id));
    if (!animal) { res.status(404).json({ error: 'Animal no encontrado' }); return; }

    const [identifications, weights] = await Promise.all([
      service.getIdentificationHistory(userId, animal.id),
      service.getWeightGain(userId, animal.id),
    ]);
    res.json({ animal, identifications, weights });
  } catch (err) {
    handleError(err, res);
  }
});

/** GET /animals/:id/timeline — línea de tiempo, keyset. */
router.get('/animals/:id/timeline', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { AnimalService } = await import('../domain/livestock/animal.service.js');
    const service = new AnimalService();
    const userId = req.auth!.userId;

    const animal = await service.getById(userId, String(req.params.id));
    if (!animal) { res.status(404).json({ error: 'Animal no encontrado' }); return; }

    const events = await service.getTimeline(userId, animal.id, {
      limit: Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 50)),
      beforeDate: req.query.before_date ? String(req.query.before_date) : undefined,
      beforeId: req.query.before_id ? String(req.query.before_id) : undefined,
    });
    res.json({ events });
  } catch (err) {
    handleError(err, res);
  }
});

/** POST /animals — alta individual. */
router.post('/animals', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { category, rfid, visual_tag, sex, breed, birth_date, field_id, plot_id, corral_id, group_id, origin, notes } = req.body ?? {};
    if (!category) { res.status(400).json({ error: 'Falta la categoría' }); return; }

    const { AnimalService, DuplicateIdentifierError } = await import('../domain/livestock/animal.service.js');
    try {
      const result = await new AnimalService().registerAnimal({
        userId: req.auth!.userId,
        category, sex: sex ?? null, rfid: rfid ?? null, visualTag: visual_tag ?? null,
        breed: breed ?? null, birthDate: birth_date ?? null,
        fieldId: field_id ?? null, plotId: plot_id ?? null, corralId: corral_id ?? null,
        groupId: group_id ?? null, origin: origin ?? 'alta_manual', notes: notes ?? null,
        source: 'manual', createdBy: req.auth!.userId,
      });
      // El agente cachea el contexto del usuario 60s; sin esto, un animal dado
      // de alta por el dashboard no existe para el bot hasta que expire.
      invalidateUserContext(asUserId(req.auth!.userId));
      res.status(201).json(result);
    } catch (e) {
      if (e instanceof DuplicateIdentifierError) {
        res.status(409).json({ error: e.message, existingAnimalId: e.existingAnimalId });
        return;
      }
      throw e;
    }
  } catch (err) {
    handleError(err, res);
  }
});

/** POST /animals/:id/identifications — asignar o reemplazar caravana. */
router.post('/animals/:id/identifications', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { value, id_type, reason, device_type } = req.body ?? {};
    if (!value) { res.status(400).json({ error: 'Falta el valor de la caravana' }); return; }

    const { AnimalService, DuplicateIdentifierError } = await import('../domain/livestock/animal.service.js');
    const service = new AnimalService();
    const userId = req.auth!.userId;

    const animal = await service.getById(userId, String(req.params.id));
    if (!animal) { res.status(404).json({ error: 'Animal no encontrado' }); return; }

    try {
      const result = await service.replaceIdentification({
        userId, animalId: animal.id, newValue: String(value),
        idType: id_type, reason, deviceType: device_type,
        source: 'manual', createdBy: userId,
      });
      invalidateUserContext(asUserId(userId));
      res.status(201).json(result);
    } catch (e) {
      if (e instanceof DuplicateIdentifierError) {
        res.status(409).json({ error: e.message, existingAnimalId: e.existingAnimalId });
        return;
      }
      throw e;
    }
  } catch (err) {
    handleError(err, res);
  }
});

/**
 * POST /animals/import — preview de un CSV/lista. NO aplica nada.
 *
 * Acepta `{ values: string[] }` o `{ text: "..." }`. El parseo de columnas
 * completo (raza, sexo, fecha de nacimiento) es P1; hoy importa las caravanas y
 * las resuelve contra el padrón, que es lo que habilita el movimiento masivo.
 */
router.post('/animals/import', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { values, text, intended_action } = req.body ?? {};
    const { AnimalBatchService } = await import('../domain/livestock/animal-batch.service.js');
    const batches = new AnimalBatchService();
    const userId = req.auth!.userId;

    const MAX_ROWS = 5000;
    let result;
    if (Array.isArray(values)) {
      if (values.length > MAX_ROWS) { res.status(413).json({ error: `Máximo ${MAX_ROWS} filas por importación` }); return; }
      result = await batches.createFromValues(userId, values.map(String), {
        source: 'csv_import', intendedAction: intended_action ?? 'movimiento', createdBy: userId,
      });
    } else if (typeof text === 'string') {
      if (text.length > 500_000) { res.status(413).json({ error: 'Archivo demasiado grande' }); return; }
      result = await batches.createFromText(userId, text, {
        source: 'csv_import', intendedAction: intended_action ?? 'movimiento', createdBy: userId,
      });
    } else {
      res.status(400).json({ error: 'Mandá `values` (array) o `text` (string)' });
      return;
    }

    const { batch, resolution } = result;
    res.json({
      batchId: batch.id,
      summary: {
        raw: resolution.rawCount,
        matched: resolution.matched.length,
        unknown: resolution.unknown.length,
        duplicates: resolution.duplicates.length,
        invalid: resolution.invalid.length,
      },
      matched: resolution.matched.map((m) => ({
        value: m.value,
        animalId: m.animal.id,
        category: m.animal.category,
        location: m.animal.plot_name ?? m.animal.corral_name ?? m.animal.field_name ?? null,
      })),
      unknown: resolution.unknown,
      invalid: resolution.invalid,
      duplicates: resolution.duplicates,
    });
  } catch (err) {
    handleError(err, res);
  }
});

/** POST /animals/batches/:id/apply — aplica el lote como movimiento. Idempotente. */
router.post('/animals/batches/:id/apply', requireAuth, requireFeature('livestock'), async (req: Request, res: Response) => {
  try {
    const { plot_id, corral_id, field_id, label } = req.body ?? {};
    if (!plot_id && !corral_id) { res.status(400).json({ error: 'Indicá un lote o un corral de destino' }); return; }

    const { AnimalBatchService } = await import('../domain/livestock/animal-batch.service.js');
    const result = await new AnimalBatchService().applyAsMove(req.auth!.userId, String(req.params.id), {
      fieldId: field_id ?? null, plotId: plot_id ?? null, corralId: corral_id ?? null, label,
    });

    if (!result.applied) {
      res.status(result.alreadyApplied ? 409 : 404).json({
        error: result.alreadyApplied ? 'Ese lote ya fue aplicado' : 'Lote no encontrado o vencido',
        alreadyApplied: result.alreadyApplied,
      });
      return;
    }
    invalidateUserContext(asUserId(req.auth!.userId));
    res.json(result);
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

router.get('/analytics/agronomic', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const fieldIdRaw = req.query.field_id;
    const allFields = fieldIdRaw === 'all';
    const singleFieldId = allFields ? null : (typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN);
    if (!allFields && (singleFieldId === null || isNaN(singleFieldId))) {
      res.status(400).json({ error: 'field_id query parameter is required (or use "all")' });
      return;
    }
    // Resolve target field IDs: single, or all user's fields when field_id=all.
    let targetFieldIds: number[];
    if (allFields) {
      const { rows: ownFields } = await pool.query(
        `SELECT id FROM fields WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      targetFieldIds = ownFields.map(r => Number(r.id));
      if (targetFieldIds.length === 0) targetFieldIds = [-1]; // no match, harmless
    } else {
      targetFieldIds = [singleFieldId as number];
    }

    // Same campaign window as the Resumen: the picker above the tabs has to
    // mean the same thing on every tab, and a "last 12 months" chart next to a
    // campaign result quietly disagreed with it.
    const range = resolveCampaign(req.query.season);
    const win = [userId, targetFieldIds, range.from, range.to];

    // Rainfall per month of the campaign, in mm
    const { rows: rainfallMonthly } = await pool.query(
      `WITH months AS (
         SELECT generate_series($3::date, $4::date, '1 month')::date AS month_start
       )
       SELECT
         to_char(m.month_start, 'YYYY-MM') AS month,
         COALESCE((
           SELECT SUM(r.millimeters)::numeric
           FROM rainfall r
           JOIN fields f ON f.id = r.field_id
           WHERE f.user_id = $1
             AND f.deleted_at IS NULL
             AND r.rainfall_date >= m.month_start
             AND r.rainfall_date < m.month_start + interval '1 month'
             AND r.field_id = ANY($2::int[])
         ), 0) AS mm
       FROM months m
       ORDER BY m.month_start`,
      win
    );

    // Last 12 months of harvest events — yield computed from quantity / area.
    // Quantity falls back to SUM(harvest_loads.weight_kg) when the event itself
    // has no aggregate quantity (users often record per-truck loads only).
    const { rows: harvestsMonthly } = await pool.query(
      `WITH harvests AS (
         SELECT
           e.event_date,
           e.crop,
           p.name AS plot_name,
           p.area_hectares,
           COALESCE(
             e.quantity * CASE LOWER(COALESCE(e.unit, 'kg'))
                            WHEN 'tn' THEN 1000
                            WHEN 'tonelada' THEN 1000
                            WHEN 'toneladas' THEN 1000
                            WHEN 't' THEN 1000
                            WHEN 'qq' THEN 100
                            WHEN 'quintal' THEN 100
                            WHEN 'quintales' THEN 100
                            ELSE 1
                          END,
             (SELECT SUM(hl.weight_kg) FROM harvest_loads hl WHERE hl.domain_event_id = e.id),
             pc.yield_kg
           )::numeric AS quantity_kg
         FROM domain_events e
         JOIN plots p ON p.id = e.plot_id AND p.deleted_at IS NULL
         LEFT JOIN plot_crops pc ON pc.id = e.plot_crop_id
         WHERE e.user_id = $1
           AND e.event_type = 'harvest'
           AND e.deleted_at IS NULL
           AND e.event_date BETWEEN $3::date AND $4::date
           AND (e.quantity IS NOT NULL OR pc.yield_kg IS NOT NULL OR EXISTS (SELECT 1 FROM harvest_loads hl WHERE hl.domain_event_id = e.id))
           AND p.field_id = ANY($2::int[])
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
      win
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
         AND p.field_id = ANY($2::int[])
       ORDER BY s.plot_id, s.scouting_date DESC, s.id DESC`,
      [userId, targetFieldIds]
    );

    // Average kg/ha by crop, last 12 months. Same quantity fallback as
    // harvestsMonthly: when the event has no aggregate quantity, fall back
    // to SUM(harvest_loads.weight_kg) for that event.
    const { rows: yieldByCrop } = await pool.query(
      `WITH events_kg AS (
         SELECT
           e.crop,
           p.area_hectares,
           COALESCE(
             e.quantity * CASE LOWER(COALESCE(e.unit, 'kg'))
                            WHEN 'tn' THEN 1000
                            WHEN 'tonelada' THEN 1000
                            WHEN 'toneladas' THEN 1000
                            WHEN 't' THEN 1000
                            WHEN 'qq' THEN 100
                            WHEN 'quintal' THEN 100
                            WHEN 'quintales' THEN 100
                            ELSE 1
                          END,
             (SELECT SUM(hl.weight_kg) FROM harvest_loads hl WHERE hl.domain_event_id = e.id),
             pc.yield_kg
           )::numeric AS quantity_kg
         FROM domain_events e
         JOIN plots p ON p.id = e.plot_id AND p.deleted_at IS NULL
         LEFT JOIN plot_crops pc ON pc.id = e.plot_crop_id
         WHERE e.user_id = $1
           AND e.event_type = 'harvest'
           AND e.deleted_at IS NULL
           AND e.event_date BETWEEN $3::date AND $4::date
           AND (e.quantity IS NOT NULL OR pc.yield_kg IS NOT NULL OR EXISTS (SELECT 1 FROM harvest_loads hl WHERE hl.domain_event_id = e.id))
           AND p.area_hectares > 0
           AND e.crop IS NOT NULL
           AND p.field_id = ANY($2::int[])
       )
       SELECT
         crop,
         AVG(quantity_kg / NULLIF(area_hectares, 0))::numeric AS avg_kg_per_ha,
         COUNT(*)::int AS harvests
       FROM events_kg
       WHERE quantity_kg IS NOT NULL
       GROUP BY crop
       ORDER BY avg_kg_per_ha DESC NULLS LAST`,
      win
    );

    // Campos → lotes → cultivos activos (end_date IS NULL). Alimenta el
    // Treemap de la vista agronómica. El LEFT JOIN devuelve N filas por lote
    // si algún día hay más de un cultivo activo — el agrupado ya lo soporta.
    const { rows: fieldPlotCropsRows } = await pool.query(
      `SELECT
         f.id AS field_id,
         f.name AS field_name,
         p.id AS plot_id,
         p.name AS plot_name,
         p.area_hectares,
         pc.crop,
         pc.sowed_hectares
       FROM fields f
       JOIN plots p ON p.field_id = f.id AND p.deleted_at IS NULL
       LEFT JOIN plot_crops pc ON pc.plot_id = p.id AND pc.end_date IS NULL
       WHERE f.user_id = $1
         AND f.deleted_at IS NULL
         AND f.id = ANY($2::int[])
       ORDER BY f.name, p.name, pc.crop`,
      [userId, targetFieldIds]
    );
    const fieldPlotCropsMap = new Map<number, {
      fieldId: number; fieldName: string;
      plots: Map<number, { plotId: number; plotName: string; hectares: number | null; crops: Array<{ crop: string; hectares: number | null }> }>;
    }>();
    for (const r of fieldPlotCropsRows) {
      const fid = Number(r.field_id);
      if (!fieldPlotCropsMap.has(fid)) {
        fieldPlotCropsMap.set(fid, { fieldId: fid, fieldName: r.field_name, plots: new Map() });
      }
      const field = fieldPlotCropsMap.get(fid)!;
      const pid = Number(r.plot_id);
      if (!field.plots.has(pid)) {
        field.plots.set(pid, {
          plotId: pid,
          plotName: r.plot_name,
          hectares: r.area_hectares !== null ? Number(r.area_hectares) : null,
          crops: [],
        });
      }
      if (r.crop) {
        field.plots.get(pid)!.crops.push({
          crop: r.crop,
          hectares: r.sowed_hectares !== null ? Number(r.sowed_hectares) : null,
        });
      }
    }
    const fieldPlotCrops = [...fieldPlotCropsMap.values()].map(f => ({
      fieldId: f.fieldId,
      fieldName: f.fieldName,
      plots: [...f.plots.values()],
    }));

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
         AND e.deleted_at IS NULL
         AND hl.humidity_pct IS NOT NULL
         AND hl.quality_metrics IS NOT NULL
         AND e.event_date BETWEEN $3::date AND $4::date
         AND p.field_id = ANY($2::int[])
       ORDER BY e.event_date DESC`,
      win
    );

    res.json({
      campaign: { seasonYear: range.seasonYear, label: range.label, from: range.from, to: range.to },
      rainfallMonthly: rainfallMonthly.map(r => ({
        month: r.month,
        label: monthLabel(r.month),
        mm: Number(r.mm),
      })),
      harvestsMonthly: harvestsMonthly.map(r => ({
        month: r.month,
        label: monthLabel(r.month),
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
      fieldPlotCrops,
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
    const allFields = fieldIdRaw === 'all';
    const singleFieldId = allFields ? null : (typeof fieldIdRaw === 'string' ? parseInt(fieldIdRaw, 10) : NaN);
    if (!allFields && (singleFieldId === null || isNaN(singleFieldId))) {
      res.status(400).json({ error: 'field_id query parameter is required (or use "all")' });
      return;
    }
    // Resolve target field IDs: single, or all user's fields when field_id=all.
    let targetFieldIds: number[];
    if (allFields) {
      const { rows: ownFields } = await pool.query(
        `SELECT id FROM fields WHERE user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      targetFieldIds = ownFields.map(r => Number(r.id));
      if (targetFieldIds.length === 0) targetFieldIds = [-1]; // no match, harmless
    } else {
      targetFieldIds = [singleFieldId as number];
    }

    // Current stock summed by category
    const { rows: stockByCategory } = await pool.query(
      `SELECT category::text AS category, SUM(count)::int AS headcount
       FROM livestock_groups
       WHERE user_id = $1 AND deleted_at IS NULL AND field_id = ANY($2::int[])
       GROUP BY category
       ORDER BY headcount DESC`,
      [userId, targetFieldIds]
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
       -- One row per ENDPOINT of a movement: the destination gains, the source
       -- loses. A transfer or recategorisation therefore nets to zero for the
       -- herd (it used to count only the + side, so moving 50 head between
       -- corrales read as 50 new animals). 'ajuste' is excluded: the ledger
       -- stores the new ABSOLUTE count, not a delta, so it cannot be summed.
       moves AS (
         SELECT
           date_trunc('month', m.movement_date)::date AS month_start,
           dg.category::text AS category,
           m.count AS delta
         FROM livestock_movements m
         JOIN livestock_groups dg ON dg.id = m.dest_group_id
         WHERE m.user_id = $1
           AND m.movement_type IN ('entrada','nacimiento','transferencia','recategorizacion')
           AND m.movement_date >= date_trunc('month', NOW()) - interval '11 months'
           AND dg.field_id = ANY($2::int[])
         UNION ALL
         SELECT
           date_trunc('month', m.movement_date)::date AS month_start,
           sg.category::text AS category,
           -m.count AS delta
         FROM livestock_movements m
         JOIN livestock_groups sg ON sg.id = m.source_group_id
         WHERE m.user_id = $1
           AND m.movement_type IN ('salida','muerte','transferencia','recategorizacion')
           AND m.movement_date >= date_trunc('month', NOW()) - interval '11 months'
           AND sg.field_id = ANY($2::int[])
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
      [userId, targetFieldIds]
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
         AND e.deleted_at IS NULL
         AND e.event_date >= NOW() - interval '12 months'
         AND e.quantity IS NOT NULL
         AND g.field_id = ANY($2::int[])
       ORDER BY g.id, e.event_date`,
      [userId, targetFieldIds]
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
         AND e.deleted_at IS NULL
         AND e.event_date >= CURRENT_DATE - interval '90 days'
         AND e.animal_category IS NOT NULL
         AND e.quantity IS NOT NULL
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = ANY($2::int[])))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = ANY($2::int[])))
         )
       ORDER BY e.animal_category, e.event_date DESC`,
      [userId, targetFieldIds]
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
         AND e.deleted_at IS NULL
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = ANY($2::int[])))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = ANY($2::int[])))
         )
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId, targetFieldIds]
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
         AND e.deleted_at IS NULL
         AND e.event_date >= date_trunc('month', NOW()) - interval '11 months'
         AND (
           (e.plot_id IS NOT NULL AND EXISTS (SELECT 1 FROM plots WHERE id = e.plot_id AND field_id = ANY($2::int[])))
           OR
           (e.corral_id IS NOT NULL AND EXISTS (SELECT 1 FROM corrals c JOIN feedlots fl ON fl.id = c.feedlot_id WHERE c.id = e.corral_id AND fl.field_id = ANY($2::int[])))
         )
       GROUP BY 1, 2, 3
       ORDER BY 1, 3`,
      [userId, targetFieldIds]
    );

    // Feedlot occupancy per corral — includes feedlot name + animals breakdown
    const { rows: feedlotOccupancy } = await pool.query(
      `SELECT
         c.id AS corral_id,
         c.name AS corral_name,
         c.capacity,
         f.name AS feedlot_name,
         fld.name AS field_name,
         COALESCE(SUM(g.count), 0)::int AS current_headcount,
         COALESCE(
           string_agg(
             CASE WHEN g.count > 0
               THEN g.count || ' ' || g.category::text || CASE WHEN g.breed IS NOT NULL THEN ' ' || g.breed ELSE '' END
               ELSE NULL END,
             ', '
             ORDER BY g.count DESC
           ),
           ''
         ) AS animals_description
       FROM corrals c
       JOIN feedlots f ON f.id = c.feedlot_id AND f.field_id = ANY($2::int[])
       JOIN fields fld ON fld.id = f.field_id
       LEFT JOIN livestock_groups g
         ON g.corral_id = c.id
        AND g.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
         AND f.user_id = $1
         AND f.deleted_at IS NULL
       GROUP BY c.id, c.name, c.capacity, f.name, fld.name
       ORDER BY c.name`,
      [userId, targetFieldIds]
    );

    // Stitch monthly deltas into the headcount trend (one row per month with byCategory map).
    // We don't reconstruct historic stock here — we expose the *deltas*, which is enough
    // for an area chart of monthly movement. (Computing historic stock would require
    // running totals back to time 0; not needed for the dashboard.)
    const trendMap = new Map<string, { month: string; label: string; byCategory: Record<string, number> }>();
    for (const r of monthlyDelta) {
      const key = r.month;
      const existing: { month: string; label: string; byCategory: Record<string, number> } = trendMap.get(key) ?? { month: r.month, label: monthLabel(r.month), byCategory: {} };
      if (r.category) existing.byCategory[r.category] = (existing.byCategory[r.category] ?? 0) + Number(r.delta);
      trendMap.set(key, existing);
    }

    // Stitch monthly health/repro event counts into the same per-month-by-type shape.
    const eventsToMonthly = (rows: Array<{ month: string; label: string; type: string | null; n: number }>) => {
      const map = new Map<string, { month: string; label: string; byType: Record<string, number> }>();
      for (const r of rows) {
        const k = r.month;
        const ex = map.get(k) ?? { month: r.month, label: monthLabel(r.month), byType: {} };
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

    // Individualización: cuántas de esas cabezas tienen caravana vigente.
    // Va en esta vista porque es donde el productor mira el rodeo — tener las
    // pantallas de Animales en otra sección dejaba la capa individual invisible
    // justo en el lugar donde se la busca.
    let individualization = { total: 0, identified: 0, byCategory: [] as Array<{ category: string; identified: number }> };
    try {
      const { rows: ind } = await pool.query(
        `SELECT a.category::text AS category, COUNT(*)::int AS n
           FROM animals a
          WHERE a.user_id = $1
            AND a.deleted_at IS NULL
            AND a.status = 'activo'
            AND (a.field_id IS NULL OR a.field_id = ANY($2::int[]))
            AND EXISTS (
              SELECT 1 FROM animal_identifications ai
               WHERE ai.animal_id = a.id AND ai.is_current
            )
          GROUP BY a.category`,
        [userId, targetFieldIds],
      );
      const identified = ind.reduce((s: number, r: { n: number }) => s + Number(r.n), 0);
      individualization = {
        total: stockByCategory.reduce((s: number, r: { headcount: number }) => s + Number(r.headcount), 0),
        identified,
        byCategory: ind.map((r: { category: string; n: number }) => ({ category: r.category, identified: Number(r.n) })),
      };
    } catch {
      // Entorno sin las migraciones de la capa individual: la vista agregada
      // no puede depender de ella (invariante 16).
    }

    res.json({
      individualization,
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
        feedlotName: r.feedlot_name ?? null,
        fieldName: r.field_name ?? null,
        animalsDescription: r.animals_description || '',
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
      `SELECT f.id, f.name, f.latitude AS lat, f.longitude AS lng, f.polygon, f.city
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
    await svc.subscribe(asUserId(req.auth!.userId), req.body);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

router.delete('/push/unsubscribe', requireAuth, async (req: Request, res: Response) => {
  try {
    const { PushNotificationService } = await import('../services/push-notification.service.js');
    const svc = new PushNotificationService();
    await svc.unsubscribe(asUserId(req.auth!.userId), req.body.endpoint);
    res.json({ ok: true });
  } catch (err) {
    handleError(err, res);
  }
});

// --- Cambio de contraseña (Mi cuenta) ---
const BCRYPT_ROUNDS = 12; // mismo work-factor que auth.service
router.post('/me/password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' }); return;
    }
    const u = await pool.query(`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.auth!.userId]);
    if (u.rows.length === 0 || !u.rows[0].password_hash) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    const okPass = await bcrypt.compare(currentPassword ?? '', u.rows[0].password_hash);
    if (!okPass) { res.status(403).json({ error: 'La contraseña actual no es correcta.' }); return; }
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.auth!.userId]);
    await tokenRepository.revokeAllUserTokens(req.auth!.userId);
    console.log(`[account] password changed user=${req.auth!.userId} (tokens revocados)`);
    res.json({ ok: true, message: 'Contraseña actualizada. Volvé a iniciar sesión.' });
  } catch (err) { handleError(err, res); }
});

// --- Recordatorios (tab del dashboard) ---
router.get('/reminders', requireAuth, async (req: Request, res: Response) => {
  try {
    const showAll = req.query.status === 'all';
    const { rows } = await pool.query(
      `SELECT r.id, r.description, r.due_date::text, to_char(r.due_time, 'HH24:MI') AS due_time,
              r.status, r.sent_at, p.name AS plot_name, f.name AS field_name
       FROM task_reminders r
       LEFT JOIN plots p ON p.id = r.plot_id
       LEFT JOIN fields f ON f.id = r.field_id
       WHERE r.user_id = $1 ${showAll ? '' : `AND r.status IN ('pending','sent')`}
       ORDER BY CASE WHEN r.status IN ('pending','sent') THEN 0 ELSE 1 END, r.due_date, r.due_time NULLS LAST, r.id`,
      [req.auth!.userId],
    );
    res.json({ reminders: rows });
  } catch (err) { handleError(err, res); }
});

router.patch('/reminders/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const action = req.body?.action as string;
    if (isNaN(id) || !['done', 'cancel'].includes(action)) { res.status(400).json({ error: 'Acción inválida' }); return; }
    const { completeReminder } = await import('../services/reminder.service.js');
    const r = await completeReminder(req.auth!.userId, { id, cancel: action === 'cancel' });
    if (!r) { res.status(404).json({ error: 'Recordatorio no encontrado' }); return; }
    res.json({ reminder: r });
  } catch (err) { handleError(err, res); }
});

/**
 * `field_id` query param → a field id, `null` for "all", or `undefined` when the
 * caller sent something unusable (which the route turns into a 400).
 */
function parseFieldIdParam(raw: unknown): number | null | undefined {
  if (raw === 'all') return null;
  if (typeof raw !== 'string') return undefined;
  const n = parseInt(raw, 10);
  return isNaN(n) ? undefined : n;
}

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

// --- Categories ---

function parseKind(raw: unknown, res: Response): CategoryKind | null {
  if (raw === 'expense' || raw === 'income') return raw;
  res.status(400).json({ error: "kind query parameter must be 'expense' or 'income'" });
  return null;
}

router.get('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.query.kind, res);
    if (!kind) return;
    const userId = req.auth!.userId;
    await categoryService.bootstrapDefaults(userId, kind);
    const list = await categoryRepo.listActive(userId, kind);
    res.json({
      categories: list.map(c => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        usageCount: c.usageCount,
        lastUsedAt: c.lastUsedAt,
      })),
    });
  } catch (err) { handleError(err, res); }
});

router.post('/categories', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.body?.kind, res);
    if (!kind) return;
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) {
      res.status(400).json({ error: 'name is required and must be ≤ 60 chars' });
      return;
    }
    const userId = req.auth!.userId;
    const existing = await categoryRepo.findByName(userId, kind, name);
    if (existing) {
      res.status(409).json({ error: 'Ya existe una categoría con ese nombre', category: existing });
      return;
    }
    // Similarity check — skip when caller explicitly confirms it's a new one
    const confirmAsNew = req.body?.confirmAsNew === true;
    if (!confirmAsNew) {
      const similar = await categoryService.findSimilar(userId, kind, name);
      if (similar) {
        res.status(200).json({
          similar: { id: similar.id, name: similar.name, usageCount: similar.usageCount },
          proposedName: name,
          created: false,
        });
        return;
      }
    }
    const created = await categoryRepo.create(userId, kind, name);
    res.status(201).json({ category: created, created: true });
  } catch (err) { handleError(err, res); }
});

router.patch('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 60) {
      res.status(400).json({ error: 'name is required and must be ≤ 60 chars' });
      return;
    }
    const userId = req.auth!.userId;
    const renamed = await categoryRepo.rename(userId, id, name);
    if (!renamed) { res.status(404).json({ error: 'category not found' }); return; }
    res.json({ category: renamed });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
      return;
    }
    handleError(err, res);
  }
});

router.delete('/categories/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
    const userId = req.auth!.userId;
    const cat = await categoryRepo.findById(userId, id);
    if (!cat) { res.status(404).json({ error: 'category not found' }); return; }

    const reassignToRaw = req.query.reassignTo;
    if (reassignToRaw) {
      const targetId = parseInt(String(reassignToRaw), 10);
      if (isNaN(targetId)) { res.status(400).json({ error: 'invalid reassignTo' }); return; }
      const target = await categoryRepo.findById(userId, targetId);
      if (!target || target.kind !== cat.kind) {
        res.status(400).json({ error: 'reassignTo must point to an existing category of the same kind' });
        return;
      }
      await categoryRepo.reassign(userId, cat.kind, cat.name, target.name);
    }
    await categoryRepo.softDelete(userId, id);
    res.json({ ok: true });
  } catch (err) { handleError(err, res); }
});

router.get('/categories/duplicates', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.query.kind, res);
    if (!kind) return;
    const userId = req.auth!.userId;
    const pairs = await categoryService.findDuplicatePairs(userId, kind);
    res.json({
      pairs: pairs.map(p => ({
        keep: { id: p.keep.id, name: p.keep.name, usageCount: p.keep.usageCount },
        drop: { id: p.drop.id, name: p.drop.name, usageCount: p.drop.usageCount },
      })),
    });
  } catch (err) { handleError(err, res); }
});

export default router;
