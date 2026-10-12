import { Router, type Request, type Response } from 'express';
import { getSetting } from '../services/settings.service.js';
import { getAppName, DEFAULT_APP_NAME } from '../utils/brand.js';
import { getBotWhatsAppNumber } from '../utils/whatsapp-link.js';

/**
 * Marca PÚBLICA — la lee el dashboard para sus títulos (login, registro, barra
 * superior) en vez de tener el nombre escrito a mano. Sin auth a propósito: es
 * lo mismo que cualquiera ve en la página.
 *
 * Contrato: { app_name, bot_name, support_contact, whatsapp_bot_number, telegram_bot_username }
 *
 * El número y el usuario de los bots son públicos (cualquiera que le escribe
 * los ve); Mi cuenta los usa para el link/QR "Escribile al bot".
 */

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const [appName, botName, support, waNumber, tgUser] = await Promise.all([
      getAppName(),
      getSetting('BOT_NAME'),
      getSetting('SUPPORT_CONTACT'),
      getBotWhatsAppNumber(),
      getSetting('TELEGRAM_BOT_USERNAME'),
    ]);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      app_name: appName,
      bot_name: ((botName as string | null) || 'MIA').trim(),
      support_contact: ((support as string | null) || '').trim(),
      whatsapp_bot_number: waNumber ?? '',
      telegram_bot_username: ((tgUser as string | null) || '').trim().replace(/^@/, ''),
    });
  } catch (err) {
    console.error('[brand] error:', (err as Error).message);
    res.json({ app_name: DEFAULT_APP_NAME, bot_name: 'MIA', support_contact: '', whatsapp_bot_number: '', telegram_bot_username: '' });
  }
});

export default router;
