import { Router } from 'express';
import { AuthService, AuthError } from '../domain/auth/auth.service.js';
import { ObservationService, ObservationError } from '../domain/auth/observation.service.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import type { Request, Response } from 'express';

const router = Router();
const authService = new AuthService();
const observationService = new ObservationService();

// --- Public routes ---

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

    const filters: { fieldId?: number; plotId?: number; dateFrom?: string; dateTo?: string; category?: string } = {};
    const fieldId = parseInt(String(req.query.fieldId), 10);
    if (!isNaN(fieldId)) filters.fieldId = fieldId;
    const plotId = parseInt(String(req.query.plotId), 10);
    if (!isNaN(plotId)) filters.plotId = plotId;
    if (req.query.dateFrom && typeof req.query.dateFrom === 'string') filters.dateFrom = req.query.dateFrom;
    if (req.query.dateTo && typeof req.query.dateTo === 'string') filters.dateTo = req.query.dateTo;
    if (req.query.category && typeof req.query.category === 'string') filters.category = req.query.category;

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

function handleError(err: unknown, res: Response): void {
  if (err instanceof AuthError || err instanceof ObservationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('Auth route error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}

export default router;
