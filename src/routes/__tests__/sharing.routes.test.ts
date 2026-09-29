/**
 * Contrato HTTP del tab "Compartir", in-process con fakes.
 *
 * Lo que importa acá y no se ve a nivel servicio: el gate de plan, que un
 * motivo de negocio salga como 400 con SU texto (para que la web y el chat
 * digan lo mismo), y que salir de un campo NO dependa del plan — si el dueño
 * baja de plan, el miembro tiene que poder irse igual.
 *
 * Levanta el router en un puerto efímero y le pega con `fetch`: sin supertest
 * (no está en el proyecto) y sin depender del backend real de :3000, así que
 * corre siempre.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import { createSharingRouter, type SharingDeps } from '../sharing.routes.js';

vi.mock('../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (k: string) => (k === 'WHATSAPP_BOT_NUMBER' ? '5492364469135' : null)),
}));

const USER_ID = 7;

function makeService() {
  return {
    listSharedByMe: vi.fn(async () => []),
    listSharedWithMe: vi.fn(async () => []),
    createInvite: vi.fn(async () => ({
      success: true, message: '', code: 'A3F7K2',
      invitedPhone: '5491123456789', expiresAt: new Date('2026-09-20'),
    })),
    revokeInvite: vi.fn(async () => ({ success: true, message: 'Invitación revocada.' })),
    removeMemberById: vi.fn(async () => ({ success: true, message: 'Listo.' })),
    leaveField: vi.fn(async () => ({ success: true, message: 'Saliste del campo.' })),
    acceptInvite: vi.fn(async () => ({ success: true, message: 'ok', fieldName: 'La Compartida' })),
  };
}

let server: Server | null = null;

async function start(opts: { featureOk?: boolean } = {}) {
  const service = makeService();
  const deps: SharingDeps = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service: service as any,
    auth: (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { auth?: { userId: number } }).auth = { userId: USER_ID };
      next();
    },
    feature: (_req: Request, res: Response, next: NextFunction) => {
      if (opts.featureOk === false) { res.status(403).json({ error: 'Feature not available in your plan' }); return; }
      next();
    },
  };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', createSharingRouter(deps));

  const srv = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  server = srv;
  const port = (srv.address() as { port: number }).port;

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };

  return { call, service };
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

describe('API de campos compartidos', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sin el feature `sharing` en el plan → 403', async () => {
    const { call } = await start({ featureOk: false });
    const res = await call('GET', '/api/auth/sharing/overview');
    expect(res.status).toBe(403);
  });

  it('invitar por teléfono devuelve el link wa.me que reenvía el dueño', async () => {
    const { call, service } = await start();
    const res = await call('POST', '/api/auth/sharing/fields/12/invites', { phone: '11 2345 6789' });
    expect(res.status).toBe(201);
    expect(res.body.waLink).toBe('https://wa.me/5492364469135?text=unirme%20A3F7K2');
    // El bot NO le puede escribir a un número que nunca le habló: la entrega
    // es el link, no un envío.
    expect(res.body.delivery).toBe('link');
    expect(service.createInvite).toHaveBeenCalledWith(USER_ID, 12, { phone: '11 2345 6789', channel: 'wa_link' });
  });

  it('sin teléfono → 400, no se emite invitación', async () => {
    const { call, service } = await start();
    const res = await call('POST', '/api/auth/sharing/fields/12/invites', {});
    expect(res.status).toBe(400);
    expect(service.createInvite).not.toHaveBeenCalled();
  });

  it('un motivo de negocio viaja como 400 con SU texto (web y chat dicen lo mismo)', async () => {
    const { call, service } = await start();
    service.createInvite.mockResolvedValueOnce({
      success: false, message: 'Solo el dueño del campo puede compartirlo.',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await call('POST', '/api/auth/sharing/fields/12/invites', { phone: '11 2345 6789' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Solo el dueño/);
  });

  it('revocar una invitación ya usada es 400 con el motivo', async () => {
    const { call, service } = await start();
    service.revokeInvite.mockResolvedValueOnce({
      success: false,
      message: 'Esa invitación ya fue usada. Para sacarle el acceso, quitá a la persona del campo.',
    });
    const res = await call('DELETE', '/api/auth/sharing/invites/5');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ya fue usada/);
  });

  it('quitar a OTRO usa removeMemberById; quitarse a UNO MISMO usa leaveField', async () => {
    const { call, service } = await start();

    await call('DELETE', '/api/auth/sharing/fields/12/members/99');
    expect(service.removeMemberById).toHaveBeenCalledWith(USER_ID, 12, 99);
    expect(service.leaveField).not.toHaveBeenCalled();

    await call('DELETE', `/api/auth/sharing/fields/12/members/${USER_ID}`);
    expect(service.leaveField).toHaveBeenCalledWith(USER_ID, 12);
  });

  it('SALIR de un campo no depende del plan: el miembro no queda atrapado', async () => {
    const { call, service } = await start({ featureOk: false });
    const res = await call('DELETE', `/api/auth/sharing/fields/12/members/${USER_ID}`);
    expect(res.status).toBe(200);
    expect(service.leaveField).toHaveBeenCalled();
  });

  it('/join NO está gateado: el invitado puede ser Pro, el que paga es el dueño', async () => {
    const { call, service } = await start({ featureOk: false });
    const res = await call('POST', '/api/auth/sharing/join', { code: 'A3F7K2' });
    expect(res.status).toBe(200);
    expect(res.body.fieldName).toBe('La Compartida');
    expect(service.acceptInvite).toHaveBeenCalledWith(USER_ID, 'A3F7K2');
  });

  it('/join sin código → 400', async () => {
    const { call } = await start();
    const res = await call('POST', '/api/auth/sharing/join', {});
    expect(res.status).toBe(400);
  });

  it('un código para otro número devuelve 400 con el motivo del servicio', async () => {
    const { call, service } = await start();
    service.acceptInvite.mockResolvedValueOnce({
      success: false, message: 'Esta invitación es para el número *+54 9 1123456789*.',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await call('POST', '/api/auth/sharing/join', { code: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/es para el número/);
  });
});
