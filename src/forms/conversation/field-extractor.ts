// Extractor DETERMINÍSTICO de valores de formulario desde texto libre.
//
// El colector conversacional prueba cada mensaje contra TODOS los campos que
// faltan (no solo el que preguntó): "cargá $250.000 de combustible en el A1 de
// La Esperanza de hoy" llena monto + categoría + lote + fecha de una. Claude no
// participa: acá solo se proponen CANDIDATOS; el colector los valida con
// validateFieldValue (form-definitions.ts) y el submit re-valida todo.
//
// Reusa las fuentes únicas del proyecto: montos (normalizarMonto /
// extractAmount), categorías (detectarCategoria*), cultivos
// (extractCropFromText), fechas relativas (relative-dates), nombres de
// entidades (entity-matcher, invariante 3) y sinónimos (lexicon, invariante 4).
import { normalizarMonto, extractAmount, detectarCategoria, detectarCategoriaIngreso } from '../../utils/parser.js';
import { extractCropFromText } from '../../utils/crops.js';
import { resolveRelativeDate } from '../../utils/relative-dates.js';
import { mentionsEntityName, normalizeEntityName } from '../../utils/entity-matcher.js';
import { MONEY_HINT_RE, detectCurrencyTerm, detectActivityTypeTerm, stripAnswerPrefix } from '../../utils/lexicon.js';
import { extractSlots } from '../../middleware/slot-extractor.js';
import { corralOptionId, fieldOptionId, plotOptionId, type FormOptions } from '../form-options.js';
import { DOSE_UNIT_OPTIONS, type FormDefinition, type FormField, type FormOption } from '../form-definitions.js';

export interface ExtractContext {
  def: FormDefinition;
  options: FormOptions;
  /** Valores ya cargados en el draft. */
  values: Record<string, unknown>;
  /** Campo que se le está preguntando (o null). */
  awaiting: string | null;
  /** En el resumen: lo que se encuentre CORRIGE lo cargado. */
  overwrite: boolean;
  todayISO: string;
  /** Opciones mostradas en la última pregunta (para "2" = segunda opción). */
  choices?: { field: string; ids: string[] } | null;
  /**
   * El texto es además un comando de consulta ("mis campos"): solo valen
   * matches EXACTOS contra opciones (sin sinónimos ni texto libre), así la
   * consulta se responde en vez de tomarse como respuesta. "vacas" sigue
   * contestando "¿qué categoría?" porque matchea la opción Vaca.
   */
  strict?: boolean;
}

export interface ExtractResult {
  /** Candidatos por clave del form (incluye `<key>_other`). `null` = limpiar. */
  values: Record<string, unknown>;
  /** Más de una entidad coincide: se pregunta cuál, nunca se elige la primera. */
  ambiguous?: { field: string; candidates: FormOption[]; message: string };
  /** El campo preguntado no matcheó nada real del usuario (razón legible). */
  notFound?: { field: string; message: string };
  /** Renglones de cargas que no se pudieron leer (se informan, no se descartan en silencio). */
  warnings?: string[];
}

const isBlank = (v: unknown) => v === undefined || v === null || v === '';

export function isFieldEmpty(values: Record<string, unknown>, f: FormField): boolean {
  if (f.type === 'group') return !Array.isArray(values[f.key]) || (values[f.key] as unknown[]).length === 0;
  if (!isBlank(values[f.key])) return false;
  if (f.allowOther && !isBlank(values[`${f.key}_other`])) return false;
  return true;
}

/** Palabras normalizadas con bordes, para buscar frases completas. */
function padded(s: string): string {
  return ` ${normalizeEntityName(s).replace(/[^a-z0-9ñ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}
function containsPhrase(text: string, phrase: string): boolean {
  const p = padded(phrase).trim();
  return !!p && padded(text).includes(` ${p} `);
}

/** "25/09" o "25/09/2026" → ISO; sin año = año de hoy (o el anterior si quedaría futura). */
function parseExplicitDate(text: string, todayISO: string, noFuture: boolean): string | null {
  const m = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : Number(todayISO.slice(0, 4));
  const iso = (y: number) => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!m[3] && noFuture && iso(year) > todayISO) year -= 1;
  return iso(year);
}

function extractDate(text: string, f: FormField, todayISO: string): string | null {
  if (/\bhoy\b/i.test(text)) return todayISO;
  return resolveRelativeDate(text) ?? parseExplicitDate(text, todayISO, !!f.noFuture);
}

const BARE_NUMBER_RE = /^\s*(\d+(?:[.,]\d+)*)\s*$/;
function parseLooseNumber(s: string): number | null {
  const t = s.trim();
  // "28.500" / "1.250.000" = miles; "2,5" / "2.5" = decimal.
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const BARE_MONEY_RE = /^\s*(?:u\$s|us\$|u\$d|\$)?\s*\d[\d.,]*\s*(?:mil|k|lucas?|palos?|millon(?:es)?|m)?\s*(?:de\s+)?(?:pesos?|d[oó]lares?|usd|ars)?\s*$/i;
const DATE_TOKEN_RE = /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g;

/** Importe: pelado si es la pregunta abierta; con pista de dinero si no. */
function extractMoney(text: string, awaited: boolean): number | null {
  const noDates = text.replace(DATE_TOKEN_RE, ' ');
  if (awaited && BARE_MONEY_RE.test(noDates)) {
    const n = normalizarMonto(noDates) ?? parseLooseNumber(noDates.replace(/[^\d.,]/g, ''));
    return n && n > 0 ? n : null;
  }
  if (awaited) {
    // Escrito en letras ("doscientos mil") o con muletilla ("son 200 lucas").
    const n = normalizarMonto(noDates);
    if (n && n > 0) return n;
  }
  if (MONEY_HINT_RE.test(noDates) || /\b(monto|importe|precio|total)\b/i.test(noDates)) {
    const n = extractAmount(noDates) as number | null;
    return n && n > 0 ? n : null;
  }
  return null;
}

const MASS_TO_KG: Record<string, number> = { kg: 1, kilo: 1, kilos: 1, qq: 100, quintal: 100, quintales: 100, tn: 1000, t: 1000, tonelada: 1000, toneladas: 1000 };
function massFactor(unit: string): number | null {
  return MASS_TO_KG[normalizeEntityName(unit)] ?? null;
}

function extractYield(text: string): { perHa?: number; total?: number } | null {
  const perHa = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|kilos?|qq|quintales?|tn|t|toneladas?)\s*(?:\/|por|x)\s*(?:ha|has|hect\w*)\b/i);
  if (perHa) {
    const f = massFactor(perHa[2]);
    const n = parseLooseNumber(perHa[1]);
    if (f && n) return { perHa: Math.round(n * f) };
  }
  const total = text.match(/(\d+(?:[.,]\d+)*)\s*(kg|kilos?|qq|quintales?|tn|t|toneladas?)\b(?!\s*(?:\/|por|x)\s*(?:ha|has|hect))/i);
  if (total) {
    const f = massFactor(total[2]);
    const n = parseLooseNumber(total[1]);
    if (f && n) return { total: Math.round(n * f) };
  }
  return null;
}

const DOSE_UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(lts?\s*\/\s*ha|l\s*\/\s*ha|litros?\s+por\s+(?:ha|hect\w*)|kg\s*\/\s*ha|kilos?\s+por\s+(?:ha|hect\w*)|cc\s*\/\s*ha|cc|lts?|litros?|kg|kilos?|mm)\b/i;
function extractDose(text: string): { quantity: number; unit: string } | null {
  const m = text.match(DOSE_UNIT_RE);
  if (!m) return null;
  const quantity = parseLooseNumber(m[1]);
  if (!quantity) return null;
  const u = normalizeEntityName(m[2]).replace(/\s+/g, '');
  const unit = /\/ha|porha|porhect/.test(u)
    ? (u.startsWith('cc') ? 'cc/ha' : u.startsWith('kg') || u.startsWith('kilo') ? 'kg/ha' : 'lt/ha')
    : u === 'cc' ? 'cc' : u === 'mm' ? 'mm' : (u.startsWith('kg') || u.startsWith('kilo')) ? 'kg' : 'lt';
  return DOSE_UNIT_OPTIONS.some(o => o.id === unit) ? { quantity, unit } : null;
}

/** Lista de opciones del campo (fija o del usuario). */
export function optionsFor(f: FormField, options: FormOptions): FormOption[] {
  if (f.options) return f.options;
  if (f.optionsSource) return options.lists[f.optionsSource] ?? [];
  return [];
}

type LocationResult = { value?: string; ambiguous?: FormOption[]; notFound?: string };

/**
 * Lote / campo / corral nombrado en el texto, con CONSISTENCIA campo↔lote:
 * "el A1 de San Martín" cuando el A1 es de La Esperanza NO devuelve el A1 —
 * se explica y se vuelve a preguntar (nunca un lote de otro campo).
 */
function resolveLocation(text: string, f: FormField, options: FormOptions, awaited: boolean): LocationResult {
  const source = f.optionsSource;
  const answer = stripAnswerPrefix(text);
  const fieldsNamed = options.fields.filter(fl => mentionsEntityName(text, fl.name, 'campo'));
  let plots = options.plots.filter(p => mentionsEntityName(text, p.name, 'lote') || (awaited && mentionsEntityName(answer, p.name, 'lote')));
  const title = (p: { id: number; name: string; fieldName: string }) => `${p.name} (${p.fieldName})`;
  const plotId = (id: number) => (source === 'plots' ? String(id) : plotOptionId(id));

  if (fieldsNamed.length > 0 && plots.length > 0) {
    const inField = plots.filter(p => fieldsNamed.some(fl => fl.id === p.fieldId));
    if (inField.length === 0) {
      const fieldList = fieldsNamed.map(fl => fl.name).join(' / ');
      return { notFound: `🤔 No encontré el lote «${plots[0].name}» en ${fieldList} — ese lote es de ${plots[0].fieldName}.` };
    }
    plots = inField;
  }
  if (plots.length === 1) return { value: plotId(plots[0].id) };
  if (plots.length > 1) {
    return { ambiguous: plots.map(p => ({ id: plotId(p.id), title: title(p) })) };
  }

  if (source === 'livestock_locations') {
    const corrals = options.corrals.filter(c => mentionsEntityName(text, c.name, 'corral') || (awaited && mentionsEntityName(answer, c.name, 'corral')));
    if (corrals.length === 1) return { value: corralOptionId(corrals[0].id) };
    if (corrals.length > 1) return { ambiguous: corrals.map(c => ({ id: corralOptionId(c.id), title: `Corral ${c.name}` })) };
  }

  if (fieldsNamed.length === 1) {
    if (source === 'locations') return { value: fieldOptionId(fieldsNamed[0].id) };
    const inField = options.plots.filter(p => p.fieldId === fieldsNamed[0].id);
    if (inField.length === 1) return { value: plotId(inField[0].id) };
    if (inField.length > 1) return { ambiguous: inField.map(p => ({ id: plotId(p.id), title: title(p) })) };
    if (awaited) return { notFound: `🤔 El campo ${fieldsNamed[0].name} no tiene lotes disponibles para esto.` };
  }

  if (awaited && answer) {
    const what = source === 'livestock_locations' ? 'tus lotes ni corrales' : source === 'locations' ? 'tus lotes ni campos' : 'tus lotes';
    return { notFound: `🤔 No encontré «${answer.slice(0, 40)}» entre ${what}.` };
  }
  return {};
}

/** Categoría de hacienda: "40 terneros" → ternero (singular/plural). */
function matchWordOption(text: string, opts: FormOption[]): FormOption[] {
  const words = padded(text).trim().split(' ');
  return opts.filter(o => {
    const forms = [normalizeEntityName(o.title), normalizeEntityName(o.id)].map(s => s.replace(/[^a-z0-9ñ ]+/g, ''));
    return forms.some(form => form && (containsPhrase(text, form) || words.some(w => w === `${form}s` || w === `${form}es`)));
  });
}

/** Un renglón "Juan 28500 Cargill 14" → carga. */
function parseLoadLine(line: string): { driver_name?: string; weight_kg?: number; destinatario?: string; humidity_pct?: number } | null {
  const m = line.trim().match(/^(.*?)(\d[\d.,]*)\s*(kg|kilos?|tn|t|toneladas?)?\b(.*)$/i);
  if (!m) return null;
  const driver = m[1].replace(/[-:,;]+$/, '').trim();
  const n = parseLooseNumber(m[2]);
  if (!driver || !n) return null;
  const factor = m[3] ? (massFactor(m[3]) ?? 1) : 1;
  const out: { driver_name?: string; weight_kg?: number; destinatario?: string; humidity_pct?: number } = {
    driver_name: driver,
    weight_kg: Math.round(n * factor),
  };
  const rest = m[4].trim();
  const hum = rest.match(/(\d+(?:[.,]\d+)?)\s*%?\s*$/);
  const dest = (hum ? rest.slice(0, hum.index) : rest).replace(/^[-:,;]+|[-:,;]+$/g, '').trim();
  if (dest) out.destinatario = dest;
  if (hum) out.humidity_pct = parseLooseNumber(hum[1]) ?? undefined;
  return out;
}

export function extractFieldValues(text: string, ctx: ExtractContext): ExtractResult {
  const { def, options, values, awaiting, overwrite, todayISO, choices, strict } = ctx;
  const out: ExtractResult = { values: {} };
  const raw = text.trim();
  if (!raw) return out;
  const answer = stripAnswerPrefix(raw);
  const slots = extractSlots(raw, {
    type: def.action === 'log_income' ? 'income' : def.action === 'log_expense' ? 'expense' : 'activity',
  });

  for (const f of def.fields) {
    const awaited = f.key === awaiting;
    if (!awaited && !overwrite && !isFieldEmpty(values, f)) continue;

    // Respuesta por número a una lista mostrada ("2" = segunda opción).
    if (awaited && choices?.field === f.key && /^\d{1,2}$/.test(raw)) {
      const idx = Number(raw) - 1;
      if (idx >= 0 && idx < choices.ids.length) {
        // Un lote llamado literalmente "2" gana sobre la posición (abajo).
        const named = (f.optionsSource === 'plots' || f.optionsSource === 'locations' || f.optionsSource === 'livestock_locations')
          ? resolveLocation(raw, f, options, false).value : undefined;
        out.values[f.key] = named ?? choices.ids[idx];
        continue;
      }
    }

    switch (f.type) {
      case 'date': {
        const d = extractDate(raw, f, todayISO);
        if (d) out.values[f.key] = d;
        break;
      }
      case 'number': {
        // Un número pelado solo responde la pregunta abierta: con "¿en qué
        // lote?" abierto, "40" nunca se cuela como cantidad de otro campo.
        if (!awaited && BARE_NUMBER_RE.test(raw)) break;
        let n: number | null = null;
        if (f.key === 'amount' || f.key === 'unit_price') {
          n = extractMoney(raw, awaited);
          if (n == null && f.key === 'unit_price' && !awaited && typeof slots.unit_price === 'number') n = slots.unit_price;
        } else if (f.key === 'count') {
          n = typeof slots.count === 'number' ? slots.count : null;
        } else if (f.key === 'hectares') {
          n = typeof slots.hectares === 'number' ? slots.hectares : null;
          if (n == null && awaited && BARE_NUMBER_RE.test(raw)) n = parseLooseNumber(raw);
        } else if (f.key === 'quantity') {
          const dose = extractDose(raw);
          if (dose) {
            n = dose.quantity;
            if (def.fields.some(x => x.key === 'unit')) out.values.unit = dose.unit;
          } else if (awaited && BARE_NUMBER_RE.test(raw)) n = parseLooseNumber(raw);
        } else if (f.key === 'yield_kg_per_ha' || f.key === 'yield_kg') {
          const talksYield = awaiting === 'yield_kg_per_ha' || awaiting === 'yield_kg' || /\b(rind\w*|rinde|total|sacamos|cosechamos)\b/i.test(raw);
          const y = extractYield(raw);
          if (y && (talksYield || y.perHa !== undefined)) {
            // Excluyentes (crossCheck): cargar uno limpia el otro.
            if (y.perHa !== undefined) { out.values.yield_kg_per_ha = y.perHa; out.values.yield_kg = null; }
            else if (y.total !== undefined) { out.values.yield_kg = y.total; out.values.yield_kg_per_ha = null; }
          } else if (awaited && BARE_NUMBER_RE.test(raw)) {
            n = parseLooseNumber(raw);
          }
        } else if (f.key === 'humidity_pct') {
          const m = raw.match(/(\d+(?:[.,]\d+)?)\s*%/) ?? (/\bhumedad\b/i.test(raw) ? raw.match(/humedad\D{0,10}(\d+(?:[.,]\d+)?)/i) : null);
          if (m) n = parseLooseNumber(m[1]);
          else if (awaited && BARE_NUMBER_RE.test(raw)) n = parseLooseNumber(raw);
        } else if (awaited && BARE_NUMBER_RE.test(raw)) {
          n = parseLooseNumber(raw);
        }
        if (n != null && out.values[f.key] === undefined) out.values[f.key] = n;
        break;
      }
      case 'select': {
        const opts = optionsFor(f, options);
        if (f.optionsSource === 'plots' || f.optionsSource === 'locations' || f.optionsSource === 'livestock_locations') {
          const loc = resolveLocation(raw, f, options, awaited);
          if (loc.value) out.values[f.key] = loc.value;
          else if (loc.ambiguous && !out.ambiguous) {
            out.ambiguous = { field: f.key, candidates: loc.ambiguous, message: '🤔 Tengo más de uno con ese nombre. ¿Cuál es?' };
          } else if (loc.notFound && awaited) out.notFound = { field: f.key, message: loc.notFound };
          break;
        }
        if (f.key === 'currency') {
          const c = detectCurrencyTerm(raw);
          if (c) out.values[f.key] = c;
          break;
        }
        if (f.key === 'activity_type') {
          const t = detectActivityTypeTerm(raw);
          if (t) out.values[f.key] = t;
          break;
        }
        if (f.key === 'unit') {
          if (out.values.unit !== undefined) break;
          const dose = extractDose(`1 ${raw}`);
          if (awaited && dose) out.values.unit = dose.unit;
          else if (awaited) {
            const o = opts.find(x => normalizeEntityName(x.title) === normalizeEntityName(answer));
            if (o) out.values.unit = o.id;
          }
          break;
        }
        let matched: FormOption | null = null;
        if (f.optionsSource === 'crops') {
          const crop = extractCropFromText(raw) as string | null;
          if (crop) matched = opts.find(o => normalizeEntityName(o.id) === normalizeEntityName(crop)) ?? null;
          if (!matched && crop && f.allowOther) { out.values[`${f.key}_other`] = crop; break; }
        } else if (f.optionsSource === 'livestock_categories') {
          const hits = matchWordOption(raw, opts);
          if (hits.length === 1) matched = hits[0];
        } else {
          const hits = opts.filter(o => containsPhrase(raw, o.title) || containsPhrase(raw, o.id));
          if (hits.length >= 1) matched = hits.sort((a, b) => b.title.length - a.title.length)[0];
          if (!matched && !strict && (f.optionsSource === 'expense_categories' || f.optionsSource === 'income_categories')) {
            const detected = (f.optionsSource === 'income_categories' ? detectarCategoriaIngreso(raw) : detectarCategoria(raw)) as string | null;
            if (detected) {
              matched = opts.find(o => normalizeEntityName(o.id) === normalizeEntityName(detected)) ?? null;
              // Fuera de la lista: si contestaba ESTA pregunta vale lo que
              // escribió (abajo); si no, la categoría detectada.
              if (!matched && f.allowOther && !awaited) { out.values[`${f.key}_other`] = detected; break; }
            }
          }
        }
        if (matched) {
          out.values[f.key] = matched.id;
          if (f.allowOther) out.values[`${f.key}_other`] = null;
        } else if (awaited && !strict && f.allowOther && answer && answer.length <= 40 && !/\d{3,}/.test(answer)) {
          // "Otro": lo que escribió, tal cual (el handler lo matchea o lo crea).
          out.values[`${f.key}_other`] = answer;
          out.values[f.key] = null;
        } else if (awaited) {
          out.notFound = { field: f.key, message: `🤔 No encontré «${answer.slice(0, 40)}» en la lista.` };
        }
        break;
      }
      case 'text': {
        if (awaited && !strict) {
          out.values[f.key] = raw.slice(0, 200);
        } else if (f.key === 'product') {
          // Sin la dosis: "con glifosato 2 lt/ha" → "glifosato".
          const product = extractSlots(raw.replace(DOSE_UNIT_RE, ' ').replace(/\s+/g, ' ').trim()).product;
          if (typeof product === 'string' && product) out.values[f.key] = product;
        } else if (f.key === 'variety') {
          const m = raw.match(/\bvariedad\s+([\w.\- ]{2,30}?)(?:[,.]|$|\s+(?:en|el|la|del)\b)/i);
          if (m) out.values[f.key] = m[1].trim();
        }
        break;
      }
      case 'group': {
        if (!awaited) break;
        const items: Record<string, unknown>[] = [];
        const warnings: string[] = [];
        raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach((line, i) => {
          const load = parseLoadLine(line);
          if (load) items.push(load);
          else warnings.push(`Renglón ${i + 1} («${line.slice(0, 30)}»): no lo entendí — necesito *chofer peso*.`);
        });
        if (items.length > 0) out.values[f.key] = items;
        if (warnings.length > 0) out.warnings = warnings;
        break;
      }
    }
  }
  return out;
}
