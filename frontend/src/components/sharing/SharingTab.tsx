import { useState, useEffect, useCallback } from 'react';
import { Users2, Trash2, Copy, Check, Send, RefreshCw } from 'lucide-react';
import TabHeader from '../TabHeader';
import {
  fetchSharing, inviteToField, revokeInvite, removeMember,
  type SharingOverview, type CreatedInvite, type InviteStatus,
} from '../../api/sharing';
import { useAuth } from '../../context/AuthContext';

const STATUS_LABEL: Record<InviteStatus, string> = {
  pending: 'Pendiente',
  used: 'Aceptada',
  revoked: 'Cancelada',
  expired: 'Vencida',
};

const STATUS_CLASS: Record<InviteStatus, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  used: 'bg-campo-100 text-campo-800 dark:bg-campo-900/30 dark:text-campo-300',
  revoked: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  expired: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * La tarjeta que aparece después de invitar.
 *
 * Muestra un LINK y no un "ya le avisamos" porque el bot no le puede escribir a
 * un número que nunca le habló (ventana de 24 h de Meta, y no hay plantillas
 * aprobadas). El dueño reenvía el link por su propio WhatsApp; el invitado lo
 * toca y le llega el chat con el texto ya escrito.
 */
function InviteResult({ invite, onClose }: { invite: CreatedInvite; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const shareText = invite.waLink ?? `${invite.waText} (código ${invite.invite.code})`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-campo-200 dark:border-campo-800 bg-campo-50 dark:bg-campo-900/20 p-4">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Invitación lista para {invite.invite.phoneLabel}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
        Mandale este link por WhatsApp. Cuando lo toque y envíe el mensaje, entra al campo.
      </p>

      {invite.waLink ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a
            href={invite.waLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-campo-600 px-3 py-2 text-sm font-medium text-white hover:bg-campo-700"
          >
            <Send className="w-4 h-4" /> Abrir WhatsApp
          </a>
          <button
            onClick={copy}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            {copied ? 'Copiado' : 'Copiar link'}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-sm text-gray-700 dark:text-gray-200">
            Pedile que le escriba al bot: <span className="font-mono font-semibold">{invite.waText}</span>
          </p>
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
        Código <span className="font-mono">{invite.invite.code}</span> · vence el {formatDate(invite.invite.expiresAt)} ·
        {' '}solo lo puede usar ese número.
      </p>
      {invite.registerLink && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Si todavía no tiene cuenta, puede crearla acá:{' '}
          <a className="underline" href={invite.registerLink} target="_blank" rel="noreferrer">
            {invite.registerLink}
          </a>
        </p>
      )}

      <button onClick={onClose} className="mt-3 text-xs text-gray-500 hover:underline">
        Listo
      </button>
    </div>
  );
}

export default function SharingTab() {
  const { user } = useAuth();
  const [data, setData] = useState<SharingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [openFieldId, setOpenFieldId] = useState<number | null>(null);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSharing());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'No pude cargar los campos compartidos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submitInvite(fieldId: number) {
    if (!phone.trim()) { setFormError('Escribí el número de la persona.'); return; }
    setSaving(true);
    setFormError(null);
    try {
      const created = await inviteToField(fieldId, phone.trim());
      setResult(created);
      setPhone('');
      await load();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'No pude crear la invitación');
    } finally {
      setSaving(false);
    }
  }

  async function onRevoke(inviteId: number) {
    try { await revokeInvite(inviteId); await load(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'No pude cancelar la invitación'); }
  }

  async function onRemove(fieldId: number, memberId: number, label: string) {
    if (!window.confirm(`¿Sacarle el acceso a ${label}? Los registros que cargó quedan en el campo.`)) return;
    try { await removeMember(fieldId, memberId); await load(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'No pude quitar el acceso'); }
  }

  async function onLeave(fieldId: number, fieldName: string) {
    if (!user) return;
    if (!window.confirm(`¿Salir de ${fieldName}? Vas a dejar de ver sus datos.`)) return;
    try { await removeMember(fieldId, user.id); await load(); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : 'No pude salir del campo'); }
  }

  return (
    <div>
      <TabHeader
        title="Compartir"
        description="Dale acceso a un socio, empleado o ingeniero para que trabaje sobre tus campos. Todo lo que registre queda a su nombre."
        botHint="compartir campo La Esperanza con 11 2345 6789"
      />

      {error && (
        <div className="mb-4 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-gray-500 dark:text-gray-400">Cargando…</p>}

      {!loading && data && (
        <div className="space-y-8">
          {/* ── Mis campos ─────────────────────────────────────────────── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">Mis campos</h3>

            {data.sharedByMe.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Todavía no tenés campos. Creá uno desde Campos y lotes para poder compartirlo.
              </p>
            ) : (
              <div className="space-y-3">
                {data.sharedByMe.map((f) => (
                  <div
                    key={f.fieldId}
                    className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{f.fieldName}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {f.members.length === 0
                            ? 'Solo vos'
                            : `${f.members.length} ${f.members.length === 1 ? 'persona' : 'personas'} con acceso`}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          setOpenFieldId(openFieldId === f.fieldId ? null : f.fieldId);
                          setResult(null);
                          setFormError(null);
                        }}
                        className="shrink-0 rounded-md bg-campo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-campo-700"
                      >
                        {openFieldId === f.fieldId ? 'Cancelar' : 'Invitar'}
                      </button>
                    </div>

                    {openFieldId === f.fieldId && (
                      <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-3">
                        <label className="block text-sm text-gray-700 dark:text-gray-200 mb-1">
                          Número de WhatsApp de la persona
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <input
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            placeholder="11 2345 6789"
                            inputMode="tel"
                            className="flex-1 min-w-[12rem] rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                          />
                          <button
                            onClick={() => void submitInvite(f.fieldId)}
                            disabled={saving}
                            className="rounded-md bg-campo-600 px-3 py-2 text-sm font-medium text-white hover:bg-campo-700 disabled:opacity-50"
                          >
                            {saving ? 'Creando…' : 'Crear invitación'}
                          </button>
                        </div>
                        {formError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{formError}</p>}
                        {result && <InviteResult invite={result} onClose={() => setResult(null)} />}
                      </div>
                    )}

                    {f.members.length > 0 && (
                      <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-700">
                        {f.members.map((m) => (
                          <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm text-gray-800 dark:text-gray-100">
                                {m.name || m.phoneLabel}
                              </p>
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                {m.name ? `${m.phoneLabel} · ` : ''}desde {formatDate(m.since)}
                              </p>
                            </div>
                            <button
                              onClick={() => void onRemove(f.fieldId, m.userId, m.name || m.phoneLabel)}
                              className="shrink-0 text-red-400 hover:text-red-600"
                              title="Quitar acceso"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    {f.invites.length > 0 && (
                      <div className="mt-3 border-t border-gray-100 dark:border-gray-700 pt-2">
                        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Invitaciones</p>
                        <ul className="space-y-1">
                          {f.invites.map((i) => (
                            <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                              <span className="flex items-center gap-2 min-w-0">
                                <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[i.status]}`}>
                                  {STATUS_LABEL[i.status]}
                                </span>
                                <span className="truncate text-gray-600 dark:text-gray-300">
                                  {i.phoneLabel ?? 'código abierto'}
                                </span>
                              </span>
                              {i.status === 'pending' && (
                                <button
                                  onClick={() => void onRevoke(i.id)}
                                  className="shrink-0 text-xs text-gray-500 hover:text-red-600 hover:underline"
                                >
                                  Cancelar
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Campos que me compartieron ─────────────────────────────── */}
          <section>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Campos que me compartieron
            </h3>
            {data.sharedWithMe.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Nadie te compartió un campo todavía. Cuando te manden una invitación por WhatsApp, el campo aparece acá.
              </p>
            ) : (
              <div className="space-y-2">
                {data.sharedWithMe.map((f) => (
                  <div
                    key={f.fieldId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-gray-900 dark:text-gray-100">{f.fieldName}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        de {f.ownerName || f.ownerPhoneLabel || 'otro usuario'} · desde {formatDate(f.since)}
                      </p>
                    </div>
                    <button
                      onClick={() => void onLeave(f.fieldId, f.fieldName)}
                      className="shrink-0 text-xs text-gray-500 hover:text-red-600 hover:underline"
                    >
                      Salir
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Actualizar
          </button>
        </div>
      )}

      {!loading && !data && !error && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          <Users2 className="inline w-4 h-4 mr-1" />
          No hay nada para mostrar.
        </p>
      )}
    </div>
  );
}
