import type { PendingActivity } from './pending-activities.js';
import type { AgronomyHandler } from '../domain/agronomy/agronomy.handler.js';
import type { UserId } from '../types/index.js';

/**
 * Human label for a pending registration, used in the "dejé pendiente …" notice.
 * Returns null for commands that aren't user-facing registrations (so we don't
 * emit a confusing notice for internal/partial pendings).
 */
function describePendingActivity(pending: PendingActivity): string | null {
  const d = (pending.data ?? {}) as Record<string, unknown>;
  const prod = typeof d.product === 'string' && d.product ? ` de ${d.product}` : '';
  const crop = typeof d.crop === 'string' && d.crop ? ` de ${d.crop}` : '';
  switch (pending.command) {
    case 'log_spraying': return `la fumigación${prod}`;
    case 'log_fertilization': return `la fertilización${prod}`;
    case 'log_tillage': return 'la labor';
    case 'log_irrigation': return 'el riego';
    case 'sow_crop': return `la siembra${crop}`;
    case 'harvest_crop': return `la cosecha${crop}`;
    case 'log_crop_scouting': return 'el monitoreo';
    case 'log_health_event': return 'el evento sanitario';
    case 'log_repro_event': return 'el evento reproductivo';
    case 'log_weighing': return 'el pesaje';
    case 'add_stock': return `la carga de stock${prod}`;
    case 'add_livestock': return 'el alta de hacienda';
    case 'log_rainfall': return 'la lluvia';
    default: return null;
  }
}

/**
 * Broad pivot-data-loss guard for pendingActStore: when the user abandons a
 * pending registration (typed a new action/query instead of the "¿en qué lote?"
 * answer), DON'T silently drop it. Save it at field-level where the activity type
 * allows it (spraying/fertilization/tillage/irrigation), otherwise emit an
 * explicit "dejé pendiente …" notice so the user knows it wasn't recorded.
 *
 * Returns the notice/confirmation messages to prepend before the pivot response
 * (empty array when there's nothing worth telling the user).
 */
export async function flushPendingActivityOnPivot(
  userId: UserId,
  pending: PendingActivity,
  agronomyHandler: AgronomyHandler,
): Promise<string[]> {
  // Guardar a nivel campo SOLO si lo único que falta es la ubicación. Si
  // faltan datos de negocio (producto, cantidad, cultivo...), guardar igual
  // crea un registro HUECO — visto en prod: "🧪 Fertilización registrada, 📍
  // sin lote" SIN PRODUCTO, porque el usuario preguntó qué lotes tenía en
  // medio del pending. En ese caso corresponde el aviso, no un save.
  const missing = pending.missing ?? [];
  const onlyLocationMissing = missing.every((s) => s === 'plot' || s === 'field');
  // 1. Try an actual field-level save (spray/fert/tillage/irrigation).
  if (onlyLocationMissing) {
    try {
      const saved = await agronomyHandler.savePendingActivityFieldLevel(userId, pending);
      if (saved && saved.messages && saved.messages.length > 0) {
        return ['💡 Lo guardé a nivel campo antes de seguir:', ...saved.messages];
      }
    } catch {
      /* fall through to the deferred notice */
    }
  }
  // 2. Otherwise, at least tell the user it wasn't recorded (no silent loss).
  //    Incluimos la cantidad/categoría cuando la tenemos, para que el usuario
  //    reconozca exactamente qué quedó sin registrar (visto live: pidió "40
  //    terneros", pivoteó, y no le quedó claro qué pasó con ellos).
  const label = describePendingActivity(pending);
  if (label) {
    const d = (pending.data ?? {}) as Record<string, unknown>;
    const qty = typeof d.count === 'number' ? d.count : (typeof d.quantity === 'number' ? d.quantity : null);
    const cat = typeof d.category === 'string' ? d.category : null;
    const detail = qty != null ? ` (${qty}${cat ? ' ' + cat : ''})` : '';
    const faltan = missing.length > 0 && !onlyLocationMissing
      ? ' Me faltaban datos (producto/cantidad) — contámelo completo cuando quieras.'
      : ' Decime el lote cuando quieras y lo registro.';
    return [`💡 Dejé pendiente *${label}*${detail}.${faltan}`];
  }
  return [];
}
