import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { JwtPayload, UserRole } from '../domain/auth/auth.types.js';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      auth?: JwtPayload;
    }
  }
}

/**
 * Estado ACTUAL de la cuenta detrás de un token (CTA-16). El JWT de acceso vive
 * 15 minutos y llevaba el rol adentro: una cuenta borrada o suspendida, o un
 * admin al que se le sacó el rol, seguía entrando (incluido /admin/api) hasta
 * que vencía. Ahora cada request mira la base, con una caché corta.
 */
export interface AccountState {
  exists: boolean;
  status: string | null;
  role: UserRole | null;
}

type AccountLookup = (userId: number) => Promise<AccountState>;

const defaultLookup: AccountLookup = async (userId) => {
  const { pool } = await import('../config/db.js');
  const { rows } = await pool.query(
    `SELECT status, role, deleted_at FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r || r.deleted_at) return { exists: false, status: null, role: null };
  return { exists: true, status: r.status ?? null, role: r.role ?? null };
};

let lookup: AccountLookup = defaultLookup;
const CACHE_MS = 15_000;
const cache = new Map<number, { at: number; state: AccountState }>();

/** Test seam: reemplaza la consulta a la base. Sin argumento vuelve a la real. */
export function setAccountLookupForTests(fn?: AccountLookup): void {
  lookup = fn ?? defaultLookup;
  cache.clear();
}

/** Se llama al suspender, borrar o cambiar el rol de una cuenta: el cambio aplica ya. */
export function invalidateAccountState(userId: number): void {
  cache.delete(userId);
}

async function accountState(userId: number): Promise<AccountState> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
  const state = await lookup(userId);
  cache.set(userId, { at: Date.now(), state });
  return state;
}

const BLOCKED_STATUSES = new Set(['suspended', 'disabled', 'deleted']);

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de acceso requerido' });
    return;
  }

  const token = header.slice(7);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, secret) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Token expirado o inválido' });
    return;
  }
  if (payload.type !== 'access') {
    res.status(401).json({ error: 'Token expirado o inválido' });
    return;
  }

  try {
    const state = await accountState(Number(payload.userId));
    if (!state.exists) {
      console.log(`[AUTH] token de una cuenta que ya no existe: user=${payload.userId}`);
      res.status(401).json({ error: 'La cuenta ya no existe' });
      return;
    }
    if (state.status && BLOCKED_STATUSES.has(state.status)) {
      console.log(`[AUTH] token de una cuenta ${state.status}: user=${payload.userId}`);
      res.status(403).json({ error: 'Tu cuenta está suspendida. Escribinos si creés que es un error.', code: 'ACCOUNT_BLOCKED' });
      return;
    }
    // El rol que manda es el de la base, no el que quedó en el token.
    req.auth = state.role ? { ...payload, role: state.role } : payload;
  } catch (err) {
    // Una caída de la base no deja a todos afuera: se sigue con el token.
    console.error('[AUTH] no pude verificar el estado de la cuenta:', (err as Error).message);
    req.auth = payload;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'No tenés permisos para acceder a este recurso' });
      return;
    }
    next();
  };
}
