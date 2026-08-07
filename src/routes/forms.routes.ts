// src/routes/forms.routes.ts
// Público a propósito: el token de form_sessions ES la autenticación
// (corta vida, un solo uso, atado al usuario) — mismo modelo que /api/map/:token.
import { Router, type Request, type Response } from 'express';
import { formSessionService } from '../services/form-session.service.js';
import { FORM_DEFINITIONS } from '../forms/form-definitions.js';
import { submitForm } from '../forms/form-submit.service.js';
import { KNOWN_CROPS } from '../utils/crops.js';
import { getUserFields, getPlotsByField, getAllActiveCrops } from '../services/expenses.js';

const router = Router();

export async function formsGetHandler(req: Request, res: Response): Promise<void> {
  const session = await formSessionService.validate(req.params.token);
  if (!session) {
    res.status(404).json({ error: 'Este formulario venció. Pedime otro en el chat con «formulario siembra» o «formulario cosecha».' });
    return;
  }
  const def = FORM_DEFINITIONS[session.action];
  const fields = await getUserFields(session.user_id);
  const actives = (await getAllActiveCrops(session.user_id)) as Array<{ plot_id: number; crop: string }>;
  const activeByPlot = new Map(actives.map(a => [a.plot_id, a.crop]));
  const plots: Array<{ id: number; name: string; fieldName: string; activeCrop: string | null }> = [];
  for (const f of fields as Array<{ id: number; name: string }>) {
    for (const p of (await getPlotsByField(f.id)) as Array<{ id: number; name: string }>) {
      plots.push({ id: p.id, name: p.name, fieldName: f.name, activeCrop: activeByPlot.get(p.id) ?? null });
    }
  }
  const visible = session.action === 'harvest_crop' ? plots.filter(p => p.activeCrop) : plots;
  res.json({
    action: session.action,
    title: def.title,
    fields: def.fields,
    prefill: session.prefill,
    options: { plots: visible, crops: KNOWN_CROPS },
  });
}

export async function formsPostHandler(req: Request, res: Response): Promise<void> {
  const result = await submitForm(req.params.token, req.body ?? {});
  if (result.ok) {
    res.json({ ok: true, message: result.message });
    return;
  }
  res.status(result.status).json({ error: result.error });
}

router.get('/:token', (req, res) => { void formsGetHandler(req, res); });
router.post('/:token', (req, res) => { void formsPostHandler(req, res); });

export default router;
