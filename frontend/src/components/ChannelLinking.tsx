import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Pencil, X, Check, Lock } from 'lucide-react';
import { apiRequest, ApiError } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../hooks/useTheme';

interface VerificationStatus {
  whatsapp_verified: boolean;
  telegram_verified: boolean;
  phone_number: string | null;
  telegram_id: string | null;
}

interface SubscriptionRow {
  id: number;
  status: 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';
  billing_period: 'monthly' | 'yearly';
  trial_ends_at: string | null;
  current_period_end: string | null;
  provider: string;
}

interface SubscriptionStatus {
  subscription: SubscriptionRow | null;
  plan: {
    id: number;
    name: string;
    display_name: string;
    price_ars: number;
    price_ars_yearly: number | null;
  } | null;
  payments_enabled: boolean;
}

type WaStep = 'idle' | 'enter-phone' | 'enter-code' | 'success';

function AppearanceCard() {
  const [theme, , toggleTheme] = useTheme();
  const isDark = theme === 'dark';
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="text-3xl">{isDark ? '🌙' : '🌞'}</div>
          <div>
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Apariencia</h3>
            <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
              Modo actual: <span className="font-medium">{isDark ? 'Oscuro' : 'Claro'}</span>
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-1.5 text-sm text-gray-700 hover:text-gray-900 border border-gray-300 bg-white rounded-md px-4 py-2 transition-colors hover:bg-gray-50 dark:text-gray-200 dark:hover:text-white dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          Cambiar a modo {isDark ? 'claro' : 'oscuro'}
        </button>
      </div>
    </div>
  );
}

export default function ChannelLinking() {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // WhatsApp flow state
  const [waStep, setWaStep] = useState<WaStep>('idle');
  const [waPhone, setWaPhone] = useState('');
  const [waCode, setWaCode] = useState('');
  const [waExpiresAt, setWaExpiresAt] = useState<string | null>(null);
  const [waBusy, setWaBusy] = useState(false);
  const [waError, setWaError] = useState<string | null>(null);

  // Telegram flow state
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [tgBusy, setTgBusy] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  // Delete state

  // Subscription state
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');

  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // Perfil editable
  const [profileEditing, setProfileEditing] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileLastName, setProfileLastName] = useState('');
  const [profileCity, setProfileCity] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  // Local shadow of user profile (refreshed after save)
  const [localUser, setLocalUser] = useState<{ name: string | null; last_name: string | null; city: string | null; email: string | null } | null>(null);

  useEffect(() => {
    if (user) {
      setLocalUser({ name: user.name, last_name: user.last_name ?? null, city: user.city, email: user.email });
    }
  }, [user]);

  const refreshStatus = async () => {
    try {
      const s = await apiRequest<VerificationStatus>('/verify/status');
      setStatus(s);
    } catch {
      // ignore
    }
  };

  const refreshSub = async () => {
    try {
      const s = await apiRequest<SubscriptionStatus>('/subscription');
      setSub(s);
    } catch {
      // ignore (e.g. payments_enabled=false → endpoint still returns)
    }
  };

  useEffect(() => {
    Promise.all([refreshStatus(), refreshSub()]).finally(() => setLoading(false));
  }, []);

  // ---------- Subscription ----------
  const upgradeNow = async (planName: string) => {
    setSubError(null);
    setSubBusy(true);
    try {
      const r = await apiRequest<{ init_point: string }>('/subscription/checkout', {
        method: 'POST',
        body: { plan: planName, period: billingPeriod },
      });
      window.location.href = r.init_point;
    } catch (err) {
      setSubError(err instanceof ApiError ? err.message : 'No pude iniciar el checkout.');
      setSubBusy(false);
    }
  };

  const cancelSub = async () => {
    if (!confirm('¿Cancelar la suscripción? Vas a tener acceso hasta el fin del período pagado.')) return;
    setSubBusy(true);
    try {
      await apiRequest('/subscription/cancel', { method: 'POST' });
      await refreshSub();
    } catch (err) {
      setSubError(err instanceof ApiError ? err.message : 'No pude cancelar.');
    } finally {
      setSubBusy(false);
    }
  };

  // ---------- WhatsApp ----------
  const startWhatsApp = async () => {
    setWaError(null);
    if (!waPhone.trim()) {
      setWaError('Ingresá tu número de WhatsApp.');
      return;
    }
    setWaBusy(true);
    try {
      const r = await apiRequest<{ expires_at: string; ttl_minutes: number }>(
        '/verify/whatsapp/start',
        { method: 'POST', body: { phone: waPhone.trim() } },
      );
      setWaExpiresAt(r.expires_at);
      setWaStep('enter-code');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude iniciar la verificación.');
    } finally {
      setWaBusy(false);
    }
  };

  const confirmWhatsApp = async () => {
    setWaError(null);
    if (!/^\d{6}$/.test(waCode.trim())) {
      setWaError('El código tiene que ser de 6 dígitos.');
      return;
    }
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>(
        '/verify/whatsapp/confirm',
        { method: 'POST', body: { code: waCode.trim() } },
      );
      setStatus(s);
      setWaStep('success');
      setWaCode('');
      setTimeout(() => setWaStep('idle'), 2500);
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude confirmar el código.');
    } finally {
      setWaBusy(false);
    }
  };

  const unlinkWhatsApp = async () => {
    if (!confirm('¿Seguro que querés desvincular WhatsApp? Vas a tener que verificar de nuevo si querés volver a usar el bot.')) return;
    setWaBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/whatsapp', { method: 'DELETE' });
      setStatus(s);
      setWaStep('idle');
      setWaPhone('');
    } catch (err) {
      setWaError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setWaBusy(false);
    }
  };

  // ---------- Telegram ----------
  const startTelegram = async () => {
    setTgError(null);
    setTgBusy(true);
    try {
      const r = await apiRequest<{ deep_link: string; expires_at: string }>(
        '/verify/telegram/start',
        { method: 'POST' },
      );
      setTgLink(r.deep_link);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude generar el link.');
    } finally {
      setTgBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    if (!confirm('¿Seguro que querés desvincular Telegram?')) return;
    setTgBusy(true);
    try {
      const s = await apiRequest<VerificationStatus>('/verify/telegram', { method: 'DELETE' });
      setStatus(s);
      setTgLink(null);
    } catch (err) {
      setTgError(err instanceof ApiError ? err.message : 'No pude desvincular.');
    } finally {
      setTgBusy(false);
    }
  };

  // ---------- Cambio de contraseña ----------
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwRepeat, setPwRepeat] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (logoutTimerRef.current !== null) clearTimeout(logoutTimerRef.current);
    };
  }, []);

  const changePassword = async () => {
    setPwError(null);
    if (pwNew.length < 8) {
      setPwError('La nueva contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (pwNew !== pwRepeat) {
      setPwError('Las contraseñas no coinciden.');
      return;
    }
    setPwBusy(true);
    try {
      await apiRequest('/me/password', {
        method: 'POST',
        body: { currentPassword: pwCurrent, newPassword: pwNew },
      });
      setPwSuccess(true);
      setPwCurrent('');
      setPwNew('');
      setPwRepeat('');
      logoutTimerRef.current = setTimeout(() => {
        logout();
        navigate('/login');
      }, 2000);
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : 'No pude cambiar la contraseña.');
    } finally {
      setPwBusy(false);
    }
  };

  // ---------- Perfil ----------
  const startEditProfile = () => {
    setProfileName(localUser?.name ?? '');
    setProfileLastName(localUser?.last_name ?? '');
    setProfileCity(localUser?.city ?? '');
    setProfileEmail(localUser?.email ?? '');
    setProfileError(null);
    setProfileSuccess(false);
    setProfileEditing(true);
  };

  const cancelEditProfile = () => {
    setProfileEditing(false);
    setProfileError(null);
  };

  const saveProfile = async () => {
    setProfileError(null);
    setProfileBusy(true);
    try {
      const body: Record<string, string> = {};
      if (profileName !== (localUser?.name ?? '')) body.name = profileName;
      if (profileLastName !== (localUser?.last_name ?? '')) body.last_name = profileLastName;
      if (profileCity !== (localUser?.city ?? '')) body.city = profileCity;
      if (profileEmail !== (localUser?.email ?? '')) body.email = profileEmail;
      if (Object.keys(body).length === 0) { setProfileEditing(false); return; }
      const result = await apiRequest<{ user: { id: number; name: string | null; last_name: string | null; city: string | null; email: string | null } }>(
        '/me',
        { method: 'PATCH', body },
      );
      setLocalUser({ name: result.user.name, last_name: result.user.last_name ?? null, city: result.user.city, email: result.user.email });
      setProfileSuccess(true);
      setProfileEditing(false);
      setTimeout(() => setProfileSuccess(false), 3000);
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'No pude guardar los cambios.');
    } finally {
      setProfileBusy(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-gray-500 dark:text-gray-300">Cargando…</div>;
  }

  function statusLabel(s: string): string {
    switch (s) {
      case 'trial': return 'En prueba gratis';
      case 'active': return 'Activa';
      case 'past_due': return 'Pago pendiente';
      case 'cancelled': return 'Cancelada';
      case 'expired': return 'Expirada';
      default: return s;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-800 dark:text-gray-100">Mi cuenta</h2>
        <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">
          Vinculá tu WhatsApp y/o Telegram para usar el bot desde tus chats.
        </p>
      </div>

      {/* Tu perfil card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="text-3xl">👤</div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Tu perfil</h3>
              <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">Nombre, ciudad y email de tu cuenta.</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => { setPwCurrent(''); setPwNew(''); setPwRepeat(''); setPwError(null); setPwModalOpen(true); }}
              className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors"
              title="Cambiar contraseña"
            >
              <Lock className="w-4 h-4" />
              <span className="hidden sm:inline">Contraseña</span>
            </button>
            {!profileEditing && (
              <button
                type="button"
                onClick={startEditProfile}
                className="flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition-colors"
                title="Editar perfil"
              >
                <Pencil className="w-4 h-4" />
                <span className="hidden sm:inline">Editar</span>
              </button>
            )}
          </div>
        </div>

        {profileSuccess && (
          <div className="mt-3 flex items-center gap-2 text-green-700 dark:text-green-400 text-sm">
            <Check className="w-4 h-4" />
            Perfil actualizado correctamente.
          </div>
        )}

        {!profileEditing ? (
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Nombre</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.name || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Apellido</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.last_name || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Ciudad</dt>
              <dd className="text-gray-800 dark:text-gray-100">{localUser?.city || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Email</dt>
              <dd className="text-gray-800 dark:text-gray-100 font-mono text-xs">{localUser?.email || <span className="italic text-gray-400">—</span>}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 text-gray-500 dark:text-gray-400 shrink-0">Teléfono</dt>
              <dd className="text-gray-500 dark:text-gray-400 italic text-xs">Se cambia desde la card de WhatsApp, más abajo.</dd>
            </div>
          </dl>
        ) : (
          <div className="mt-4 space-y-3 max-w-sm">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nombre</label>
              <input
                type="text"
                value={profileName}
                onChange={e => setProfileName(e.target.value)}
                disabled={profileBusy}
                placeholder="Tu nombre"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Apellido</label>
              <input
                type="text"
                value={profileLastName}
                onChange={e => setProfileLastName(e.target.value)}
                disabled={profileBusy}
                placeholder="Tu apellido"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Ciudad</label>
              <input
                type="text"
                value={profileCity}
                onChange={e => setProfileCity(e.target.value)}
                disabled={profileBusy}
                placeholder="Tu ciudad"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Email</label>
              <input
                type="email"
                value={profileEmail}
                onChange={e => setProfileEmail(e.target.value)}
                disabled={profileBusy}
                placeholder="tu@email.com"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
              />
              {profileEmail !== (localUser?.email ?? '') && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  ⚠️ Si cambiás el email, vas a tener que verificarlo de nuevo.
                </p>
              )}
            </div>
            {profileError && <p className="text-red-600 dark:text-red-400 text-xs">{profileError}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveProfile}
                disabled={profileBusy}
                className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-campo-600 hover:bg-campo-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
              >
                <Check className="w-4 h-4" />
                {profileBusy ? 'Guardando…' : 'Guardar'}
              </button>
              <button
                type="button"
                onClick={cancelEditProfile}
                disabled={profileBusy}
                className="flex items-center gap-1.5 px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                <X className="w-4 h-4" />
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      <AppearanceCard />

      {/* Modal de cambio de contraseña (se abre desde Tu perfil) */}
      {pwModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
                  <Lock className="w-5 h-5 text-campo-600 dark:text-campo-400" />
                  Cambiar contraseña
                </h3>
                <button
                  onClick={() => setPwModalOpen(false)}
                  disabled={pwBusy}
                  className="text-gray-400 dark:text-gray-300 hover:text-gray-600 dark:hover:text-gray-100 text-xl leading-none disabled:opacity-50"
                >&times;</button>
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-300 mb-4">Tu contraseña de acceso al dashboard.</p>
              {pwSuccess ? (
                <p className="text-green-700 dark:text-green-400 text-sm font-medium">
                  ✅ Contraseña actualizada. Vas a tener que iniciar sesión de nuevo.
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Contraseña actual</label>
                    <input
                      type="password"
                      value={pwCurrent}
                      onChange={e => setPwCurrent(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Tu contraseña actual"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Nueva contraseña</label>
                    <input
                      type="password"
                      value={pwNew}
                      onChange={e => setPwNew(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Mínimo 8 caracteres"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">Repetir nueva contraseña</label>
                    <input
                      type="password"
                      value={pwRepeat}
                      onChange={e => setPwRepeat(e.target.value)}
                      disabled={pwBusy}
                      placeholder="Repetí la nueva contraseña"
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                    />
                  </div>
                  {pwError && <p className="text-red-600 dark:text-red-400 text-xs">{pwError}</p>}
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={changePassword}
                      disabled={pwBusy || !pwCurrent || !pwNew || !pwRepeat}
                      className="px-4 py-2 rounded-md bg-campo-600 hover:bg-campo-700 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      {pwBusy ? 'Cambiando…' : 'Cambiar contraseña'}
                    </button>
                    <button
                      onClick={() => setPwModalOpen(false)}
                      disabled={pwBusy}
                      className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Canales: WhatsApp + Telegram lado a lado en desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
      {/* WhatsApp card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[#25D366] flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/>
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">WhatsApp</h3>
              {status?.whatsapp_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.phone_number}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.whatsapp_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={() => { setWaStep('enter-phone'); setWaPhone(''); setWaError(null); }}
                disabled={waBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este WhatsApp, vinculá un número nuevo"
              >
                Cambiar número
              </button>
              <button
                onClick={unlinkWhatsApp}
                disabled={waBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
          )}
        </div>

        {!status?.whatsapp_verified && waStep === 'idle' && (
          <button
            onClick={() => setWaStep('enter-phone')}
            className="mt-4 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700"
          >
            Vincular WhatsApp
          </button>
        )}

        {waStep === 'enter-phone' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Tu número de WhatsApp
            </label>
            <input
              type="tel"
              value={waPhone}
              onChange={e => setWaPhone(e.target.value)}
              placeholder="+54 9 11 1234 5678"
              className="w-full max-w-xs border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            <p className="text-xs text-gray-500 dark:text-gray-300">
              Te vamos a mandar un código de 6 dígitos a este número.
            </p>
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={startWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Enviando…' : 'Enviar código'}
              </button>
              <button
                onClick={() => { setWaStep('idle'); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {waStep === 'enter-code' && (
          <div className="mt-4 space-y-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
              Pegá el código que te llegó por WhatsApp
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={waCode}
              onChange={e => setWaCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="w-32 border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded-md px-3 py-2 text-lg tracking-widest text-center font-mono focus:ring-2 focus:ring-campo-500 focus:border-campo-500 outline-none"
              disabled={waBusy}
            />
            {waExpiresAt && (
              <p className="text-xs text-gray-500">
                El código vence el {new Date(waExpiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}.
              </p>
            )}
            {waError && <p className="text-xs text-red-600">{waError}</p>}
            <div className="flex gap-2">
              <button
                onClick={confirmWhatsApp}
                disabled={waBusy}
                className="px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
              >
                {waBusy ? 'Verificando…' : 'Confirmar'}
              </button>
              <button
                onClick={() => { setWaStep('enter-phone'); setWaCode(''); setWaError(null); }}
                disabled={waBusy}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
              >
                Cambiar número
              </button>
            </div>
          </div>
        )}

        {waStep === 'success' && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-md">
            <p className="text-sm text-green-800 dark:text-green-300">✅ ¡Listo! Ya podés escribirle al bot por WhatsApp.</p>
          </div>
        )}
      </div>

      {/* Telegram card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-[#229ED9] flex items-center justify-center shrink-0">
              <svg viewBox="0 0 24 24" fill="white" className="w-6 h-6" aria-hidden="true">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
            </div>
            <div>
              <h3 className="font-semibold text-gray-800 dark:text-gray-100">Telegram</h3>
              {status?.telegram_verified ? (
                <p className="text-sm text-green-700 mt-1">
                  ✅ Vinculado — <span className="font-mono">{status.telegram_id}</span>
                </p>
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-300 mt-1">No vinculado</p>
              )}
            </div>
          </div>
          {status?.telegram_verified && (
            <div className="flex gap-3 items-center">
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="text-xs text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white disabled:opacity-50"
                title="Si perdiste acceso a este Telegram, generá un link nuevo"
              >
                Vincular otra cuenta
              </button>
              <button
                onClick={unlinkTelegram}
                disabled={tgBusy}
                className="text-xs text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Desvincular
              </button>
            </div>
          )}
        </div>

        {!status?.telegram_verified && (
          <div className="mt-4 space-y-3">
            {!tgLink ? (
              <button
                onClick={startTelegram}
                disabled={tgBusy}
                className="px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
              >
                {tgBusy ? 'Generando…' : 'Generar link de vinculación'}
              </button>
            ) : (
              <div className="space-y-2">
                <a
                  href={tgLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-blue-500 text-white rounded-md text-sm font-medium hover:bg-blue-600"
                >
                  Abrir Telegram y vincular
                </a>
                <p className="text-xs text-gray-500 dark:text-gray-300">
                  Tocá el botón. Se abre Telegram, tocás "Iniciar" y la cuenta queda vinculada automáticamente.
                </p>
                <button
                  onClick={refreshStatus}
                  className="text-xs text-campo-600 hover:underline"
                >
                  Ya vinculé, refrescar estado
                </button>
              </div>
            )}
            {tgError && <p className="text-xs text-red-600">{tgError}</p>}
          </div>
        )}
      </div>
      </div>

      {/* Subscription card */}
      {sub?.payments_enabled && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Header con gradiente + badge de estado */}
          <div className="bg-gradient-to-r from-campo-600 to-campo-800 px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center text-xl">💳</div>
              <div>
                <h3 className="font-semibold text-white leading-tight">Suscripción</h3>
                <p className="text-campo-100 text-sm">
                  {sub.plan ? `Plan ${sub.plan.display_name}` : 'Sin plan activo'}
                </p>
              </div>
            </div>
            {sub.subscription && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 text-white text-xs font-medium backdrop-blur-sm">
                <span className={`w-1.5 h-1.5 rounded-full ${
                  sub.subscription.status === 'active' ? 'bg-green-300' :
                  sub.subscription.status === 'trial' ? 'bg-sky-300' :
                  sub.subscription.status === 'past_due' ? 'bg-amber-300' :
                  'bg-gray-300'
                }`} />
                {statusLabel(sub.subscription.status)}
              </span>
            )}
          </div>

          <div className="p-6 space-y-4">
            {/* Trial / próximo cobro */}
            {sub.subscription?.status === 'trial' && sub.subscription.trial_ends_at && (() => {
              const daysLeft = Math.max(0, Math.ceil((new Date(sub.subscription!.trial_ends_at!).getTime() - Date.now()) / 86400000));
              return (
                <div className="flex items-center gap-2.5 rounded-lg bg-sky-50 dark:bg-sky-900/30 border border-sky-200 dark:border-sky-800 px-4 py-3 text-sm text-sky-800 dark:text-sky-200">
                  <span className="text-lg">⏳</span>
                  <span>
                    Te quedan <span className="font-semibold">{daysLeft} {daysLeft === 1 ? 'día' : 'días'}</span> de prueba gratis
                    {' '}(hasta el {new Date(sub.subscription!.trial_ends_at!).toLocaleDateString('es-AR')}).
                  </span>
                </div>
              );
            })()}
            {sub.subscription?.status !== 'trial' && sub.subscription?.current_period_end && (
              <p className="text-sm text-gray-500 dark:text-gray-300">
                Próximo cobro: {new Date(sub.subscription.current_period_end).toLocaleDateString('es-AR')}
              </p>
            )}
            {!sub.subscription && (
              <p className="text-sm text-gray-500 dark:text-gray-300">Sin suscripción activa.</p>
            )}

            {/* Selector de período + CTA */}
            {(!sub.subscription || sub.subscription.status === 'trial' || sub.subscription.status === 'past_due') && sub.plan && sub.plan.price_ars > 0 && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={() => setBillingPeriod('monthly')}
                    className={`relative text-left rounded-lg border-2 px-4 py-3 transition-colors ${
                      billingPeriod === 'monthly'
                        ? 'border-campo-600 bg-campo-50 dark:bg-campo-900/20'
                        : 'border-gray-200 dark:border-gray-600 hover:border-campo-400 dark:hover:border-campo-500'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Mensual</span>
                      {billingPeriod === 'monthly' && <span className="text-campo-600 dark:text-campo-400 text-sm">✓</span>}
                    </div>
                    <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
                      ${sub.plan.price_ars.toLocaleString('es-AR')}
                      <span className="text-sm font-normal text-gray-500 dark:text-gray-400"> /mes</span>
                    </p>
                  </button>

                  {sub.plan.price_ars_yearly && (() => {
                    const savingsPct = Math.round((1 - sub.plan!.price_ars_yearly! / (sub.plan!.price_ars * 12)) * 100);
                    return (
                      <button
                        onClick={() => setBillingPeriod('yearly')}
                        className={`relative text-left rounded-lg border-2 px-4 py-3 transition-colors ${
                          billingPeriod === 'yearly'
                            ? 'border-campo-600 bg-campo-50 dark:bg-campo-900/20'
                            : 'border-gray-200 dark:border-gray-600 hover:border-campo-400 dark:hover:border-campo-500'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-600 dark:text-gray-300">Anual</span>
                          <span className="flex items-center gap-1.5">
                            {savingsPct > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-campo-100 dark:bg-campo-900/50 text-campo-700 dark:text-campo-300 text-[11px] font-semibold">
                                Ahorrás {savingsPct}%
                              </span>
                            )}
                            {billingPeriod === 'yearly' && <span className="text-campo-600 dark:text-campo-400 text-sm">✓</span>}
                          </span>
                        </div>
                        <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
                          ${sub.plan.price_ars_yearly.toLocaleString('es-AR')}
                          <span className="text-sm font-normal text-gray-500 dark:text-gray-400"> /año</span>
                        </p>
                      </button>
                    );
                  })()}
                </div>

                <button
                  onClick={() => upgradeNow(sub.plan!.name)}
                  disabled={subBusy}
                  className="w-full sm:w-auto px-6 py-3 bg-campo-600 text-white rounded-lg text-sm font-semibold shadow-sm hover:bg-campo-700 active:bg-campo-800 disabled:opacity-50 transition-colors"
                >
                  {subBusy ? 'Redirigiendo…' : 'Pagar con MercadoPago →'}
                </button>
                <p className="text-xs text-gray-400 dark:text-gray-500">Pago seguro procesado por MercadoPago. Podés cancelar cuando quieras.</p>
              </div>
            )}

            {subError && <p className="text-xs text-red-600 mt-2">{subError}</p>}

            {sub.subscription && (sub.subscription.status === 'active' || sub.subscription.status === 'trial') && (
              <div className="pt-3 border-t border-gray-100 dark:border-gray-700">
                <button
                  onClick={cancelSub}
                  disabled={subBusy}
                  className="text-xs text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 transition-colors"
                >
                  Cancelar suscripción
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Guía de uso (visible también en mobile, donde no hay Sidebar) */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex items-start gap-3">
          <div className="text-3xl">📖</div>
          <div className="flex-1">
            <h3 className="font-semibold text-gray-800 dark:text-gray-100">Guía de uso</h3>
            <p className="text-sm text-gray-500 mt-1">
              Todo lo que le podés decir al bot, con ejemplos para copiar: gastos, labores, hacienda, recordatorios y más.
            </p>
            <a
              href="/guia"
              target="_blank"
              rel="noopener"
              className="inline-block mt-3 px-4 py-2 border border-campo-600 text-campo-700 dark:text-campo-400 rounded-md text-sm font-medium hover:bg-campo-50 dark:hover:bg-campo-900/30"
            >
              Ver la guía completa
            </a>
          </div>
        </div>
      </div>

    </div>
  );
}
