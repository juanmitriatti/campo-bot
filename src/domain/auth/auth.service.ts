import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { AuthRepository } from './auth.repository.js';
import { TokenRepository } from './token.repository.js';
import { PlanRepository } from '../billing/plan.repository.js';
import { SubscriptionService } from '../billing/subscription.service.js';
import { logError } from '../../services/error-logger.js';
import { asUserId } from '../../types/index.js';
import type { JwtPayload, TokenPair, RegisterBody, LoginBody, ProfileUpdateBody, AuthUser } from './auth.types.js';

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return secret;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  private auth: AuthRepository;
  private tokens: TokenRepository;
  private plans: PlanRepository;
  private subscriptions: SubscriptionService | null;

  constructor(
    authRepo?: AuthRepository,
    tokenRepo?: TokenRepository,
    planRepo?: PlanRepository,
    subscriptions?: SubscriptionService,
  ) {
    this.auth = authRepo ?? new AuthRepository();
    this.tokens = tokenRepo ?? new TokenRepository();
    this.plans = planRepo ?? new PlanRepository();
    // Lazy default — tests can pass null to skip the trial entirely.
    this.subscriptions = subscriptions === undefined ? new SubscriptionService() : subscriptions;
  }

  async register(body: RegisterBody): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const { name, last_name, email, password, plan_id } = body;

    if (!name || !email || !password) {
      throw new AuthError(400, 'El email, nombre y contraseña son obligatorios');
    }
    if (password.length < 8) {
      throw new AuthError(400, 'La contraseña debe tener al menos 8 caracteres');
    }

    const existing = await this.auth.findByEmail(email);
    if (existing) {
      throw new AuthError(409, 'Ya existe una cuenta con este email');
    }

    // Resolve plan
    let planId: number;
    if (plan_id) {
      const plan = await this.plans.getPlanById(plan_id);
      if (!plan) throw new AuthError(400, 'Plan no encontrado');
      planId = plan.id;
    } else {
      const allPlans = await this.plans.getAllPlans();
      const freePlan = allPlans.find(p => p.name === 'free');
      planId = freePlan ? freePlan.id : 1;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    let user: AuthUser;
    try {
      user = await this.auth.createUser({ name, lastName: last_name, email, passwordHash, planId });
    } catch (err: unknown) {
      // PG unique constraint violation (race condition: findByEmail returned null but another request inserted same email)
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
        throw new AuthError(409, 'Ya existe una cuenta con este email');
      }
      throw err;
    }

    // Best-effort: bootstrap a trial subscription if PAYMENTS_ENABLED.
    // Failures here MUST NOT break registration — the user still gets the free
    // plan that was already assigned above.
    if (this.subscriptions) {
      try {
        const trialPlanName = (body.plan_id ? null : 'pro') as string | null;
        if (trialPlanName) {
          await this.subscriptions.createTrialIfMissing(asUserId(user.id), trialPlanName);
        }
      } catch (err) {
        logError('auth', 'TRIAL_BOOTSTRAP_FAILED', err as Error, { userId: user.id });
      }
    }

    const tokens = await this.generateTokenPair(user.id, user.role);

    return { user, tokens };
  }

  async login(body: LoginBody): Promise<{ user: AuthUser; tokens: TokenPair }> {
    const { email, password } = body;

    if (!email || !password) {
      throw new AuthError(400, 'El email y contraseña son obligatorios');
    }

    const userWithPw = await this.auth.findByEmail(email);
    if (!userWithPw) {
      throw new AuthError(401, 'Credenciales inválidas');
    }

    if (!userWithPw.password_hash) {
      throw new AuthError(401, 'Esta cuenta no tiene contraseña. Registrate primero.');
    }

    const valid = await bcrypt.compare(password, userWithPw.password_hash);
    if (!valid) {
      throw new AuthError(401, 'Credenciales inválidas');
    }

    const { password_hash: _, ...user } = userWithPw;
    const tokens = await this.generateTokenPair(user.id, user.role);

    return { user, tokens };
  }

  async refreshTokens(refreshToken: string): Promise<TokenPair> {
    // Verify JWT signature
    let payload: JwtPayload;
    try {
      payload = jwt.verify(refreshToken, getJwtSecret()) as JwtPayload;
    } catch {
      throw new AuthError(401, 'Token expirado o inválido');
    }

    if (payload.type !== 'refresh') {
      throw new AuthError(401, 'Token expirado o inválido');
    }

    // Check in DB
    const tokenHash = hashToken(refreshToken);
    const stored = await this.tokens.findValidToken(tokenHash);
    if (!stored) {
      throw new AuthError(401, 'Token expirado o inválido');
    }

    // Rotate: revoke old, issue new
    await this.tokens.revokeToken(tokenHash);

    const user = await this.auth.getUserById(payload.userId);
    if (!user) {
      throw new AuthError(401, 'Token expirado o inválido');
    }

    return this.generateTokenPair(user.id, user.role);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await this.tokens.revokeToken(tokenHash);
  }

  async getProfile(userId: number): Promise<{ user: AuthUser; plan: unknown; features: string[] } | null> {
    const user = await this.auth.getUserById(userId);
    if (!user) return null;

    let plan = null;
    let features: string[] = [];
    if (user.plan_id) {
      plan = await this.plans.getPlanById(user.plan_id);
      if (plan) {
        features = await this.plans.getPlanFeatures(plan.id);
      }
    }

    return { user, plan, features };
  }

  async updateProfile(userId: number, body: ProfileUpdateBody): Promise<AuthUser> {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) fields[key] = value;
    }

    if (Object.keys(fields).length === 0) {
      throw new AuthError(400, 'No se proporcionaron campos para actualizar');
    }

    // Check email uniqueness if updating email
    if (fields.email) {
      const existing = await this.auth.findByEmail(fields.email as string);
      if (existing && existing.id !== userId) {
        throw new AuthError(409, 'Ya existe una cuenta con este email');
      }
    }

    const updated = await this.auth.updateProfile(userId, fields);
    if (!updated) throw new AuthError(400, 'No se proporcionaron campos para actualizar');
    return updated;
  }

  private async generateTokenPair(userId: number, role: string): Promise<TokenPair> {
    const secret = getJwtSecret();

    const accessPayload: JwtPayload = { userId, role: role as JwtPayload['role'], type: 'access' };
    const accessToken = jwt.sign(accessPayload, secret, { expiresIn: ACCESS_TOKEN_EXPIRY });

    const refreshPayload: JwtPayload = { userId, role: role as JwtPayload['role'], type: 'refresh' };
    const refreshToken = jwt.sign(refreshPayload, secret, { expiresIn: '7d' });

    // Store refresh token hash
    const tokenHash = hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS);
    await this.tokens.saveRefreshToken(userId, tokenHash, expiresAt);

    return { accessToken, refreshToken };
  }
}

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'AuthError';
  }
}
