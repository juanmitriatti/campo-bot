import { Router, type Request, type Response } from 'express';
import { getPlanCatalog } from '../domain/billing/plan-catalog.service.js';
import { logError } from '../services/error-logger.js';

/**
 * Catálogo PÚBLICO de planes — lo consume la sección "Planes" de la landing
 * (`landing/src/components/Pricing.tsx`), que dejó de tener los precios
 * hardcodeados. Cambiar un precio o los días de prueba desde /admin cambia la
 * landing sin deploy.
 *
 * Sin auth a propósito: es la misma información que cualquiera ve en la página
 * de precios. NO expone nada que no sea comercial (ni features internas, ni
 * cantidad de usuarios, ni el plan free, que dejó de venderse).
 *
 * Contrato con la landing (no romper sin avisar del otro lado):
 *   { trial_days, plans: [{ name, display_name, price_ars, price_ars_yearly,
 *                           daily_ai_limit, daily_document_limit,
 *                           featured, custom_pricing }] }
 */

const router = Router();

router.get('/public', async (_req: Request, res: Response) => {
  try {
    res.json(await getPlanCatalog());
  } catch (err) {
    // La landing tiene su propio fallback y renderiza igual — devolvemos el
    // error en vez de un catálogo inventado, que sería peor: precios mentidos.
    console.error('[plans] public catalog error:', (err as Error).message);
    logError('plans', 'PUBLIC_CATALOG', err as Error);
    res.status(500).json({ error: 'No pudimos cargar los planes.' });
  }
});

export default router;
