// src/routes/forms.routes.ts
// Público a propósito: el token de form_sessions ES la autenticación
// (corta vida, un solo uso, atado al usuario) — mismo modelo que /api/map/:token.
import { Router, type Request, type Response } from 'express';
import { formSessionService } from '../services/form-session.service.js';
import { FORM_DEFINITIONS } from '../forms/form-definitions.js';
import { submitForm } from '../forms/form-submit.service.js';
import { computeFormOptions } from '../forms/form-options.js';
import { resolveFormInitialValues } from '../forms/form-prefill.js';
import { getTodayISO } from '../utils/date.js';

const router = Router();

export async function formsGetHandler(req: Request, res: Response): Promise<void> {
  const session = await formSessionService.validate(String(req.params.token));
  if (!session) {
    res.status(404).json({ error: 'Este formulario venció. Pedime otro en el chat con «formulario siembra» o «formulario cosecha».' });
    return;
  }
  const def = FORM_DEFINITIONS[session.action];
  const options = await computeFormOptions(session.action, session.user_id);
  // `initialValues` viene resuelto del server (form-prefill.ts) — la MISMA
  // función que hornea el prellenado del Flow de WhatsApp. Antes esta lógica
  // vivía sólo en FormPage.tsx, así que web y WhatsApp podían divergir.
  // `prefill` se sigue enviando crudo por compatibilidad.
  res.json({
    action: session.action,
    title: def.title,
    fields: def.fields,
    prefill: session.prefill,
    initialValues: resolveFormInitialValues({
      action: session.action,
      prefill: (session.prefill ?? {}) as Record<string, unknown>,
      options,
      todayISO: getTodayISO(),
    }),
    options,
  });
}

export async function formsPostHandler(req: Request, res: Response): Promise<void> {
  const result = await submitForm(String(req.params.token), req.body ?? {});
  if (result.ok) {
    res.json({ ok: true, message: result.message });
    return;
  }
  res.status(result.status).json({ error: result.error });
}

router.get('/:token', (req, res) => { void formsGetHandler(req, res); });
router.post('/:token', (req, res) => { void formsPostHandler(req, res); });

export default router;
