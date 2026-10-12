import { Router, type Request, type Response } from 'express';
import { getSetting } from '../services/settings.service.js';
import { getAppName, DEFAULT_APP_NAME } from '../utils/brand.js';

/**
 * Marca PÚBLICA — la lee el dashboard para sus títulos (login, registro, barra
 * superior) en vez de tener el nombre escrito a mano. Sin auth a propósito: es
 * lo mismo que cualquiera ve en la página.
 *
 * Contrato: { app_name, bot_name, support_contact }
 */

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const [appName, botName, support] = await Promise.all([
      getAppName(),
      getSetting('BOT_NAME'),
      getSetting('SUPPORT_CONTACT'),
    ]);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      app_name: appName,
      bot_name: ((botName as string | null) || 'MIA').trim(),
      support_contact: ((support as string | null) || '').trim(),
    });
  } catch (err) {
    console.error('[brand] error:', (err as Error).message);
    res.json({ app_name: DEFAULT_APP_NAME, bot_name: 'MIA', support_contact: '' });
  }
});

export default router;
