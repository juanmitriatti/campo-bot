import type { Request, Response, NextFunction } from 'express';

/**
 * Limitador de intentos para los endpoints públicos de auth. In-process
 * (single-replica, como user-lock.ts): no hace falta Redis para esto.
 *
 * Por qué por EMAIL y no por IP: la app corre detrás del proxy de Railway sin
 * `trust proxy`, así que `req.ip` es el mismo para todos los usuarios y un
 * límite por IP sería un límite global. El email es además la clave correcta
 * contra fuerza bruta sobre una cuenta puntual.
 *
 * Login: cuenta solo FALLOS (un usuario que acierta nunca se topa con esto) y
 * se resetea al primer login correcto. Forgot-password: cuenta pedidos, para
 * que nadie pueda usar el bot como cañón de emails contra una casilla.
 *
 * Todo rechazo loguea `[AUTH RATE]` (invariante 1: nada se descarta en silencio).
 */

interface Bucket { count: number; resetAt: number }

export interface AuthRateLimiterOptions {
  /** Nombre para los logs. */
  name: string;
  /** Intentos permitidos dentro de la ventana. */
  max: number;
  /** Ventana en milisegundos. */
  windowMs: number;
  /** Mensaje del 429. */
  message: string;
}

export class AuthRateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(private opts: AuthRateLimiterOptions, private now: () => number = Date.now) {
    this.lastSweep = now();
  }

  private bucket(key: string): Bucket {
    const t = this.now();
    this.sweep(t);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.opts.windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.opts.windowMs) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (b.resetAt <= t) this.buckets.delete(k);
  }

  /** ¿Está bloqueada esta clave ahora mismo? (no consume intento) */
  isBlocked(key: string): boolean {
    const b = this.buckets.get(key);
    return !!b && b.resetAt > this.now() && b.count >= this.opts.max;
  }

  /** Segundos que faltan para que se libere la clave. */
  retryAfterSec(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    return Math.max(1, Math.ceil((b.resetAt - this.now()) / 1000));
  }

  /** Suma un intento (fallido) a la clave. Devuelve true si con este ya quedó bloqueada. */
  record(key: string): boolean {
    const b = this.bucket(key);
    b.count += 1;
    return b.count >= this.opts.max;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Responde 429 si la clave está bloqueada. Devuelve true si respondió. */
  reject(key: string, res: Response): boolean {
    if (!this.isBlocked(key)) return false;
    const retry = this.retryAfterSec(key);
    console.log(`[AUTH RATE] ${this.opts.name} bloqueado key=${maskKey(key)} retryAfter=${retry}s`);
    res.setHeader('Retry-After', String(retry));
    res.status(429).json({ error: this.opts.message, code: 'RATE_LIMITED', retryAfterSec: retry });
    return true;
  }

  /**
   * Middleware "consume antes": cada request cuenta como intento. Para
   * endpoints donde no hay noción de éxito/fallo (forgot-password, verify).
   */
  middleware(keyOf: (req: Request) => string) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const key = keyOf(req);
      if (this.reject(key, res)) return;
      this.record(key);
      next();
    };
  }

  /** Solo para tests. */
  _size(): number { return this.buckets.size; }
}

function maskKey(key: string): string {
  const at = key.indexOf('@');
  if (at <= 1) return key.slice(0, 2) + '…';
  return key.slice(0, 2) + '…' + key.slice(at);
}

export function emailKey(req: Request): string {
  const raw = (req.body && typeof req.body.email === 'string') ? req.body.email : '';
  return raw.trim().toLowerCase() || `ip:${req.ip ?? 'unknown'}`;
}

export function ipKey(req: Request): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

const MIN = 60_000;

/** Login: 10 contraseñas incorrectas seguidas sobre el mismo email → 15 min. */
export const loginLimiter = new AuthRateLimiter({
  name: 'login',
  max: 10,
  windowMs: 15 * MIN,
  message: 'Demasiados intentos fallidos. Esperá 15 minutos o usá «Olvidé mi contraseña».',
});

/** Forgot password: 3 links por email cada 15 min. */
export const forgotPasswordLimiter = new AuthRateLimiter({
  name: 'forgot-password',
  max: 3,
  windowMs: 15 * MIN,
  message: 'Ya te mandamos un link hace poco. Revisá la casilla (y spam) o esperá unos minutos.',
});

/**
 * Reset / verify: los tokens son de 256 bits, adivinarlos es imposible; el
 * límite es solo para que nadie nos haga barrer la tabla a lo loco. Por IP
 * (global detrás del proxy), así que generoso.
 */
export const tokenEndpointLimiter = new AuthRateLimiter({
  name: 'token-endpoint',
  max: 120,
  windowMs: 15 * MIN,
  message: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
});
