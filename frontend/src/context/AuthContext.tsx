import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { apiRequest, ApiError } from '../api/client';

export type UserRole = 'admin' | 'end_user';

export interface User {
  id: number;
  name: string | null;
  email: string | null;
  role: UserRole;
  city: string | null;
  plan_id: number | null;
}

interface Plan {
  id: number;
  name: string;
  display_name: string;
  price_ars: number;
}

interface ProfileData {
  user: User;
  plan: Plan | null;
  features: string[];
}

interface AuthState {
  user: User | null;
  plan: Plan | null;
  features: string[];
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string, planId?: number) => Promise<User>;
  logout: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [features, setFeatures] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clearError = useCallback(() => setError(null), []);

  // Load profile on mount if token exists
  useEffect(() => {
    const token = localStorage.getItem('accessToken');
    if (!token) {
      setLoading(false);
      return;
    }

    apiRequest<ProfileData>('/me')
      .then(data => {
        setUser(data.user);
        setPlan(data.plan);
        setFeatures(data.features);
      })
      .catch(() => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<User> => {
    setError(null);
    try {
      const data = await apiRequest<{ user: User; tokens: { accessToken: string; refreshToken: string } }>(
        '/login',
        { method: 'POST', body: { email, password } }
      );
      localStorage.setItem('accessToken', data.tokens.accessToken);
      localStorage.setItem('refreshToken', data.tokens.refreshToken);
      setUser(data.user);

      // Fetch full profile for plan/features
      const profile = await apiRequest<ProfileData>('/me');
      setPlan(profile.plan);
      setFeatures(profile.features);

      return data.user;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Error de conexión';
      setError(msg);
      throw err;
    }
  }, []);

  const register = useCallback(async (name: string, email: string, password: string, planId?: number): Promise<User> => {
    setError(null);
    try {
      const body: Record<string, unknown> = { name, email, password };
      if (planId) body.plan_id = planId;

      const data = await apiRequest<{ user: User; tokens: { accessToken: string; refreshToken: string } }>(
        '/register',
        { method: 'POST', body }
      );
      localStorage.setItem('accessToken', data.tokens.accessToken);
      localStorage.setItem('refreshToken', data.tokens.refreshToken);
      setUser(data.user);

      const profile = await apiRequest<ProfileData>('/me');
      setPlan(profile.plan);
      setFeatures(profile.features);

      return data.user;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Error de conexión';
      setError(msg);
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (refreshToken) {
      apiRequest('/logout', { method: 'POST', body: { refreshToken } }).catch(() => {});
    }
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    setUser(null);
    setPlan(null);
    setFeatures([]);
  }, []);

  return (
    <AuthContext.Provider value={{ user, plan, features, loading, error, login, register, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
