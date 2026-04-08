import { Router } from 'express';
import { AuthService, AuthError } from '../domain/auth/auth.service.js';
import { ObservationService, ObservationError } from '../domain/auth/observation.service.js';
import { PlanRepository } from '../domain/billing/plan.repository.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import type { Request, Response } from 'express';
import { logError } from '../services/error-logger.js';
import { pool } from '../config/db.js';
import { asUserId } from '../types/index.js';

const router = Router();
const authService = new AuthService();
const observationService = new ObservationService();
const planRepo = new PlanRepository();

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

// --- Expense & Income routes ---

router.get('/expenses', requireAuth, async (req: Request, res: Response) => {
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

router.get('/incomes', requireAuth, async (req: Request, res: Response) => {
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

router.get('/activities', requireAuth, async (req: Request, res: Response) => {
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

router.patch('/expenses/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const result = await observationService.editExpense(id, req.auth!.userId, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/incomes/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const result = await observationService.editIncome(id, req.auth!.userId, req.body);
    res.json(result);
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/activities/:id', requireAuth, async (req: Request, res: Response) => {
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

router.get('/observations/filters', requireAuth, async (req: Request, res: Response) => {
  try {
    const fields = await observationService.getUserFieldsWithPlots(req.auth!.userId);
    res.json({ fields });
  } catch (err) {
    handleError(err, res);
  }
});

router.get('/observations', requireAuth, async (req: Request, res: Response) => {
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

router.patch('/observations/:id', requireAuth, async (req: Request, res: Response) => {
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

router.get('/observations/:id/history', requireAuth, async (req: Request, res: Response) => {
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

// --- Stock routes ---

router.get('/stock', requireAuth, async (req: Request, res: Response) => {
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

router.get('/stock/:id/movements', requireAuth, async (req: Request, res: Response) => {
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

router.patch('/stock/:id', requireAuth, async (req: Request, res: Response) => {
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

router.get('/livestock', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    const filters: { fieldId?: number; plotId?: number; category?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;

    const { LivestockRepository } = await import('../domain/livestock/livestock.repository.js');
    const repo = new LivestockRepository();
    const groups = await repo.listGroups(req.auth!.userId, filters as {
      fieldId?: number; plotId?: number; category?: import('../domain/livestock/livestock.types.js').LivestockCategory;
    });
    const total = await repo.countTotal(req.auth!.userId, { fieldId: filters.fieldId, plotId: filters.plotId });

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

router.get('/livestock/movements', requireAuth, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const offset = (page - 1) * limit;

    const opts: {
      fieldId?: number;
      plotId?: number;
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

router.get('/livestock/:id/movements', requireAuth, async (req: Request, res: Response) => {
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

router.get('/livestock/filters', requireAuth, async (req: Request, res: Response) => {
  try {
    const fields = await observationService.getUserFieldsWithPlots(req.auth!.userId);
    res.json({
      fields,
      categories: ['vaca', 'vaquillona', 'ternero', 'ternera', 'novillo', 'novillito', 'toro', 'torito', 'buey'],
    });
  } catch (err) {
    handleError(err, res);
  }
});

router.patch('/livestock/:id', requireAuth, async (req: Request, res: Response) => {
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

// --- Document routes ---

router.get('/documents', requireAuth, async (req: Request, res: Response) => {
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

router.get('/documents/filters', requireAuth, async (req: Request, res: Response) => {
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

router.get('/documents/:id', requireAuth, async (req: Request, res: Response) => {
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

router.get('/documents/:id/file', requireAuth, async (req: Request, res: Response) => {
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
