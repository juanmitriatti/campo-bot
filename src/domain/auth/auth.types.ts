export type UserRole = 'admin' | 'end_user';

export interface JwtPayload {
  userId: number;
  role: UserRole;
  type: 'access' | 'refresh';
}

export interface RegisterBody {
  name: string;
  last_name?: string;
  email: string;
  password: string;
  plan_id?: number;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ProfileUpdateBody {
  name?: string;
  last_name?: string;
  email?: string;
  city?: string;
}

export interface AuthUser {
  id: number;
  name: string | null;
  last_name: string | null;
  email: string | null;
  role: UserRole;
  city: string | null;
  province: string | null;
  plan_id: number | null;
}
