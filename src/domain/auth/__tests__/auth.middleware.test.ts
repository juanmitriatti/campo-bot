import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole, setAccountLookupForTests } from '../../../middleware/auth.middleware.js';

const JWT_SECRET = 'test-middleware-secret';

function mockReqRes(authHeader?: string) {
  const req: any = { headers: { authorization: authHeader } };
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('requireAuth', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    setAccountLookupForTests(async () => ({ exists: true, status: 'active', role: 'end_user' }));
  });

  it('passes with valid access token', async () => {
    const token = jwt.sign({ userId: 1, role: 'end_user', type: 'access' }, JWT_SECRET, { expiresIn: '15m' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.auth).toBeDefined();
    expect(req.auth.userId).toBe(1);
    expect(req.auth.role).toBe('end_user');
  });

  it('rejects missing header', async () => {
    const { req, res, next } = mockReqRes();
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects invalid token', async () => {
    const { req, res, next } = mockReqRes('Bearer invalid-token');
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects refresh token (wrong type)', async () => {
    const token = jwt.sign({ userId: 1, role: 'end_user', type: 'refresh' }, JWT_SECRET, { expiresIn: '7d' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects expired token', async () => {
    const token = jwt.sign({ userId: 1, role: 'end_user', type: 'access' }, JWT_SECRET, { expiresIn: '0s' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    // Token expires immediately
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  // CTA-16: el token de una cuenta suspendida, borrada o degradada deja de servir ya.
  it('rechaza el token de una cuenta suspendida', async () => {
    setAccountLookupForTests(async () => ({ exists: true, status: 'suspended', role: 'end_user' }));
    const token = jwt.sign({ userId: 7, role: 'end_user', type: 'access' }, JWT_SECRET, { expiresIn: '15m' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza el token de una cuenta borrada', async () => {
    setAccountLookupForTests(async () => ({ exists: false, status: null, role: null }));
    const token = jwt.sign({ userId: 8, role: 'end_user', type: 'access' }, JWT_SECRET, { expiresIn: '15m' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('un admin degradado pierde el rol aunque el token diga admin', async () => {
    setAccountLookupForTests(async () => ({ exists: true, status: 'active', role: 'end_user' }));
    const token = jwt.sign({ userId: 9, role: 'admin', type: 'access' }, JWT_SECRET, { expiresIn: '15m' });
    const { req, res, next } = mockReqRes(`Bearer ${token}`);
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.auth.role).toBe('end_user');
  });
});

describe('requireRole', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  it('passes when role matches', () => {
    const middleware = requireRole('admin');
    const { req, res, next } = mockReqRes();
    req.auth = { userId: 1, role: 'admin', type: 'access' };
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects when role does not match', () => {
    const middleware = requireRole('admin');
    const { req, res, next } = mockReqRes();
    req.auth = { userId: 1, role: 'end_user', type: 'access' };
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts multiple roles', () => {
    const middleware = requireRole('admin', 'end_user');
    const { req, res, next } = mockReqRes();
    req.auth = { userId: 1, role: 'end_user', type: 'access' };
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects missing auth', () => {
    const middleware = requireRole('admin');
    const { req, res, next } = mockReqRes();
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
