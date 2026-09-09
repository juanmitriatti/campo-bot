import { notifyMutation } from './mutations';

const API_BASE = '/api/auth';

/** Rutas no-GET que NO mutan estado del servidor (no invalidan caches). */
const NO_MUTATION_ENDPOINTS = ['/data-analysis'];

/**
 * Endpoints públicos de auth: un 401 acá es "credenciales inválidas", no
 * "sesión vencida". Antes, con un accessToken viejo en localStorage, una
 * contraseña equivocada disparaba el refresh y, si fallaba, borraba la sesión
 * y recargaba /login con "Sesión expirada" en vez de mostrar el error real.
 */
const PUBLIC_AUTH_ENDPOINTS = ['/login', '/register', '/refresh', '/forgot-password', '/reset-password', '/verify-email'];

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}

function clearSession(): void {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem('accessToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Refresh single-flight. Al volver a la pestaña después de 15 min, todas las
 * requests del dashboard salen juntas con el access vencido: N 401 → N
 * refresh en paralelo con el MISMO refresh token. El primero rota (revoca el
 * viejo), los demás fallan con "Token expirado" y el cliente cerraba la
 * sesión. Ahora todos esperan la misma promesa.
 */
let refreshInFlight: Promise<boolean> | null = null;

function tryRefreshToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = localStorage.getItem('refreshToken');
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.accessToken || !data?.refreshToken) return false;
      localStorage.setItem('accessToken', data.accessToken);
      localStorage.setItem('refreshToken', data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/**
 * Núcleo compartido: manda la request con el bearer actual y, ante un 401 en
 * una ruta protegida, refresca UNA vez y reintenta. Si el refresh falla, cierra
 * la sesión y manda al login.
 */
async function send<T>(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: BodyInit },
  opts: { isPublic: boolean },
): Promise<T> {
  const hadToken = !!localStorage.getItem('accessToken');
  let res = await fetch(url, { ...init, headers: { ...init.headers, ...authHeader() } });

  if (res.status === 401 && hadToken && !opts.isPublic) {
    const refreshed = await tryRefreshToken();
    if (!refreshed) {
      clearSession();
      window.location.href = '/login';
      throw new ApiError(401, 'Sesión expirada');
    }
    res = await fetch(url, { ...init, headers: { ...init.headers, ...authHeader() } });
  }

  let data: any = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || 'Error del servidor', data?.code);
  }
  return data as T;
}

function isPublicAuthEndpoint(endpoint: string): boolean {
  return PUBLIC_AUTH_ENDPOINTS.some(p => endpoint === p || endpoint.startsWith(`${p}?`));
}

export async function apiRequest<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;
  const data = await send<T>(
    `${API_BASE}${endpoint}`,
    { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined },
    { isPublic: isPublicAuthEndpoint(endpoint) },
  );
  // Un POST de consulta (análisis con IA) no escribe nada: sin esta exclusión
  // cada pregunta refetcheaba el Resumen y las analíticas agronómicas.
  if (!NO_MUTATION_ENDPOINTS.some(p => endpoint.startsWith(p))) notifyMutation(method, endpoint);
  return data;
}

// --- Generic fetch for any API path (not just /api/auth) ---

export async function fetchApi<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, headers = {} } = options;
  const data = await send<T>(
    path,
    { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined },
    { isPublic: false },
  );
  notifyMutation(method, path);
  return data;
}

// --- Multipart upload (audio) ---

export async function apiUpload<T = unknown>(path: string, formData: FormData): Promise<T> {
  // Do NOT set Content-Type — browser sets it with multipart boundary
  const data = await send<T>(path, { method: 'POST', headers: {}, body: formData }, { isPublic: false });
  notifyMutation('POST', path);
  return data;
}
