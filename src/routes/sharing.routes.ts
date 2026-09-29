/**
 * sharing.routes.ts — API del tab "Compartir" del dashboard.
 *
 * Hasta ahora compartir un campo se podía hacer ÚNICAMENTE por chat: el bot
 * devolvía un código de 6 caracteres y el dueño se lo pasaba por afuera. No
 * había ni una pantalla ni un endpoint de escritura.
 *
 * Se monta bajo el mismo prefijo que `auth.routes.ts` (`/api/auth`), igual que
 * `data-analysis.routes.ts`. Cero SQL acá adentro: todo pasa por
 * `FieldSharingService`, que es el mismo servicio que usa el bot — dos caminos
 * distintos para dar acceso a un campo serían dos reglas distintas.
 *
 * `createSharingRouter(deps)` permite testear el contrato HTTP in-process con
 * fakes, sin levantar la app.
 */

import { Router } from 'express';
import type { Request, Response, RequestHandler } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { requireFeature } from '../middleware/feature.middleware.js';
import { FieldSharingService } from '../domain/sharing/field-sharing.service.js';
import { buildInviteDelivery } from '../domain/sharing/invite-link.js';
import { inviteNotifier } from '../domain/sharing/invite-notifier.js';
import { formatPhoneAR } from '../utils/phone.js';
import { asUserId } from '../types/index.js';

export interface SharingDeps {
  service: FieldSharingService;
  auth: RequestHandler;
  feature: RequestHandler;
}

export const defaultDeps: SharingDeps = {
  service: new FieldSharingService(),
  auth: requireAuth,
  feature: requireFeature('sharing'),
};

function handleError(err: unknown, res: Response): void {
  const e = err as { status?: number; message?: string };
  console.error('[SHARING] error', e?.message ?? err);
  res.status(e?.status ?? 500).json({ error: e?.message ?? 'Error interno' });
}

export function createSharingRouter(deps: SharingDeps = defaultDeps): Router {
  const router = Router();
  const { service, auth, feature } = deps;

  /** Todo lo que necesita la pantalla, en un solo fetch. */
  router.get('/sharing/overview', auth, feature, async (req: Request, res: Response) => {
    try {
      const userId = asUserId(req.auth!.userId);
      const [sharedByMe, sharedWithMe] = await Promise.all([
        service.listSharedByMe(userId),
        service.listSharedWithMe(userId),
      ]);
      res.json({
        sharedByMe: sharedByMe.map((f) => ({
          ...f,
          members: f.members.map((m) => ({ ...m, phoneLabel: formatPhoneAR(m.phone) })),
          invites: f.invites.map((i) => ({ ...i, phoneLabel: i.phone ? formatPhoneAR(i.phone) : null })),
        })),
        sharedWithMe: sharedWithMe.map((f) => ({
          ...f,
          ownerPhoneLabel: f.ownerPhone ? formatPhoneAR(f.ownerPhone) : null,
        })),
      });
    } catch (err) { handleError(err, res); }
  });

  /** Invitar por número de teléfono. Devuelve el link que reenvía el dueño. */
  router.post('/sharing/fields/:fieldId/invites', auth, feature, async (req: Request, res: Response) => {
    try {
      const userId = asUserId(req.auth!.userId);
      const fieldId = Number(req.params.fieldId);
      if (!Number.isInteger(fieldId)) { res.status(400).json({ error: 'Campo inválido' }); return; }

      const phone = typeof req.body?.phone === 'string' ? req.body.phone : null;
      if (!phone || !phone.trim()) {
        res.status(400).json({ error: 'Hace falta el número de teléfono de la persona.' });
        return;
      }

      const result = await service.createInvite(userId, fieldId, { phone, channel: 'wa_link' });
      if (!result.success) {
        // Un motivo de negocio (no es el dueño, ya es miembro, número
        // ilegible) es 400 con el texto tal cual: la UI lo muestra sin
        // reinterpretarlo, así el chat y la web dicen lo mismo.
        res.status(400).json({ error: result.message });
        return;
      }

      const delivery = await buildInviteDelivery({ code: result.code!, expiresAt: result.expiresAt });
      // Se intenta la entrega directa siempre; hoy es un noop que loguea (no
      // hay plantilla aprobada de Meta). El día que la haya, esto empieza a
      // mandar sin tocar la ruta ni la UI.
      const delivered = await inviteNotifier.notify(
        { code: result.code!, fieldId },
        result.invitedPhone ?? null,
      );

      res.status(201).json({
        invite: {
          code: result.code,
          phone: result.invitedPhone,
          phoneLabel: formatPhoneAR(result.invitedPhone ?? null),
          expiresAt: result.expiresAt,
        },
        waLink: delivery.waLink,
        waText: delivery.waText,
        registerLink: delivery.registerLink,
        delivery: delivered === 'sent' ? 'sent' : 'link',
      });
    } catch (err) { handleError(err, res); }
  });

  /** Revocar una invitación que todavía no se usó. */
  router.delete('/sharing/invites/:inviteId', auth, feature, async (req: Request, res: Response) => {
    try {
      const userId = asUserId(req.auth!.userId);
      const inviteId = Number(req.params.inviteId);
      if (!Number.isInteger(inviteId)) { res.status(400).json({ error: 'Invitación inválida' }); return; }
      const result = await service.revokeInvite(userId, inviteId);
      if (!result.success) { res.status(400).json({ error: result.message }); return; }
      res.json({ revoked: true, message: result.message });
    } catch (err) { handleError(err, res); }
  });

  /**
   * Quitar a un miembro (dueño) o salir de un campo (uno mismo).
   *
   * Salir NO lleva `feature`: si el dueño baja de plan, el miembro tiene que
   * poder irse igual — quedar atrapado en un campo ajeno no es un estado
   * válido.
   */
  router.delete('/sharing/fields/:fieldId/members/:memberId', auth, async (req: Request, res: Response) => {
    try {
      const userId = asUserId(req.auth!.userId);
      const fieldId = Number(req.params.fieldId);
      const memberId = Number(req.params.memberId);
      if (!Number.isInteger(fieldId) || !Number.isInteger(memberId)) {
        res.status(400).json({ error: 'Parámetros inválidos' });
        return;
      }

      const result = Number(memberId) === Number(userId)
        ? await service.leaveField(userId, fieldId)
        : await service.removeMemberById(userId, fieldId, memberId);

      if (!result.success) { res.status(400).json({ error: result.message }); return; }
      res.json({ removed: true, message: result.message });
    } catch (err) { handleError(err, res); }
  });

  /**
   * Redimir una invitación desde la web.
   *
   * SIN `requireFeature`: es paridad con `accept_invite`, que está desgateado a
   * propósito. Quien acepta puede ser un empleado en plan Pro; el que paga la
   * función de compartir es el DUEÑO.
   */
  router.post('/sharing/join', auth, async (req: Request, res: Response) => {
    try {
      const userId = asUserId(req.auth!.userId);
      const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
      if (!code) { res.status(400).json({ error: 'Hace falta el código de la invitación.' }); return; }
      const result = await service.acceptInvite(userId, code);
      if (!result.success) {
        // NEEDS_PHONE: la cuenta todavía no tiene WhatsApp. El front guarda el
        // código y reintenta cuando se vincula (hooks/usePendingInvite).
        if (result.reason === 'needs_phone') {
          res.status(409).json({ error: result.message, code: 'NEEDS_PHONE' });
          return;
        }
        res.status(400).json({ error: result.message });
        return;
      }
      res.json({ joined: true, fieldName: result.fieldName, message: result.message });
    } catch (err) { handleError(err, res); }
  });

  return router;
}

export default createSharingRouter();
