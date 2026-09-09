import { describe, it, expect, vi } from 'vitest';
import { AuthRateLimiter, emailKey } from '../auth-rate-limit.js';

function fakeRes() {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: null as unknown,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res;
}

describe('AuthRateLimiter', () => {
  it('bloquea recién al llegar al máximo y libera al vencer la ventana', () => {
    let now = 1_000_000;
    const lim = new AuthRateLimiter({ name: 't', max: 3, windowMs: 60_000, message: 'stop' }, () => now);

    expect(lim.isBlocked('a@x.com')).toBe(false);
    expect(lim.record('a@x.com')).toBe(false);
    expect(lim.record('a@x.com')).toBe(false);
    expect(lim.record('a@x.com')).toBe(true);
    expect(lim.isBlocked('a@x.com')).toBe(true);
    // otra clave no se ve afectada
    expect(lim.isBlocked('b@x.com')).toBe(false);

    now += 60_001;
    expect(lim.isBlocked('a@x.com')).toBe(false);
  });

  it('reset() libera la clave (login correcto borra los fallos previos)', () => {
    const lim = new AuthRateLimiter({ name: 't', max: 2, windowMs: 60_000, message: 'stop' });
    lim.record('a@x.com'); lim.record('a@x.com');
    expect(lim.isBlocked('a@x.com')).toBe(true);
    lim.reset('a@x.com');
    expect(lim.isBlocked('a@x.com')).toBe(false);
  });

  it('reject() responde 429 con Retry-After y código, y no responde si no está bloqueada', () => {
    let now = 5_000_000;
    const lim = new AuthRateLimiter({ name: 't', max: 1, windowMs: 30_000, message: 'esperá' }, () => now);
    const free = fakeRes();
    expect(lim.reject('k', free)).toBe(false);
    expect(free.statusCode).toBe(200);

    lim.record('k');
    now += 10_000;
    const res = fakeRes();
    expect(lim.reject('k', res)).toBe(true);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('20');
    expect(res.body).toMatchObject({ error: 'esperá', code: 'RATE_LIMITED', retryAfterSec: 20 });
  });

  it('middleware(): consume un intento por request y corta con 429 al pasarse', () => {
    const lim = new AuthRateLimiter({ name: 't', max: 2, windowMs: 60_000, message: 'stop' });
    const mw = lim.middleware(emailKey);
    const next = vi.fn();
    const req: any = { body: { email: ' Foo@Bar.com ' }, ip: '1.1.1.1' };

    mw(req, fakeRes(), next);
    mw(req, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);

    const res = fakeRes();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
  });

  it('emailKey normaliza el email y cae a la IP cuando no hay email', () => {
    expect(emailKey({ body: { email: ' Foo@Bar.com ' }, ip: '9.9.9.9' } as any)).toBe('foo@bar.com');
    expect(emailKey({ body: {}, ip: '9.9.9.9' } as any)).toBe('ip:9.9.9.9');
  });

  it('barre las claves vencidas para no crecer sin límite', () => {
    let now = 0;
    const lim = new AuthRateLimiter({ name: 't', max: 5, windowMs: 1_000, message: 'stop' }, () => now);
    for (let i = 0; i < 100; i++) lim.record(`u${i}@x.com`);
    expect(lim._size()).toBe(100);
    now += 2_000;
    lim.record('fresh@x.com');
    expect(lim._size()).toBe(1);
  });
});
