import { Router } from 'express';
import { AuthService, AuthError } from '../domain/auth/auth.service.js';
import { ObservationService, ObservationError } from '../domain/auth/observation.service.js';
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

// --- Dashboard overview ---

router.get('/dashboard', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const accessibleFields = `SELECT field_id FROM field_members WHERE user_id = $1`;

    // Current month boundaries (Argentina TZ)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);

    // Expenses: current + previous month
    const expensesQuery = pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN expense_date >= $2::date THEN amount ELSE 0 END), 0) AS current_month,
        COALESCE(SUM(CASE WHEN expense_date >= $3::date AND expense_date < $2::date THEN amount ELSE 0 END), 0) AS prev_month
       FROM expenses
       WHERE (user_id = $1 OR field_id IN (${accessibleFields}))
         AND deleted_at IS NULL AND currency = 'ARS'
         AND expense_date >= $3::date`,
      [userId, monthStart, prevMonthStart]
    );

    // Incomes: current + previous month
    const incomesQuery = pool.query(
      `SELECT
        COALESCE(SUM(CASE WHEN income_date >= $2::date THEN amount ELSE 0 END), 0) AS current_month,
        COALESCE(SUM(CASE WHEN income_date >= $3::date AND income_date < $2::date THEN amount ELSE 0 END), 0) AS prev_month
       FROM incomes
       WHERE (user_id = $1 OR field_id IN (${accessibleFields}))
         AND deleted_at IS NULL AND currency = 'ARS'
         AND income_date >= $3::date`,
      [userId, monthStart, prevMonthStart]
    );

    // Activities count this month
    const activitiesQuery = pool.query(
      `SELECT COUNT(*)::int AS count
       FROM domain_events
       WHERE user_id = $1
         AND event_date >= $2::date`,
      [userId, monthStart]
    );

    // Recent items: last 5 expenses + incomes + activities mixed
    const recentQuery = pool.query(
      `(SELECT 'expense' AS type, e.description, e.amount, e.currency, NULL AS event_type,
              e.expense_date AS date, f.name AS field_name, p.name AS plot_name
        FROM expenses e
        LEFT JOIN fields f ON e.field_id = f.id
        LEFT JOIN plots p ON e.plot_id = p.id
        WHERE (e.user_id = $1 OR e.field_id IN (${accessibleFields}))
          AND e.deleted_at IS NULL
        ORDER BY e.expense_date DESC, e.created_at DESC LIMIT 5)
       UNION ALL
       (SELECT 'income' AS type, i.description, i.amount, i.currency, NULL AS event_type,
              i.income_date AS date, f.name AS field_name, p.name AS plot_name
        FROM incomes i
        LEFT JOIN fields f ON i.field_id = f.id
        LEFT JOIN plots p ON i.plot_id = p.id
        WHERE (i.user_id = $1 OR i.field_id IN (${accessibleFields}))
          AND i.deleted_at IS NULL
        ORDER BY i.income_date DESC, i.created_at DESC LIMIT 5)
       UNION ALL
       (SELECT 'activity' AS type, NULL AS description, NULL::numeric AS amount, NULL AS currency, de.event_type,
              de.event_date AS date, f.name AS field_name, p.name AS plot_name
        FROM domain_events de
        LEFT JOIN plots p ON de.plot_id = p.id
        LEFT JOIN fields f ON p.field_id = f.id
        WHERE de.user_id = $1
        ORDER BY de.event_date DESC, de.created_at DESC LIMIT 5)
       ORDER BY date DESC LIMIT 5`,
      [userId]
    );

    const [expensesRes, incomesRes, activitiesRes, recentRes] = await Promise.all([
      expensesQuery, incomesQuery, activitiesQuery, recentQuery,
    ]);

    const result: Record<string, unknown> = {
      expenses_month_ars: Number(expensesRes.rows[0].current_month),
      expenses_prev_month_ars: Number(expensesRes.rows[0].prev_month),
      incomes_month_ars: Number(incomesRes.rows[0].current_month),
      incomes_prev_month_ars: Number(incomesRes.rows[0].prev_month),
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
      const total = await livestockRepo.countTotal(userId, {});
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
         ), 0)::numeric AS expenses,
         COALESCE((
           SELECT SUM(amount) FROM incomes
           WHERE user_id = $1 AND deleted_at IS NULL AND currency = 'ARS'
             AND income_date >= m.month_start
             AND income_date < m.month_start + interval '1 month'
         ), 0)::numeric AS incomes
       FROM months m
       ORDER BY m.month_start`,
      [userId]
    );

    // Expense categories - current month
    const { rows: expenseCategories } = await pool.query(
      `SELECT category, SUM(amount)::numeric AS total
         FROM expenses
        WHERE user_id = $1 AND deleted_at IS NULL AND currency = 'ARS'
          AND expense_date >= date_trunc('month', NOW())
        GROUP BY category
        ORDER BY total DESC`,
      [userId]
    );

    res.json({
      monthlyTrend: monthlyTrend.map(r => ({
        month: r.month,
        label: r.label,
        expenses: Number(r.expenses),
        incomes: Number(r.incomes),
      })),
      expenseCategories: expenseCategories.map(r => ({
        category: r.category || 'Otros',
        total: Number(r.total),
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
  console.error('Auth route error:', err);
  logError('auth', 'ROUTE_ERROR', err as Error);
  res.status(500).json({ error: 'Error interno del servidor' });
}

export default router;
