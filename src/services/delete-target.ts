// QUÉ va a borrar un comando destructivo: la misma búsqueda que usa el handler,
// para mostrarlo en la confirmación y verificar al confirmar que sigue siendo
// ESE registro. Antes cada borrado armaba la vista previa por su lado (o no la
// armaba) y "borrá el gasto de 50 mil" confirmaba a ciegas.
import { pool } from '../config/db.js';
import {
  findExpenseByCriteria, findExpenseByFilter, findIncomeByCriteria, getLastExpense, getLastIncome,
  getLastObservation, getLastScouting, getLastRainfall,
} from './expenses.js';
import { FinancialRepository } from '../domain/financial/financial.repository.js';
import { LivestockRepository } from '../domain/livestock/livestock.repository.js';
import { findHarvestLoadsToDelete } from './expenses.js';
import { PlotDiscoveryService } from '../domain/plots/plot-discovery.service.js';
import { formatDateAR } from '../utils/date.js';
import type { ParsedCommand, UserId } from '../types/index.js';

export type DeleteTarget =
  /** Hay un registro concreto: se muestra y su `key` se vuelve a comparar al confirmar. */
  /** `what`: cómo nombrar lo que se borra en la pregunta ("esta siembra"). Sin él, el rótulo genérico del comando. */
  | { status: 'found'; key: string; line: string; what?: string }
  /** La búsqueda no encontró nada: no se pide confirmación. */
  | { status: 'none'; message: string }
  /** Comando sin vista previa (o sin criterios): confirmación genérica. */
  | { status: 'unknown' };

const money = (amount: unknown, currency: unknown) => {
  const n = Number(amount).toLocaleString('es-AR');
  return currency === 'USD' ? `US$ ${n}` : `$${n}`;
};
const day = (d: unknown) => (d ? ` — ${formatDateAR(d as string | Date)}` : '');

function moneyLine(kind: 'Gasto' | 'Ingreso', row: Record<string, unknown>): DeleteTarget {
  const detail = row.description && row.description !== row.category ? ` (${String(row.description).slice(0, 60)})` : '';
  const date = day(row.expense_date ?? row.income_date ?? row.created_at);
  return {
    status: 'found',
    key: `${kind}:${row.id}`,
    line: `🗑️ ${kind}: ${row.category || 'sin categoría'} ${money(row.amount, row.currency)}${date}${detail}`,
  };
}

const NOT_A_REFERENT = /^(hoy|ayer|anteayer|antes|la|el|los|las|recien|recién|eso|este|esta|esa|ese|mas|más|semana|mes|año|quincena|campaña|pasad[oa]|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)$/i;

/** "borrá la última venta de soja" → soja (el agente no siempre manda el filtro). */
export function incomeReferent(text: string | null | undefined): string | null {
  const m = /\b(?:venta|ingreso|cobro)\s+de\s+(?:la\s+|el\s+|los\s+|las\s+)?([\p{L}]{3,})/iu.exec(text ?? '');
  return m && !NOT_A_REFERENT.test(m[1]) ? m[1] : null;
}

/** Filtros del comando de borrar camiones: la vista previa y el borrado usan los mismos. */
export function harvestDeleteOptions(cmd: ParsedCommand) {
  const c = cmd as Record<string, unknown>;
  return {
    ...(c.eventDate ? { eventDate: c.eventDate as string } : {}),
    ...(Array.isArray(c.driverNames) ? { driverNames: c.driverNames as string[] } : {}),
    ...(c.onlyWithoutDestination ? { onlyWithoutDestination: true } : {}),
  };
}

export async function resolveDeleteTarget(cmd: ParsedCommand, userId: UserId): Promise<DeleteTarget> {
  const repo = new FinancialRepository();
  const c = cmd as Record<string, unknown>;
  const none = (message: string): DeleteTarget => ({ status: 'none', message });

  switch (cmd.command) {
    case 'delete_last':
    case 'delete_last_expense': {
      const filter = (c.categoryFilter as string | null) || null;
      const row = filter ? await repo.findLastExpenseByCategory(userId, filter) : await getLastExpense(userId);
      if (!row) return none(filter ? `No encontré un gasto de *${filter}* para borrar.` : 'No hay gastos para borrar.');
      return moneyLine('Gasto', row as unknown as Record<string, unknown>);
    }
    case 'delete_specific': {
      const row = c.filter ? await findExpenseByFilter(userId, String(c.filter)) : null;
      return row ? moneyLine('Gasto', row) : none(`No encontré un gasto con «${String(c.filter ?? '')}».`);
    }
    case 'delete_specific_expense':
    case 'delete_specific_income': {
      const isExpense = cmd.command === 'delete_specific_expense';
      const criteria = { amount: c.filterAmount as number | null, category: c.filterCategory as string | null, date: c.filterDate as string | null };
      // Sin criterios el handler pregunta cuál: no hay nada que confirmar.
      if (criteria.amount == null && !criteria.category && !criteria.date) return { status: 'unknown' };
      const row = await (isExpense ? findExpenseByCriteria(userId, criteria) : findIncomeByCriteria(userId, criteria));
      return row
        ? moneyLine(isExpense ? 'Gasto' : 'Ingreso', row)
        : none(`No encontré un ${isExpense ? 'gasto' : 'ingreso'} que coincida. No borré nada.`);
    }
    case 'delete_last_income': {
      // "la última venta de soja" borraba el último ingreso de cualquier cosa.
      const filter = (c.categoryFilter as string | null) || incomeReferent(c.originalText as string);
      if (filter) c.categoryFilter = filter;
      const row = filter ? await repo.findLastIncomeByCategory(userId, filter) : await getLastIncome(userId);
      if (!row) return none(filter ? `No encontré un ingreso de *${filter}* para borrar.` : 'No hay ingresos para borrar.');
      return moneyLine('Ingreso', row as unknown as Record<string, unknown>);
    }
    case 'delete_last_activity': {
      const { findActivityDeleteTarget } = await import('../domain/agronomy/agronomy.handler.js');
      const ev = await findActivityDeleteTarget(userId, cmd);
      if (!ev) return none('No hay actividades para borrar con esos datos.');
      return {
        status: 'found', key: `event:${ev.id}`,
        line: await activityLine(ev as unknown as Record<string, unknown>),
        what: ACTIVITY_NOUN[String(ev.event_type)]?.what,
      };
    }
    case 'delete_last_observation': {
      const row = await getLastObservation(userId);
      if (!row) return none('No hay observaciones para borrar.');
      const text = String(row.observation_text ?? '');
      return { status: 'found', key: `obs:${row.id}`, line: `🗑️ Observación: «${text.slice(0, 80)}${text.length > 80 ? '…' : ''}»${day(row.observation_date ?? row.created_at)}` };
    }
    case 'delete_last_scouting': {
      const row = await getLastScouting(userId);
      if (!row) return none('No hay monitoreos para borrar.');
      return { status: 'found', key: `scout:${row.id}`, line: `🗑️ Monitoreo${row.stage_code ? ` ${row.stage_code}` : ''}${day(row.scouting_date ?? row.created_at)}` };
    }
    case 'delete_last_rainfall': {
      const row = await getLastRainfall(userId);
      if (!row) return none('No hay registros de lluvia para borrar.');
      // Se borra la última CARGA, no el total del día (ver deleteLastRainfall).
      const total = Number(row.millimeters);
      const added = row.last_added_mm == null ? null : Number(row.last_added_mm);
      const portion = added != null && added > 0 && added < total ? added : total;
      return { status: 'found', key: `rain:${row.id}:${portion}`, line: `🗑️ Lluvia: ${portion}mm${day(row.rainfall_date ?? row.created_at)}` };
    }
    case 'revert_livestock_movement': {
      const livestock = new LivestockRepository();
      // Sin id explícito, el último reversible; se fija en el comando para
      // revertir ESE y no el que sea el último al confirmar.
      const m = c.movementId
        ? await livestock.findMovementById(Number(userId), String(c.movementId))
        : await livestock.findLatestRevertibleMovement(Number(userId));
      if (!m) return none('No encontré ningún movimiento reciente para revertir.');
      c.movementId = m.id;
      const { rows } = await pool.query(
        `SELECT m.movement_date, g.category::text AS category FROM livestock_movements m
           LEFT JOIN livestock_groups g ON g.id = COALESCE(m.dest_group_id, m.source_group_id)
          WHERE m.id = $1`, [m.id]);
      const labels: Record<string, string> = {
        entrada: 'Ingreso', salida: 'Salida', transferencia: 'Traslado', muerte: 'Muerte',
        nacimiento: 'Nacimiento', recategorizacion: 'Cambio de categoría', ajuste: 'Ajuste',
      };
      const what = rows[0]?.category ? ` ${String(rows[0].category).toLowerCase()}` : '';
      return {
        status: 'found',
        key: `movement:${m.id}`,
        line: `↩️ ${labels[m.movement_type] ?? m.movement_type} de ${m.count}${what}${day(rows[0]?.movement_date)}`,
      };
    }
    case 'delete_harvest_loads': {
      if (!cmd.plotName) return { status: 'unknown' }; // el handler pregunta el lote
      const r = await new PlotDiscoveryService().resolveFromNames(userId, c.fieldName as string | null, c.plotName as string);
      if (!r.plotId) return none(`No encontré el lote *${String(c.plotName)}*.`);
      const loads = await findHarvestLoadsToDelete(Number(userId), r.plotId, harvestDeleteOptions(cmd));
      if (loads.length === 0) return none('No se encontraron cargas que coincidan. No borré nada.');
      c._loadIds = loads.map(l => l.id);
      const kg = (n: unknown) => Number(n).toLocaleString('es-AR');
      const lines = loads.slice(0, 8).map(l => `• ${l.driver_name} — ${kg(l.weight_kg)} kg${day(l.event_date)}`);
      if (loads.length > 8) lines.push(`• …y ${loads.length - 8} más`);
      const total = loads.reduce((sum, l) => sum + Number(l.weight_kg), 0);
      return {
        status: 'found',
        key: `loads:${c._loadIds}`,
        line: `🚛 ${loads.length} camión${loads.length > 1 ? 'es' : ''} de ${r.plotName}${loads[0].event_crop ? ` (${loads[0].event_crop})` : ''}, ${kg(total)} kg:\n${lines.join('\n')}`,
      };
    }
    default:
      return { status: 'unknown' };
  }
}

/** Nombre de cada tipo de actividad: el de la ficha y el de la pregunta. Fuente única. */
const ACTIVITY_NOUN: Record<string, { label: string; what: string }> = {
  planting: { label: 'Siembra', what: 'esta siembra' },
  spraying: { label: 'Fumigación', what: 'esta fumigación' },
  fertilization: { label: 'Fertilización', what: 'esta fertilización' },
  harvest: { label: 'Cosecha', what: 'esta cosecha' },
  tillage: { label: 'Labranza', what: 'esta labranza' },
  irrigation: { label: 'Riego', what: 'este riego' },
  health_event: { label: 'Evento sanitario', what: 'este evento sanitario' },
  repro_event: { label: 'Evento reproductivo', what: 'este evento reproductivo' },
  weighing: { label: 'Pesaje', what: 'este pesaje' },
  tacto: { label: 'Tacto', what: 'este tacto' },
};

async function activityLine(ev: Record<string, unknown>): Promise<string> {
  let line = `🗑️ ${ACTIVITY_NOUN[String(ev.event_type)]?.label ?? ev.event_type}${ev.crop ? ` de ${ev.crop}` : ''}${ev.plot_name ? ` en ${ev.plot_name}` : ''}${day(ev.event_date ?? ev.created_at)}`;
  if (ev.event_type === 'planting' && ev.plot_crop_id) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM domain_events
        WHERE plot_crop_id = $1 AND event_type = 'planting' AND deleted_at IS NULL AND id <> $2`,
      [ev.plot_crop_id, ev.id]);
    if (rows[0]?.n > 0) {
      const tandaHa = ev.unit === 'ha' && ev.quantity != null ? Number(ev.quantity) : null;
      const ha = tandaHa != null ? ` (${tandaHa.toLocaleString('es-AR')} ha)` : '';
      // Con cuánto queda la campaña: el resultado se ve ANTES de confirmar.
      const { rows: camp } = await pool.query(`SELECT sowed_hectares::float AS ha FROM plot_crops WHERE id = $1`, [ev.plot_crop_id]);
      const left = tandaHa != null && camp[0]?.ha != null ? Math.max(0, Number(camp[0].ha) - tandaHa) : null;
      line += `\n_Se borra solo esa tanda${ha}. ${left != null ? `La campaña queda con *${left.toLocaleString('es-AR')} ha* sembradas` : 'La campaña sigue con las otras'} y sigue activa._`;
    }
  }
  if (ev.event_type !== 'harvest') return line;
  // Una cosecha arrastra sus camiones y su parte del rinde: decirlo antes de borrar.
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM harvest_loads WHERE domain_event_id = $1) AS loads,
            (SELECT COALESCE(SUM(COALESCE(net_weight_kg, weight_kg)), 0) FROM harvest_loads WHERE domain_event_id = $1) AS kg,
            (SELECT COUNT(*)::int FROM domain_events WHERE plot_crop_id = $2 AND event_type = 'harvest'
                AND deleted_at IS NULL AND id <> $1) AS other_days`,
    [ev.id, ev.plot_crop_id ?? null]);
  const r = rows[0];
  const tn = (kg: unknown) => (Number(kg) / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 });
  if (r?.loads > 0) line += `\n🚛 Borra también ${r.loads} camión${r.loads > 1 ? 'es' : ''} (${tn(r.kg)} tn)`;
  if (ev.harvest_yield_kg) line += `\n🌾 Rinde cargado ese día: ${tn(ev.harvest_yield_kg)} tn`;
  line += r?.other_days > 0
    ? `\n_La campaña sigue cosechada con los otros ${r.other_days} día(s)._`
    : '\n_Era el único día de cosecha: la campaña vuelve a "sin cosechar"._';
  return line;
}
