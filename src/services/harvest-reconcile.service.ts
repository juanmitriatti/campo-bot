/**
 * Conciliación de cargas contra el romaneo del acopio (migración 120).
 *
 * El acopio manda un romaneo: una fila por camión con fecha, patente (o
 * chofer) y kilos recibidos. El productor lo pega en el dashboard y esto lo
 * cruza contra lo que dictó por WhatsApp. Tres salidas: camiones que cierran,
 * camiones que pesaron distinto (se guarda el peso del acopio en la carga para
 * que "Para revisar" lo muestre) y camiones que están de un solo lado.
 *
 * El matching es determinístico: misma patente (normalizada) o mismo chofer
 * (sin acentos, substring) y fecha a ± 1 día; ante varios candidatos gana el
 * de kilos más parecidos. Nunca crea ni borra cargas: solo enlaza y reporta.
 */
import { pool } from '../config/db.js';
import { normalizeEntityName } from '../utils/entity-matcher.js';

export interface RomaneoRow {
  date?: string | null;
  plate?: string | null;
  driver?: string | null;
  kg: number;
  ref?: string | null;
}

export interface ReconcileInput {
  rows?: RomaneoRow[];
  /** Texto pegado del romaneo; se parsea acá si no vienen rows. */
  text?: string;
  plotId?: number | null;
  destinatario?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Tolerancia de kilos para considerar que coincide (default 1 %). */
  tolerancePct?: number;
  /** Guardar acopio_weight_kg en las cargas que matchean (default true). */
  apply?: boolean;
}

interface LoadRow {
  id: number;
  driver_name: string;
  weight_kg: string | number;
  net_weight_kg: string | number | null;
  truck_plate: string | null;
  destinatario: string | null;
  acopio_weight_kg: string | number | null;
  event_date: string;
  plot_name: string | null;
}

export interface ReconcileResult {
  matched: Array<{ romaneo: RomaneoRow; loadId: number; driver: string; date: string; plot: string | null; ourKg: number; theirKg: number; diffKg: number; diffPct: number }>;
  differing: Array<{ romaneo: RomaneoRow; loadId: number; driver: string; date: string; plot: string | null; ourKg: number; theirKg: number; diffKg: number; diffPct: number }>;
  missingInBot: RomaneoRow[];
  missingInRomaneo: Array<{ loadId: number; driver: string; date: string; plot: string | null; kg: number; plate: string | null }>;
  totals: { romaneoKg: number; botKg: number; matchedKg: number };
  applied: number;
}

const normPlate = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normName = (s: string | null | undefined) => normalizeEntityName(String(s ?? ''));

function parseArNumber(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, '');
  if (!s) return null;
  let n: number;
  if (s.includes(',') && s.includes('.')) n = Number(s.replace(/\./g, '').replace(',', '.'));
  else if (s.includes(',')) n = s.split(',')[1]?.length === 3 ? Number(s.replace(',', '')) : Number(s.replace(',', '.'));
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) n = Number(s.replace(/\./g, ''));
  else n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw: string): string | null {
  const m = raw.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
  if (m) {
    const d = m[1].padStart(2, '0'); const mo = m[2].padStart(2, '0');
    let y = m[3] ? m[3] : String(new Date().getFullYear());
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[0] : null;
}

/**
 * Parsea el romaneo pegado. Una fila por línea: "12/04 AB123CD 30.580",
 * "12/04/2026;Pérez;30580", "Pérez 30580". Separadores: espacios, ; , tab |.
 */
export function parseRomaneoText(text: string): RomaneoRow[] {
  const rows: RomaneoRow[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(fecha|date|patente|chofer|kg|kilos)/i.test(line)) continue;
    const tokens = line.split(/[;|\t,]+|\s{1,}/).map(t => t.trim()).filter(Boolean);
    if (tokens.length < 2) continue;
    // kilos: el último token numérico ≥ 1000
    let kg: number | null = null; let kgIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const n = parseArNumber(tokens[i]);
      if (n != null && n >= 1000) { kg = n; kgIdx = i; break; }
    }
    if (kg == null) continue;
    let date: string | null = null; let plate: string | null = null; const names: string[] = [];
    tokens.forEach((t, i) => {
      if (i === kgIdx) return;
      if (!date && /\d{1,2}[\/-]\d{1,2}/.test(t)) { date = parseDate(t); return; }
      if (!plate && /^[A-Z]{2,3}\s?\d{3}\s?[A-Z]{0,2}$/i.test(t.replace(/-/g, ''))) { plate = normPlate(t); return; }
      if (/^[A-Za-zÁÉÍÓÚÑáéíóúñ.'-]+$/.test(t)) names.push(t);
    });
    rows.push({ date, plate, driver: names.length ? names.join(' ') : null, kg, ref: line });
  }
  return rows;
}

export async function reconcileHarvestLoads(userId: number, input: ReconcileInput): Promise<ReconcileResult | { error: string }> {
  const rows: RomaneoRow[] = Array.isArray(input.rows) && input.rows.length
    ? input.rows.map(r => ({ ...r, kg: Number(r.kg), plate: r.plate ? normPlate(r.plate) : null }))
    : (typeof input.text === 'string' ? parseRomaneoText(input.text) : []);
  const valid = rows.filter(r => Number.isFinite(r.kg) && r.kg > 0);
  if (valid.length === 0) return { error: 'No encontré filas con kilos en el romaneo. Formato: "12/04 AB123CD 30.580" o "Pérez 30580", una por línea.' };
  if (valid.length > 500) return { error: 'Máximo 500 filas por conciliación.' };
  const tol = Math.max(0, Math.min(10, Number(input.tolerancePct ?? 1))) / 100;

  const params: unknown[] = [userId];
  const conds = [`de.user_id = $1`, `de.event_type = 'harvest'`, `de.deleted_at IS NULL`];
  if (input.plotId) { params.push(input.plotId); conds.push(`de.plot_id = $${params.length}`); }
  if (input.destinatario) { params.push(`%${normName(input.destinatario)}%`); conds.push(`TRANSLATE(LOWER(hl.destinatario), 'áéíóúñ', 'aeioun') LIKE $${params.length}`); }
  const dates = valid.map(r => r.date).filter((d): d is string => !!d).sort();
  const from = input.dateFrom ?? (dates[0] ? dates[0] : null);
  const to = input.dateTo ?? (dates.length ? dates[dates.length - 1] : null);
  if (from) { params.push(from); conds.push(`de.event_date >= $${params.length}::date - interval '1 day'`); }
  if (to) { params.push(to); conds.push(`de.event_date <= $${params.length}::date + interval '1 day'`); }

  const { rows: loads } = await pool.query(
    `SELECT hl.id, hl.driver_name, hl.weight_kg, hl.net_weight_kg, hl.truck_plate, hl.destinatario, hl.acopio_weight_kg,
            de.event_date::text AS event_date, p.name AS plot_name
       FROM harvest_loads hl
       JOIN domain_events de ON de.id = hl.domain_event_id
       LEFT JOIN plots p ON p.id = de.plot_id
      WHERE ${conds.join(' AND ')}
      ORDER BY de.event_date, hl.id`,
    params,
  );
  const pending = new Map<number, LoadRow>((loads as LoadRow[]).map(l => [l.id, l]));

  const dayDiff = (a: string | null | undefined, b: string) => {
    if (!a) return 0;
    return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86_400_000);
  };

  const result: ReconcileResult = { matched: [], differing: [], missingInBot: [], missingInRomaneo: [], totals: { romaneoKg: 0, botKg: 0, matchedKg: 0 }, applied: 0 };
  result.totals.romaneoKg = valid.reduce((s, r) => s + r.kg, 0);
  result.totals.botKg = (loads as LoadRow[]).reduce((s, l) => s + Number(l.weight_kg), 0);

  for (const r of valid) {
    const candidates = [...pending.values()].filter(l => {
      if (dayDiff(r.date, l.event_date) > 1) return false;
      if (r.plate && l.truck_plate) return normPlate(l.truck_plate) === r.plate;
      if (r.driver) {
        const a = normName(r.driver); const b = normName(l.driver_name);
        return !!a && !!b && (a.includes(b) || b.includes(a));
      }
      // sin patente ni chofer: solo por fecha y kilos parecidos
      return !!r.date && Math.abs(Number(l.weight_kg) - r.kg) / r.kg <= 0.03;
    });
    if (candidates.length === 0) { result.missingInBot.push(r); continue; }
    candidates.sort((a, b) => Math.abs(Number(a.weight_kg) - r.kg) - Math.abs(Number(b.weight_kg) - r.kg));
    const l = candidates[0];
    pending.delete(l.id);
    const ourKg = Number(l.weight_kg);
    const diffKg = r.kg - ourKg;
    const diffPct = Math.round((diffKg / ourKg) * 1000) / 10;
    const entry = { romaneo: r, loadId: l.id, driver: l.driver_name, date: l.event_date, plot: l.plot_name, ourKg, theirKg: r.kg, diffKg, diffPct };
    if (Math.abs(diffKg) / ourKg <= tol) { result.matched.push(entry); result.totals.matchedKg += r.kg; }
    else result.differing.push(entry);
    if (input.apply !== false) {
      await pool.query(`UPDATE harvest_loads SET acopio_weight_kg = $2, updated_at = NOW() WHERE id = $1`, [l.id, r.kg]);
      result.applied++;
    }
  }
  for (const l of pending.values()) {
    result.missingInRomaneo.push({ loadId: l.id, driver: l.driver_name, date: l.event_date, plot: l.plot_name, kg: Number(l.weight_kg), plate: l.truck_plate });
  }
  console.log(`[HARVEST] conciliación user=${userId}: ${result.matched.length} ok, ${result.differing.length} difieren, ${result.missingInBot.length} faltan en el bot, ${result.missingInRomaneo.length} faltan en romaneo`);
  return result;
}
