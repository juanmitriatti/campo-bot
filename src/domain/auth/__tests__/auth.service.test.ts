import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$12$hashedpassword'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// Mock pool
vi.mock('../../../config/db.js', () => ({
  pool: { query: vi.fn() },
}));

const JWT_SECRET = 'test-secret-key-for-testing';

describe('AuthService', () => {
  let AuthService: any;
  let AuthError: any;
  let mockAuthRepo: any;
  let mockTokenRepo: any;
  let mockPlanRepo: any;

  beforeEach(async () => {
    vi.resetModules();
    process.env.JWT_SECRET = JWT_SECRET;

    mockAuthRepo = {
      findByEmail: vi.fn(),
      getUserById: vi.fn(),
      createUser: vi.fn(),
      updateProfile: vi.fn(),
      findByPhone: vi.fn(),
      setRole: vi.fn(),
      setPasswordHash: vi.fn(),
    };

    mockTokenRepo = {
      saveRefreshToken: vi.fn(),
      findValidToken: vi.fn(),
      revokeToken: vi.fn(),
      revokeAllUserTokens: vi.fn(),
      cleanExpiredTokens: vi.fn(),
    };

    mockPlanRepo = {
      getAllPlans: vi.fn().mockResolvedValue([{ id: 1, name: 'free', display_name: 'Gratis', price_ars: 0, is_active: true }]),
      getPlanById: vi.fn().mockResolvedValue({ id: 1, name: 'free' }),
      getPlanFeatures: vi.fn().mockResolvedValue(['expenses', 'incomes', 'fields']),
    };

    const mod = await import('../auth.service.js');
    AuthService = mod.AuthService;
    AuthError = mod.AuthError;
  });

  describe('register', () => {
    it('creates user and returns tokens', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue(null);
      mockAuthRepo.createUser.mockResolvedValue({
        id: 1, name: 'Test', email: 'test@test.com', role: 'end_user',
        city: null, address: null, postal_code: null, province: null, plan_id: 1,
      });

      const result = await service.register({
        name: 'Test', email: 'test@test.com', password: 'password123',
      });

      expect(result.user.email).toBe('test@test.com');
      expect(result.tokens.accessToken).toBeDefined();
      expect(result.tokens.refreshToken).toBeDefined();
      expect(mockAuthRepo.createUser).toHaveBeenCalledWith({
        name: 'Test', email: 'test@test.com',
        passwordHash: '$2b$12$hashedpassword', planId: 1,
      });
      expect(mockTokenRepo.saveRefreshToken).toHaveBeenCalled();
    });

    it('rejects missing fields', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      await expect(service.register({ name: '', email: 'a@b.com', password: 'pass1234' }))
        .rejects.toThrow('El email, nombre y contraseña son obligatorios');
    });

    it('rejects short password', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      await expect(service.register({ name: 'Test', email: 'a@b.com', password: 'short' }))
        .rejects.toThrow('La contraseña debe tener al menos 8 caracteres');
    });

    it('rejects duplicate email', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue({ id: 1 });
      try {
        await service.register({ name: 'Test', email: 'dup@test.com', password: 'password123' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(AuthError);
        expect(err.status).toBe(409);
        expect(err.message).toBe('Ya existe una cuenta con este email');
      }
    });
  });

  describe('login', () => {
    it('returns user and tokens on valid credentials', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue({
        id: 1, name: 'Test', email: 'test@test.com', role: 'end_user',
        password_hash: '$2b$12$hashedpassword',
        city: null, address: null, postal_code: null, province: null, plan_id: 1,
      });

      const result = await service.login({ email: 'test@test.com', password: 'password123' });
      expect(result.user.id).toBe(1);
      expect(result.tokens.accessToken).toBeDefined();
    });

    it('rejects unknown email', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue(null);
      try {
        await service.login({ email: 'no@exist.com', password: 'password123' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(401);
        expect(err.message).toBe('Credenciales inválidas');
      }
    });

    it('rejects WhatsApp-only user (no password)', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue({
        id: 1, email: 'wa@test.com', password_hash: null, role: 'end_user',
      });
      try {
        await service.login({ email: 'wa@test.com', password: 'anything' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(401);
        expect(err.message).toBe('Esta cuenta no tiene contraseña. Registrate primero.');
      }
    });

    it('rejects wrong password', async () => {
      const bcryptMod = await import('bcrypt');
      (bcryptMod.default.compare as any).mockResolvedValueOnce(false);
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue({
        id: 1, email: 'test@test.com', password_hash: '$2b$12$hash', role: 'end_user',
      });
      try {
        await service.login({ email: 'test@test.com', password: 'wrong' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(401);
        expect(err.message).toBe('Credenciales inválidas');
      }
    });
  });

  describe('refreshTokens', () => {
    it('rotates tokens', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      // Generate a valid refresh token
      const refreshToken = jwt.sign(
        { userId: 1, role: 'end_user', type: 'refresh' },
        JWT_SECRET, { expiresIn: '7d' }
      );

      mockTokenRepo.findValidToken.mockResolvedValue({ id: 1, user_id: 1, expires_at: new Date(Date.now() + 86400000) });
      mockAuthRepo.getUserById.mockResolvedValue({
        id: 1, name: 'Test', email: 'test@test.com', role: 'end_user',
        city: null, address: null, postal_code: null, province: null, plan_id: 1,
      });

      const newTokens = await service.refreshTokens(refreshToken);
      expect(newTokens.accessToken).toBeDefined();
      expect(newTokens.refreshToken).toBeDefined();
      expect(mockTokenRepo.revokeToken).toHaveBeenCalled();
      expect(mockTokenRepo.saveRefreshToken).toHaveBeenCalled();
    });

    it('rejects invalid token', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      try {
        await service.refreshTokens('invalid-token');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(401);
      }
    });
  });

  describe('getProfile', () => {
    it('returns user with plan and features', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.getUserById.mockResolvedValue({
        id: 1, name: 'Test', email: 'test@test.com', role: 'end_user',
        city: null, address: null, postal_code: null, province: null, plan_id: 1,
      });

      const result = await service.getProfile(1);
      expect(result?.user.email).toBe('test@test.com');
      expect(result?.features).toEqual(['expenses', 'incomes', 'fields']);
    });

    it('returns null for unknown user', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.getUserById.mockResolvedValue(null);
      const result = await service.getProfile(999);
      expect(result).toBeNull();
    });
  });

  describe('updateProfile', () => {
    it('updates allowed fields', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue(null);
      mockAuthRepo.updateProfile.mockResolvedValue({
        id: 1, name: 'Updated', email: 'new@test.com', role: 'end_user',
        city: null, address: null, postal_code: null, province: null, plan_id: 1,
      });

      const result = await service.updateProfile(1, { name: 'Updated', email: 'new@test.com' });
      expect(result.name).toBe('Updated');
    });

    it('rejects empty update', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      await expect(service.updateProfile(1, {}))
        .rejects.toThrow('No se proporcionaron campos para actualizar');
    });

    it('rejects duplicate email on update', async () => {
      const service = new AuthService(mockAuthRepo, mockTokenRepo, mockPlanRepo);
      mockAuthRepo.findByEmail.mockResolvedValue({ id: 2 }); // different user
      try {
        await service.updateProfile(1, { email: 'taken@test.com' });
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.status).toBe(409);
      }
    });
  });
});
