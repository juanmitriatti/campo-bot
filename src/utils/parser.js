// ============================================================================
// Parser v2.0 — Modular, normalizado, con fuzzy matching y numeros escritos
// ============================================================================

import {
  EXPENSE_KEYWORD_MAP,
  INCOME_KEYWORD_MAP,
  CROPS,
  AGRO_PRODUCTS,
  PRODUCT_TYPE_KEYWORDS,
  IMPLEMENTS,
  UNIT_ALIASES,
  ACTIVITY_FILTER_PATTERNS,
} from '../constants/agro-terms.js';

// --- Normalización central ---
function normalizeText(text) {
  return text.toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    // Strip emojis
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}]/gu, "")
    .replace(/\./g, "")
    .replace(/[¡!¿]/g, "")
    // Collapse excessive whitespace
    .replace(/\s{2,}/g, " ")
    .trim();
}

// --- Common typo corrections (WhatsApp / audio transcription) ---
const COMMON_TYPOS = new Map([
  // Accent errors
  ["page", "pague"],
  ["gaste", "gaste"],
  ["compre", "compre"],
  ["vendi", "vendi"],
  ["cobre", "cobre"],
  // Missing/transposed letters
  ["gsoil", "gasoil"],
  ["gasoi", "gasoil"],
  ["nabta", "nafta"],
  ["nfata", "nafta"],
  ["ferzilizante", "fertilizante"],
  ["fertlizante", "fertilizante"],
  ["fertilzante", "fertilizante"],
  ["agroqumico", "agroquimico"],
  ["agroqumicos", "agroquimicos"],
  ["agroquimioc", "agroquimico"],
  ["herbicda", "herbicida"],
  ["insecticda", "insecticida"],
  ["fungicda", "fungicida"],
  ["semila", "semilla"],
  ["semillas", "semillas"],
  ["combutible", "combustible"],
  ["combusible", "combustible"],
  ["combustilbe", "combustible"],
  ["glifostao", "glifosato"],
  ["glifosaot", "glifosato"],
  ["ure", "urea"],
  ["tracto", "tractor"],
  ["cosecahdora", "cosechadora"],
  ["arendamiento", "arrendamiento"],
  ["arrendameinto", "arrendamiento"],
  ["presupeusto", "presupuesto"],
  ["preuspuesto", "presupuesto"],
  // STT misspellings for "lote"
  ["lot", "lote"],
  ["lotee", "lote"],
  ["loteh", "lote"],
  ["plot", "lote"],
]);

export function fixCommonTypos(text) {
  const words = text.split(/\s+/);
  return words.map(word => COMMON_TYPOS.get(word) || word).join(" ");
}

// --- Number format expansion ---
export function expandNumbers(text) {
  // 200k → 200mil (when not already matched by normalizarMonto)
  let result = text.replace(/(\d+)kk\b/gi, (_, n) => `${n} millones`);
  result = result.replace(/(\d+)k\b/gi, (_, n) => `${n}mil`);
  return result;
}

// --- Números escritos en español ---
const WRITTEN_NUMBERS = {
  "cero": 0, "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4,
  "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10,
  "once": 11, "doce": 12, "trece": 13, "catorce": 14, "quince": 15,
  "veinte": 20, "treinta": 30, "cuarenta": 40, "cincuenta": 50,
  "sesenta": 60, "setenta": 70, "ochenta": 80, "noventa": 90,
  "cien": 100, "ciento": 100, "doscientos": 200, "trescientos": 300,
  "cuatrocientos": 400, "quinientos": 500, "seiscientos": 600,
  "setecientos": 700, "ochocientos": 800, "novecientos": 900,
  "medio": 0.5,
};

const MULTIPLIERS = {
  "mil": 1_000,
  "millon": 1_000_000,
  "millones": 1_000_000,
  "palos": 1_000_000,
  "palo": 1_000_000,
};

function parseWrittenNumber(text) {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/);

  let total = 0;
  let current = 0;
  let found = false;

  for (const word of words) {
    if (WRITTEN_NUMBERS[word] !== undefined) {
      current += WRITTEN_NUMBERS[word];
      found = true;
    } else if (MULTIPLIERS[word]) {
      if (current === 0) current = 1;
      current *= MULTIPLIERS[word];
      total += current;
      current = 0;
      found = true;
    }
  }

  total += current;
  return found && total > 0 ? total : null;
}

// --- Monto ---
export function normalizarMonto(texto) {
  const lower = texto.toLowerCase().replace(/\./g, "");

  // Si hay un monto con dígitos (50mil, $100, 200k, 1.5 millones), priorizar esos regex
  const hasDigitAmount = /\$\s?\d|\d+\s?(?:mil|k|lucas|millon|palos)|\d{4,}/.test(lower);

  if (!hasDigitAmount) {
    const written = parseWrittenNumber(texto);
    if (written !== null) return written;
  }

  const matchPesos = lower.match(/\$\s?(\d+)/);
  if (matchPesos) return parseInt(matchPesos[1]);

  // "millones" / "palos" ANTES de "mil"
  const matchMillones = lower.match(/(\d+(?:[.,]\d+)?)\s?(?:millones|millon|palos)/);
  if (matchMillones) return Math.round(parseFloat(matchMillones[1].replace(",", ".")) * 1_000_000);

  const matchMil = lower.match(/(\d+)\s?mil/);
  if (matchMil) return parseInt(matchMil[1]) * 1000;

  const matchK = lower.match(/(\d+)k/);
  if (matchK) return parseInt(matchK[1]) * 1000;

  const matchM = lower.match(/(\d+(?:[.,]\d+)?)m\b/);
  if (matchM) return Math.round(parseFloat(matchM[1].replace(",", ".")) * 1_000_000);

  const matchLucas = lower.match(/(\d+)\s?lucas/);
  if (matchLucas) return parseInt(matchLucas[1]) * 1000;

  // Standalone number (for flows and direct amount input like "500" or "200 dolares")
  const stripped = lower.replace(/\s*(?:d[oó]lares?|pesos?|usd|ars)\s*/g, '').trim();
  if (/^\d+$/.test(stripped)) return parseInt(stripped);

  return null;
}

// --- Number-first amount extraction (verb-independent) ---

const AMOUNT_LOCATION_PREFIX = /(?:lote|campo|parcela|semana|dia|mes)\s*$/;

/**
 * Extract amount using number-first strategy.
 * Tries structured formats ($, mil, k, etc) first, then plain 2+ digit numbers.
 * Skips numbers preceded by location words (lote, campo, etc).
 */
export function extractAmount(texto) {
  // 1. Try structured formats first (covers $, mil, k, lucas, millones, written numbers)
  const structured = normalizarMonto(texto);
  if (structured !== null) return structured;

  // 2. Plain number extraction (2+ digits, skip location-prefixed numbers)
  const lower = texto.toLowerCase().replace(/\./g, "");
  const matches = [...lower.matchAll(/\b(\d{2,})\b/g)];
  for (const m of matches) {
    const before = lower.slice(0, m.index).trimEnd();
    if (AMOUNT_LOCATION_PREFIX.test(before)) continue;
    return parseInt(m[1]);
  }

  return null;
}

// --- Financial intent detection (verb-independent) ---

const FINANCIAL_KEYWORDS = /(?:gast[oéea]|ingres[oéea]|pagu[eé]|cobr[eé]|compr[eé]|vend[ií]|cargu[eé]|registr[eéa]|anot[eéa]|pago|venta|compra|cost[oó]|factur)/i;

/**
 * Detect financial intent via keywords. Verb-independent — matches nouns and all conjugations.
 */
// Internal — used by parseMensaje. No longer part of public API.
function hasFinancialIntent(texto) {
  return FINANCIAL_KEYWORDS.test(texto);
}
// Keep export for backward compat (tests)
export { hasFinancialIntent };

// --- Complejidad ---
function esComplejo(texto) {
  const lower = texto.toLowerCase();
  if (/\d+\s*(bolsas?|unidades?|litros?|kilos?|kg|lts?|tn|toneladas?)\s/.test(lower)) return true;
  if (/a\s+\d+/.test(lower) && /\d+\s/.test(lower)) return true;
  if (lower.includes("cada")) return true;
  return false;
}

/**
 * Detect questions that should NOT be parsed as expenses/incomes.
 * Catches "qué es una maleza?", "cuánto llovió?", etc.
 * Note: uses (?=\s|$) instead of \b because JS \b fails with accented chars (é, á, etc.)
 */
// Canonical implementation in guards.ts — import for internal use + re-export
import { isLikelyQuestion as _isLikelyQuestion } from './guards.js';
export const isLikelyQuestion = _isLikelyQuestion;

// --- Levenshtein (ligero, sin dependencias) ---
function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

// --- Diccionarios de categorías — imported from constants/agro-terms.ts ---

// --- Productos agronómicos — imported from constants/agro-terms.ts ---

export function detectarProducto(texto) {
  const normalized = normalizeText(texto);

  // Multi-word exact match first (e.g. "sulfato de amonio")
  for (const key of Object.keys(AGRO_PRODUCTS)) {
    if (key.includes(" ") && normalized.includes(key)) return AGRO_PRODUCTS[key];
  }

  // Single-word exact match
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (AGRO_PRODUCTS[word]) return AGRO_PRODUCTS[word];
  }

  // Fuzzy startsWith
  for (const word of words) {
    if (word.length < 4) continue;
    for (const key of Object.keys(AGRO_PRODUCTS)) {
      if (key.includes(" ")) continue;
      if (word.startsWith(key) || key.startsWith(word)) return AGRO_PRODUCTS[key];
    }
  }

  return null;
}

// --- Quantity & Unit parsing (UNIT_ALIASES imported from constants/agro-terms.ts) ---

export function parseQuantityUnit(texto) {
  const normalized = normalizeText(texto).replace(/,/g, ".");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(kg|kgs|kilos|kilogramos|lt|lts|litro|litros|cc|bolsa|bolsas|tn|tonelada|toneladas)\b/);
  if (match) {
    const quantity = parseFloat(match[1]);
    const unit = UNIT_ALIASES[match[2]] || match[2];
    return { quantity, unit };
  }
  return null;
}

// --- Relative date parsing ---
export function parseFechaRelativa(texto) {
  const normalized = normalizeText(texto);
  const today = new Date();

  if (/\bhoy\b/.test(normalized)) return today;
  if (/\bayer\b/.test(normalized)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (/\banteayer\b/.test(normalized) || /\bante\s?ayer\b/.test(normalized)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 2);
    return d;
  }

  // Delegate to existing parseSpanishDate for specific dates
  const dateResult = parseSpanishDate(texto);
  if (dateResult) return dateResult;

  return null;
}

// --- Implementos (IMPLEMENTS imported from constants/agro-terms.ts) ---

export function detectarImplemento(texto) {
  const normalized = normalizeText(texto);
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (IMPLEMENTS[word]) return IMPLEMENTS[word];
  }
  return null;
}

// --- Cultivos (CROPS imported from constants/agro-terms.ts) ---

export function detectarCultivo(texto) {
  const normalized = normalizeText(texto);
  const words = normalized.split(/\s+/);

  // Exact match first
  for (const word of words) {
    if (CROPS[word]) return CROPS[word];
  }

  // Fuzzy startsWith
  for (const word of words) {
    if (word.length < 3) continue;
    for (const key of Object.keys(CROPS)) {
      if (word.startsWith(key) || key.startsWith(word)) return CULTIVOS[key];
    }
  }

  return null;
}

/**
 * Detailed fuzzy lookup — returns match type alongside value.
 * Used internally for confidence scoring.
 */
function fuzzyLookupDetailed(normalized, dict) {
  // 1. Exact includes
  for (const key of Object.keys(dict)) {
    if (normalized.includes(key)) return { value: dict[key], matchType: 'exact' };
  }

  // 2. Fuzzy: startsWith bidireccional + Levenshtein <= 2
  const words = normalized.split(/\s+/);
  for (const word of words) {
    if (word.length < 3) continue;
    for (const key of Object.keys(dict)) {
      // startsWith bidireccional (truncaciones)
      if (word.startsWith(key) || key.startsWith(word)) return { value: dict[key], matchType: 'starts' };
      // Levenshtein para palabras de largo similar
      if (Math.abs(word.length - key.length) <= 2 && levenshtein(word, key) <= 2) {
        return { value: dict[key], matchType: 'fuzzy' };
      }
    }
  }

  return null;
}

// Backward-compatible wrapper
function fuzzyLookup(normalized, dict) {
  const result = fuzzyLookupDetailed(normalized, dict);
  return result ? result.value : null;
}

export function detectarCategoria(texto) {
  const normalized = normalizeText(texto);
  return fuzzyLookup(normalized, EXPENSE_KEYWORD_MAP);
}

export function detectarCategoriaIngreso(texto) {
  const normalized = normalizeText(texto);
  return fuzzyLookup(normalized, INCOME_KEYWORD_MAP);
}

/**
 * Parse a budget-SET intent: "presupuesto / límite / tope / techo (de gasto) de
 * $X para Y" in any word order. Returns { command:'set_budget', category, amount }
 * or null.
 *
 * Why this exists (root cause of two P0s):
 *  - The agent has NO set_budget tool, so it silently stole "poné límite de $1M
 *    en fertilizante" into a *recurring expense template* (phantom $1M/month).
 *  - The old regex `/presupuesto\s+(\w+)\s+(.+)/` took the word right after
 *    "presupuesto" as the category → "presupuesto DE 500 mil para gasoil" saved
 *    category literally as "De" (and the UPSERT overwrote prior budgets).
 *
 * This resolves the category through detectarCategoria() (the same fuzzy map the
 * rest of the app uses) from an explicit "para/en X" clause, a "de X" clause, or
 * the leftover words — never the raw connector. Only fires on a real SET (needs
 * a money amount); budget *queries* (no amount) return null and fall through.
 */
export function parseBudget(texto) {
  const norm = normalizeText(texto);
  if (!/\b(presupuesto|presup|limite|tope|techo)\b/.test(norm)) return null;
  // Not a budget-alert toggle ("activar/desactivar alertas de presupuesto").
  if (/\b(activ\w*|desactiv\w*|habilit\w*|deshabilit\w*|alerta)\b/.test(norm)) return null;
  // A clear expense/income verb means the word "presupuesto" is incidental, not a
  // set-budget command ("gasté 500 mil, casi me paso del presupuesto").
  if (/\b(gaste|pague|pago|compre|compro|vendi|vendo|cobre|cobro|abone|ingrese|ingreso|factur\w*)\b/.test(norm)) return null;

  // normalizarMonto chokes when the number is embedded in extra words
  // ("300000 en semillas" → null), so pull each money-like token and take the
  // largest normalized value. No token → it's a query, not a set.
  const moneyTokens = texto.match(/\$?\s*\d[\d.,]*\s*(?:mil(?:lones?)?|millon\w*|palos?|lucas?|k|m)?/gi) || [];
  let amount = 0;
  for (const tok of moneyTokens) {
    const v = normalizarMonto(tok);
    if (v && v > amount) amount = v;
  }
  if (!amount || amount <= 0) return null;

  // Category candidates, most specific first.
  const candidates = [];
  const paraM = norm.match(/\b(?:para|en)\s+(?:el\s+|la\s+|los\s+|las\s+)?([a-zñ][a-zñ ]*?)(?=\s+(?:de|por|al|mensual|cada|presupuesto)\b|\s*$)/);
  if (paraM) candidates.push(paraM[1].trim());
  const deM = norm.match(/\bde\s+(?:el\s+|la\s+)?([a-zñ][a-zñ ]*?)(?=\s+(?:de|por|al|mensual|cada|para)\b|\s*$)/);
  if (deM) candidates.push(deM[1].trim());
  const leftover = norm
    .replace(/\b(presupuesto|presup|limite|tope|techo|mensual|por mes|de gasto|gasto|el|la|los|las|un|una|de|del|para|en|por|al|cada|poner|pone|quiero|configurar|fijar|establecer|me|mi|monto)\b/g, ' ')
    .replace(/\d+(?:[.,]\d+)?/g, ' ')
    .replace(/[^a-zñ ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (leftover) candidates.push(leftover);

  for (const c of candidates) {
    if (!c) continue;
    const cat = detectarCategoria(c);
    if (cat) return { command: 'set_budget', category: cat, amount };
  }
  // No fuzzy hit — keep the budget anyway with the first candidate title-cased
  // (better than dropping it; the user can rename the category later).
  const raw = candidates.find(Boolean);
  if (raw && raw.length >= 3) {
    return { command: 'set_budget', category: raw.charAt(0).toUpperCase() + raw.slice(1), amount };
  }
  return null;
}

// --- Milímetros de lluvia ---
export function parseMilimetros(texto) {
  const lower = texto.toLowerCase().replace(/,/g, ".");
  const match = lower.match(/(\d+(?:\.\d+)?)\s*(?:mm|mil[ií]metros|milimetros)/);
  if (match) return parseFloat(match[1]);
  const matchVerb = lower.match(/(?:llovi[oó]|cayeron|llovieron)\s+(\d+(?:\.\d+)?)/);
  if (matchVerb) return parseFloat(matchVerb[1]);
  return null;
}

// --- Campo / Lote ---
export function detectarCampo(texto) {
  const lower = texto.toLowerCase();
  const match = lower.match(/(?:campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/);
  if (!match) return null;
  // Trim trailing keywords that aren't part of the name
  let name = match[1].trim();
  name = name.replace(/\s+(?:esta|queda|tiene|en|presencia|estado|hay|se).*$/i, '').trim();
  if (!name || name.length < 1) return null;
  return name;
}

// Exclusion list for "en el/la" pattern — common words that are NOT plot names
const EN_EL_EXCLUSIONS = new Set([
  "mes", "ano", "dia", "semana", "campo", "banco", "pueblo", "ciudad",
  "zona", "pais", "momento", "total", "final", "presupuesto", "resumen",
  "periodo", "rango", "tiempo", "lugar", "area",
]);

export function detectarLote(texto) {
  const lower = texto.toLowerCase();

  // Pronoun references → sentinel
  if (/(?:ese|este|aquel)\s+(?:lote|campo)/.test(lower)) return "__last__";
  if (/(?:el\s+mismo|ah[ií]\s+mismo|mismo\s+lote|^ah[ií]$)/.test(lower)) return "__last__";
  if (/(?:^|\s)(?:y\s+)?ah[ií](?:\s|$)/.test(lower)) return "__last__";
  if (/en\s+(?:ese|ése)(?:\s|$)/.test(lower)) return "__last__";

  // "lote del/de la X" (multi-word: "lote del fondo")
  const matchLoteDel = lower.match(/lote\s+((?:del?|de\s+la)\s+\w+(?:\s+\w+)?)/);
  if (matchLoteDel) return matchLoteDel[1].trim();

  // "lote X" (original simple pattern)
  const matchLote = lower.match(/lote\s+(\w+)/);
  if (matchLote) return matchLote[1];

  // "en el/la X" (after preposition, excluding common words)
  const matchEnEl = lower.match(/en\s+(?:el|la)\s+(\w+)/);
  if (matchEnEl) {
    const candidate = matchEnEl[1];
    if (!EN_EL_EXCLUSIONS.has(candidate)) return candidate;
  }

  return null;
}

export { normalizeText, fuzzyLookupDetailed };

// Backward compat: returns first match from either lote or campo/parcela
export function detectarCampoLote(texto) {
  return detectarLote(texto) || detectarCampo(texto);
}

// --- Meses ---
const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11
};

const MESES_NOMBRE = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function parseMesNombre(str) {
  str = str.trim().toLowerCase();
  // Remove accents for matching
  const norm = normalizeText(str);
  if (MESES[norm] !== undefined) return MESES[norm];
  if (MESES[str] !== undefined) return MESES[str];
  return null;
}

// --- Time reference parsing for history queries ---

export function parseTimeReference(text) {
  const lower = text.toLowerCase();
  const now = new Date();

  // "última vez" / "la última" → null (caller queries most recent 1)
  if (/(?:ultima|última)\s+vez/.test(lower) || /la\s+(?:ultima|última)/.test(lower)) {
    return null;
  }

  // "hoy"
  if (/\bhoy\b/.test(lower)) {
    const desde = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { desde, hasta: now };
  }

  // "ayer"
  if (/\bayer\b/.test(lower)) {
    const desde = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const hasta = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
    return { desde, hasta };
  }

  // "esta semana"
  if (/esta\s+semana/.test(lower)) {
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((day + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return { desde: monday, hasta: now };
  }

  // "este mes"
  if (/este\s+mes/.test(lower)) {
    const desde = new Date(now.getFullYear(), now.getMonth(), 1);
    return { desde, hasta: now };
  }

  // "la semana pasada"
  if (/(?:la\s+)?semana\s+pasada/.test(lower)) {
    const day = now.getDay();
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() - ((day + 6) % 7));
    thisMonday.setHours(0, 0, 0, 0);
    const prevMonday = new Date(thisMonday);
    prevMonday.setDate(thisMonday.getDate() - 7);
    const prevSunday = new Date(thisMonday);
    prevSunday.setDate(thisMonday.getDate() - 1);
    prevSunday.setHours(23, 59, 59, 999);
    return { desde: prevMonday, hasta: prevSunday };
  }

  // "el mes pasado"
  if (/(?:el\s+)?mes\s+pasado/.test(lower)) {
    const desde = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const hasta = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { desde, hasta };
  }

  // "últimos N días"
  const matchDias = lower.match(/(?:ultimos|últimos)\s+(\d+)\s+d[ií]as?/);
  if (matchDias) {
    const n = parseInt(matchDias[1]);
    const desde = new Date(now);
    desde.setDate(now.getDate() - n);
    desde.setHours(0, 0, 0, 0);
    return { desde, hasta: now };
  }

  // "últimas N semanas"
  const matchSemanas = lower.match(/(?:ultimas|últimas)\s+(\d+)\s+semanas?/);
  if (matchSemanas) {
    const n = parseInt(matchSemanas[1]);
    const desde = new Date(now);
    desde.setDate(now.getDate() - n * 7);
    desde.setHours(0, 0, 0, 0);
    return { desde, hasta: now };
  }

  // "en marzo", "en enero", etc.
  const matchMes = lower.match(/en\s+(\w+)/);
  if (matchMes) {
    const mesIdx = MESES[matchMes[1]];
    if (mesIdx !== undefined) {
      let year = now.getFullYear();
      if (mesIdx > now.getMonth()) year--;
      const desde = new Date(year, mesIdx, 1);
      const hasta = new Date(year, mesIdx + 1, 0, 23, 59, 59);
      return { desde, hasta };
    }
  }

  return null;
}

// --- Activity filter parsing (ACTIVITY_FILTER_PATTERNS imported from constants/agro-terms.ts) ---

export function parseActivityFilter(text) {
  const lower = text.toLowerCase();
  for (const { pattern, type } of ACTIVITY_FILTER_PATTERNS) {
    if (pattern.test(lower)) return type;
  }
  return null;
}

export function parseSpanishDate(str) {
  str = str.trim().toLowerCase();

  const matchTexto = str.match(/(\d{1,2})\s+(?:de\s+)?(\w+)/);
  if (matchTexto) {
    const day = parseInt(matchTexto[1]);
    const mesName = matchTexto[2];
    if (MESES[mesName] !== undefined) {
      const now = new Date();
      return new Date(now.getFullYear(), MESES[mesName], day);
    }
  }

  const matchSlash = str.match(/(\d{1,2})\/(\d{1,2})/);
  if (matchSlash) {
    const day = parseInt(matchSlash[1]);
    const month = parseInt(matchSlash[2]) - 1;
    const now = new Date();
    return new Date(now.getFullYear(), month, day);
  }

  return null;
}

// ============================================================================
// COMMAND_PATTERNS — Reemplaza el if/else chain
// ============================================================================

const COMMAND_PATTERNS = [
  // --- Confirmación ---
  { command: "confirm", patterns: [/^(si|confirmar|confirmo|dale|va)$/] },
  { command: "cancel", patterns: [/^(no|cancelar|cancelo|nah)$/] },

  // --- Saludos y ayuda ---
  { command: "greeting", patterns: [
    /^(hola|buenas|buen dia|buenas tardes|buenas noches|hey|que tal)\b/,
    // "che" alone — Argentine filler used as attention call. Anchor to $
    // because "che, fumigué lote 3" is a registration, not a greeting.
    /^che$/,
  ] },
  { command: "thanks", patterns: [/^(gracias|gracia|thank|thx|genial|joya)\b/] },
  { command: "ack", patterns: [/^(ok|listo|perfecto|bien|bueno|entendido)$/] },
  // Closings: short messages that are ONLY pleasantries / farewells. Avoids
  // sending these into the agent, which sometimes responds verbosely with a
  // tool call and the user then "needs" to keep the conversation going (the
  // QA chaos persona caught despedida loops). Match short messages (≤40 chars)
  // that consist only of closing words/phrases.
  { command: "ack", patterns: [
    /^(chau|nos\s+vemos|hasta\s+luego|hasta\s+la\s+pr[óo]xima|abrazo|saludos)\b/i,
    /^(?:dale|ok|listo|perfecto|bueno|bien|todo\s+bien|todo\s+ok|all\s+good)[\s,.!]*(?:gracias|grax|graxias|che|boludo|amigo)?[\s,.!]*$/i,
    /^(?:gracias|grax)[\s,.!]+(?:che|boludo|amigo|capo|maestro)[\s,.!]*$/i,
    /^(?:dejalo\s+as[íi]|d[eé]jalo|listo\s+nom[áa]s|qued[óo]\s+todo\s+bien)[\s,.!]*$/i,
  ] },
  { command: "help", patterns: [
    /^(ayuda|ayudame|help|comandos|\?)$/,
    // Open-ended capability questions — route to category menu instead of letting
    // the conversational fallback improvise a list (which often gets truncated).
    /^que (podes|sabes|haces|sabes hacer|podes hacer|podes ofrecer) ?(vos)?$/,
    /^que (podes|sabes) hacer( vos)?$/,
    // 1ª persona ("yo"): "que puedo hacer", "que puedo preguntarte", etc.
    /^que puedo (hacer|preguntar|preguntarte|consultar|usar|ver)( aca| aqui| con vos)?$/,
    /^que cosas (puedo|podes) (hacer|usar)$/,
    /^como (funcionas|funciona esto|te uso|te utilizo|me ayudas|me ayudas vos)$/,
    /^para que (servis|sirves|sirve esto|te uso)$/,
    /^(quien sos|que sos|que es esto)$/,
    // Help-seeking phrases that get a friendly redirect to the categorized menu
    /^(una pregunta|tengo una pregunta|tengo una duda|tengo una consulta)$/,
    /^(podrias|podes|me podes|me podrias) ayudar(me)?$/,
    /^(no se|no entiendo|no entendi|no entendí|me explicas|me explicás|estoy perdido|estoy perdida)$/,
  ] },

  // --- Crop name alone → list active crops of that type ---
  // "soja" / "maíz" / "trigo" alone is a query about that crop.
  // Without this trivial route, the agent fires active_crop anyway
  // (cost) and the response ends up identical.
  {
    command: "active_crop",
    patterns: [/^(soja|maiz|maíz|trigo|girasol|sorgo|cebada|avena|algodon|algodón|centeno)$/i],
    extract: (m) => ({ crop: m[1] }),
  },

  // --- Livestock keywords alone → list inventory ---
  // "vacas" / "hacienda" / "ganado" without verb → list_livestock.
  // Otherwise the agent sometimes mis-routes to active_crop (vacas as
  // a "crop") and the response is wrong.
  {
    command: "list_livestock",
    patterns: [/^(vacas|hacienda|haciendas|ganado|animales)$/i],
  },

  // --- Stock keyword alone → check_stock ---
  // "stock" / "insumos" alone → check_stock (lists everything or shows empty
  // state with suggestion buttons).
  {
    command: "check_stock",
    patterns: [/^(stock|insumos)$/i],
  },
  { command: "menu", patterns: [/^(menu|menú|opciones)$/] },
  { command: "show_reports_menu", patterns: [
    /^(?:reportes?|informes?|ver\s+reportes?|ver\s+informes?|mis\s+reportes?)$/,
    /^(?:quiero|necesito|dame|mostrar?|mostra)\s+(?:un\s+)?(?:reportes?|informes?)$/,
  ]},

  // --- Start flows via text ---
  { command: "start_expense_flow", patterns: [
    /^(?:registrar|cargar|anotar|nuevo|nueva)\s+(?:un\s+)?gasto$/,
    /^(?:quiero|necesito)\s+(?:registrar|cargar|anotar)\s+(?:un\s+)?gasto$/,
    /^(?:agregar|agrega)\s+(?:un\s+)?gasto$/,
  ]},
  { command: "start_income_flow", patterns: [
    /^(?:registrar|cargar|anotar|nuevo|nueva)\s+(?:un\s+)?ingreso$/,
    /^(?:quiero|necesito)\s+(?:registrar|cargar|anotar)\s+(?:un\s+)?ingreso$/,
    /^(?:agregar|agrega)\s+(?:un\s+)?ingreso$/,
  ]},

  // --- Document upload ---
  { command: "start_document_upload", patterns: [
    /^(?:cargar|subir|procesar)\s+(?:una?\s+)?(?:foto\s+(?:de\s+)?)?(?:la\s+)?(factura|remito|ticket|comprobante)/,
  ], extract: (m) => ({ documentType: m[1] === 'comprobante' ? 'factura' : m[1] }) },

  // --- Request more AI messages ---
  { command: "request_more_messages", patterns: [
    /^(?:quiero|necesito)\s+m[aá]s\s+mensajes$/,
    /^m[aá]s\s+mensajes$/,
    /^(?:solicitar|pedir)\s+m[aá]s\s+mensajes$/,
    /^ampliar\s+(?:mi\s+)?(?:l[ií]mite|plan)$/,
  ]},

  // --- Dólar (cotización) ---
  // Only match when the message is CLEARLY about the FX quote, not when "dolares" appears as a
  // currency filter inside a financial query ("mostrame gastos en dolares", "y solo en dolares", "ingresos en USD").
  // Negative lookahead: reject if the message contains financial verbs/nouns that imply a query, not a quote.
  // Negative lookbehind: reject "200 dolares" (amount).
  {
    command: "dollar",
    patterns: [
      /^(?:el\s+)?(?:dolar|dólar)\s*\??$/i,
      /^(?:cuanto|cuánto|a\s+cuanto|a\s+cuánto)\s+(?:est[áa]\s+|vale\s+)?(?:el\s+)?(?:dolar|dólar)\b/i,
      /^(?:cotizaci[óo]n|precio)\s+(?:del?\s+)?(?:dolar|dólar)\b/i,
      /^(?:dolar|dólar)\s+(?:hoy|blue|oficial|mep|ccl|tarjeta)\b/i,
      /^(?:ver|mostrar?(?:me)?)\s+(?:el\s+)?(?:dolar|dólar|cotizaci[óo]n)/i,
    ],
  },

  // --- Alertas ---
  {
    command: "show_alerts",
    patterns: [/^(?:mis\s+)?alertas$/, /^(?:ver|mostrar|estado)\s+alertas$/, /^configuracion\s+alertas$/],
  },
  {
    command: "set_rain_threshold",
    patterns: [
      /(?:alerta|umbral)\s+(?:de\s+)?lluvia\s+(\d+)\s*(?:mm)?/,
      /lluvia\s+(?:alerta|umbral)\s+(\d+)\s*(?:mm)?/,
      /alertame\s+(?:cuando\s+)?(?:lluev[ae]n?|llueva)\s+(?:m[aá]s\s+de\s+)?(\d+)\s*mm/i,
      /avisame\s+(?:cuando\s+)?(?:lluev[ae]n?|llueva)\s+(?:m[aá]s\s+de\s+)?(\d+)\s*mm/i,
    ],
    extract: (m) => ({ mm: parseInt(m[1]) }),
  },
  {
    command: "_toggle_alert",
    patterns: [
      // Support both "activar" and "activá/desactivá/activa" (vos + tú forms) +
      // optional articles "el/la/los/las" and "alertas? de"
      /^(activar|activ[aá]|desactivar|desactiv[aá]|habilitar|habilit[aá]|deshabilitar|deshabilit[aá])\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:alertas?\s+(?:de\s+)?)?(?:el\s+|la\s+)?(lluvia|presupuesto|resumen\s+semanal|resumen)/,
      /^(activar|activ[aá]|desactivar|desactiv[aá]|habilitar|habilit[aá]|deshabilitar|deshabilit[aá])\s+(?:el\s+|la\s+)?(lluvia|presupuesto|resumen\s+semanal|resumen)$/,
    ],
    extract: (m) => {
      const enable = /^(activar|activ[aá]|habilitar|habilit[aá])/.test(m[1]);
      const type = m[2].trim();
      if (/lluvia/.test(type)) return { command: enable ? "enable_rain_alerts" : "disable_rain_alerts" };
      if (/presupuesto/.test(type)) return { command: enable ? "enable_budget_alerts" : "disable_budget_alerts" };
      if (/resumen/.test(type)) return { command: enable ? "enable_weekly_summary" : "disable_weekly_summary" };
      return null;
    },
  },

  // --- Lotes (plots) de un campo ---
  {
    command: "list_plots",
    patterns: [
      /^(?:mis\s+lotes|ver\s+lotes|listar\s+lotes)$/,
      // "mostrame lotes" / "mostrame mis lotes" but NOT "mostrame lotes con/que/donde/de + <agronomic stuff>"
      // — those are scouting / filter queries the agent should handle.
      /(?:mostrar?|mostra|dame|decime)\s+(?:mis\s+)?lotes(?:\s+(?:del?\s+)?campo\s+\w+)?\s*\??$/,
      /cuantos?\s+lotes?/,
      /cu[aá]les\s+son\s+(?:mis\s+)?lotes/,
      /q(?:ue)?\s+lotes?\s+tengo/,
      /(?:tengo|hay)\s+lotes?\s*\??$/,
      /(?:info|informacion|datos?|detalle)\s+(?:de\s+)?(?:mis\s+)?lotes/,
      /(?:mis\s+)?lotes\s+(?:del?\s+)?campo\s+((?:\w+)(?:\s+\w+){0,3})/,
      /lotes\s+(?:del?\s+)?campo\s+((?:\w+)(?:\s+\w+){0,3})/,
      /q(?:ue)?\s+lotes\s+tiene\s+(?:el\s+)?campo\s+((?:\w+)(?:\s+\w+){0,3})/,
      /q(?:ue)?\s+lotes\s+tiene\s+(?:el\s+)?campo\s*\??$/,
    ],
    extract: (m) => m[1] ? { fieldName: m[1].trim() } : {},
  },
  {
    command: "add_plots_batch",
    patterns: [
      /(?:quiero\s+)?(?:agregar|agrega|crear)\s+(?:los\s+)?lotes\s+(.+)/,
    ],
    extract: (m, _norm, original) => {
      // Re-match on original text to preserve casing
      const re = /(?:quiero\s+)?(?:agregar|agrega|crear)\s+(?:los\s+)?lotes\s+(.+)/i;
      const cm = original ? original.match(re) : null;
      let raw = (cm ? cm[1] : m[1]).trim();

      // Extract trailing area spec FIRST so it doesn't get misparsed as
      // a field name. Patterns: "de 50 ha cada uno", "50 ha c/u", "50 hectáreas".
      let area = null;
      const areaMatch = raw.match(/\s+(?:de\s+)?(\d+(?:\.\d+)?)\s*(?:has?|hect[aá]reas?)(?:\s+(?:cada\s+(?:uno|una)|c\/u|cu))?\s*$/i);
      if (areaMatch) {
        area = parseFloat(areaMatch[1]);
        raw = raw.slice(0, raw.length - areaMatch[0].length).trim();
      }

      // Extract optional field name from "en [campo]" / "en el [campo]" suffix
      let fieldName = null;
      const fieldMatch = raw.match(/\s+(?:en|al?|del?)\s+(?:(?:el|la|mi)\s+)?(?:campo\s+)?(.+)$/i);
      if (fieldMatch) {
        // Only treat as field if it's after the last comma/y (not splitting a plot name)
        const fieldPart = fieldMatch[0];
        const beforeField = raw.slice(0, raw.length - fieldPart.length);
        // Ensure the part before contains at least one plot name separator
        if (/[,]|\sy\s/.test(beforeField)) {
          fieldName = fieldMatch[1].trim();
          raw = beforeField.trim();
        }
      }
      const names = raw
        .split(/\s*[,]\s*|\s+y\s+/)
        .map(n => n.trim())
        .filter(n => n.length > 0 && !/^\d+\s*ha$/i.test(n));
      const result = { plotNames: names };
      if (fieldName) result.fieldName = fieldName;
      if (area) result.area = area;
      return result;
    },
  },
  {
    command: "add_plot",
    patterns: [
      /(?:agregar|agrega|nuevo|crear)\s+(?:(?:un|el)\s+)?lote\s+(.+?)\s+(?:en|al?|del?)\s+(?:(?:el|mi)\s+)?campo\s+(.+)/,
      /(?:agregar|agrega|nuevo|crear)\s+(?:(?:un|el)\s+)?lote\s+(.+?)\s+(?:en|al?|del?)\s+(?:(?:la|mi)\s+)?parcela\s+(.+)/,
      // "crear lote 3 en sur" — lote + en + field name (no "campo" keyword needed)
      /(?:agregar|agrega|nuevo|crear)\s+(?:(?:un|el)\s+)?lote\s+(.+?)\s+(?:en|al?|del?)\s+(.+)/,
      // "agregar lote 5 norte" — lote + name + bare field name (no preposition)
      /(?:agregar|agrega|nuevo|crear)\s+(?:(?:un|el)\s+)?lote\s+(\S+)\s+(\S+)$/,
      // "lote 4 para campo norte" — lote + plot + para + campo
      /^lote\s+(\S+)\s+(?:para|en|al?|del?)\s+(?:(?:el|mi)\s+)?(?:campo|parcela)\s+(.+)/,
    ],
    extract: (m, _norm, original) => {
      // Re-match on original text to preserve casing
      const re = /(?:agregar|agrega|nuevo|crear)\s+(?:(?:un|el)\s+)?lote\s+(.+?)\s+(?:en|al?|del?)\s+(?:(?:el|la|mi)\s+)?(?:campo|parcela\s+)?(.+)/i;
      const cm = original ? original.match(re) : null;
      // For the "lote X para campo Y" pattern
      const re2 = /^lote\s+(\S+)\s+(?:para|en|al?|del?)\s+(?:(?:el|mi)\s+)?(?:campo|parcela)\s+(.+)/i;
      const cm2 = original ? original.match(re2) : null;
      return {
        plotName: (cm2 ? cm2[1] : cm ? cm[1] : m[1]).trim(),
        fieldName: (cm2 ? cm2[2] : cm ? cm[2] : m[2]).trim(),
      };
    },
  },
  {
    // "asignar grupo X al lote A" / "el lote A es del grupo X" / "lotes 1A, 1B son de X"
    // Fast-path that skips the AI agent for clear titularidad/grupo phrasings.
    command: "set_plot_grupo",
    patterns: [
      // "(los )lotes A, B son del grupo X" / "...son de X" / "...pertenecen al grupo X"
      /(?:los\s+)?lotes\s+(.+?)\s+(?:son\s+(?:de|del)\s+(?:grupo\s+|sociedad\s+|titularidad\s+)?|pertenecen\s+al?\s+(?:grupo\s+)?)(.+)/,
      // "el lote A es del grupo X" / "lote A es de X"
      /(?:el\s+)?lote\s+(.+?)\s+es\s+(?:de|del)\s+(?:grupo\s+|sociedad\s+|titularidad\s+)?(.+)/,
      // "asignar grupo X al lote A" / "asigna grupo X a lotes A, B"
      /asign(?:ar|a)\s+(?:grupo|sociedad|titularidad)\s+(.+?)\s+a(?:l)?\s+(?:los\s+)?lotes?\s+(.+)/,
    ],
    extract: (m, _norm, _original) => {
      // The "asignar" pattern flips the order (grupo first, plots second).
      const isAsignar = /^asign(?:ar|a)/i.test(m[0]);
      const grupo = (isAsignar ? m[1] : m[2]).trim();
      const plotsRaw = (isAsignar ? m[2] : m[1]).trim();
      const plotNames = plotsRaw
        .split(/\s*,\s*|\s+y\s+/)
        .map(s => s.trim())
        .filter(Boolean);
      if (plotNames.length === 0 || !grupo) return null;
      return { plotNames, grupo };
    },
  },
  {
    // "agregar lote D" / "crear el lote norte" — no field specified (handler auto-assigns)
    // (.+?) stops before " y " + action verb to avoid swallowing compound messages
    command: "add_plot",
    patterns: [
      /(?:agregar|agrega|nuevo|crear|añadir)\s+(?:(?:un|el)\s+)?lote\s+(.+?)(?:\s+y\s+|$)/,
    ],
    extract: (m, _norm, original) => {
      const re = /(?:agregar|agrega|nuevo|crear|añadir)\s+(?:(?:un|el)\s+)?lote\s+(.+?)(?:\s+y\s+|$)/i;
      const cm = original ? original.match(re) : null;
      const captured = (cm ? cm[1] : m[1]).trim();
      // For a single bare word ("agregar lote sur"), defer to the smart-lote
      // add_field flow further down — that path uses entityKeyword='lote' and
      // auto-resolves the field. Only catch here when it's clearly a multi-token
      // plot reference (numeric or multi-word).
      const looksLikeBareSingleWord = /^\w+$/.test(captured) && !/^\d/.test(captured);
      if (looksLikeBareSingleWord) return null;
      return {
        plotName: captured,
        fieldName: null,
      };
    },
  },
  {
    // "quiero agregar un lote" / "agregar lote" / "crear un lote" — generic, no name given
    command: "prompt_add_plot",
    patterns: [
      /^(?:quiero\s+)?(?:agregar|agrega|crear|añadir|nuevo)\s+(?:(?:un|el|mi)\s+)?lote\s*$/,
    ],
    extract: () => ({}),
  },
  {
    command: "plot_info",
    patterns: [
      /(?:info|detalle|datos?|informacion)\s+(?:del?\s+)?lote\s+(.+?)\s+(?:del?\s+)?campo\s+(.+)/,
      /(?:info|detalle|datos?|informacion)\s+(?:del?\s+)?lote\s+(\w+)/,
      /(?:estado|como\s+viene)\s+(?:(?:el|del?)\s+)?lote\s+(\w+)/,
      /^lote\s+((?:\w+)(?:\s+(?!esta\s|queda\s|en\s|tiene\s)\w+){0,3})\s*\??$/,
    ],
    extract: (m, _norm, original) => {
      if (m[2]) {
        // Two-group pattern (lote + campo) — preserve casing
        const re = /(?:info|detalle|datos?|informacion)\s+(?:del?\s+)?lote\s+(.+?)\s+(?:del?\s+)?campo\s+(.+)/i;
        const cm = original ? original.match(re) : null;
        return {
          plotName: (cm ? cm[1] : m[1]).trim(),
          fieldName: (cm ? cm[2] : m[2]).trim(),
        };
      }
      return { plotName: m[1], fieldName: null };
    },
  },
  {
    command: "delete_plot",
    patterns: [
      /(?:borr(?:ar|a)|elimin(?:ar|a)|sacar|quitar)\s+(?:el\s+)?lote\s+(.+?)\s+(?:del?\s+)?campo\s+(.+)/,
    ],
    extract: (m, _norm, original) => {
      const re = /(?:borr(?:ar|a)|elimin(?:ar|a)|sacar|quitar)\s+(?:el\s+)?lote\s+(.+?)\s+(?:del?\s+)?campo\s+(.+)/i;
      const cm = original ? original.match(re) : null;
      return {
        plotName: (cm ? cm[1] : m[1]).trim(),
        fieldName: (cm ? cm[2] : m[2]).trim(),
      };
    },
  },
  // --- Listar campos ---
  {
    command: "list_fields",
    patterns: [
      /^(?:mis\s+(?:campos|parcelas)|ver\s+(?:mis\s+)?campos|listar\s+campos)$/,
      /cuantos?\s+(?:campos?|parcelas?)/,
      /que\s+(?:campos?|parcelas?)\s+tengo/,
      /(?:tengo|hay)\s+(?:campos?|parcelas?)\s*\??$/,
      /(?:mostrar?|mostra|dame|decime)\s+(?:mis\s+)?(?:campos?|parcelas?)/,
      // Audio transcription patterns (campos only)
      /(?:info|informacion|datos?|detalle)\s+(?:de\s+)?(?:mis\s+)?(?:campos|parcelas)/,
    ],
  },

  // --- Borrar campo/lote ---
  {
    command: "delete_field",
    patterns: [/(?:borr(?:ar|a)|elimin(?:ar|a)|sacar|quitar)\s+(?:el\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/],
    extract: (m) => ({ entityKeyword: m[1], fieldName: m[2].trim() }),
  },

  // --- Info campo/lote ---
  {
    command: "field_info",
    patterns: [
      /(?:info|detalle|datos?|informacion)\s+(?:del?\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/,
      /(?:estado|como\s+viene)\s+(?:(?:el|del?)\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/,
      /^(lote|campo|parcela)\s+((?:\w+)(?:\s+(?!esta\s|queda\s|en\s|tiene\s)\w+){0,3})\s*\??$/,
    ],
    extract: (m) => ({ entityKeyword: m[1], fieldName: m[2].trim() }),
  },

  // --- Agronomy reports (high-signal patterns to avoid AI confusion with financial) ---
  {
    command: "generate_agro_report",
    patterns: [
      // "reporte/informe agronómico [del] [lote] X"
      /(?:registro|reporte|informe|resumen)\s+(?:agro(?:pecuario|n[oó]mico)?)\s+(?:(?:del?|en)\s+)?(?:lote\s+)?(.+)/,
      // "reporte/informe agronómico" (sin lote)
      /(?:registro|reporte|informe|resumen)\s+(?:agro(?:pecuario|n[oó]mico)?)/,
      // "estado/novedades del lote/campo X"
      /(?:estado|novedades)\s+(?:del?|en)\s+(?:(?:el|mi)\s+)?(?:lote|campo)\s+(.+)/,
      // "cómo va/viene/está [el] lote/campo X"
      /c[oó]mo\s+(?:va|viene|est[aá])\s+(?:(?:el|mi)\s+)?(?:lote|campo)\s+(.+)/,
    ],
    extract: (m) => ({ plotName: m[1]?.trim() || null }),
  },
  {
    command: "query_plot_history",
    patterns: [
      /(?:qu[eé]\s+pas[oó]|que\s+hay|actividad(?:es)?|historial)\s+(?:en\s+)?(?:(?:el|del?)\s+)?lote\s+(.+)/,
      // "última vez que se sembró/fumigó/fertilizó [en] [el] lote X"
      /(?:ultima|última)\s+(?:vez\s+(?:que\s+)?)?(?:se\s+)?(?:fumig|pulveriz|fertiliz|sembr|cosech|reg|ar[oó]|labr)\S*\s+(?:.*?\s+)?(?:(?:en|del?)\s+)?(?:(?:el|mi)\s+)?lote\s+(.+)/,
      // "se sembró/fumigó [en] [el] lote X" (binary questions)
      /(?:se\s+)?(?:fumig[oó]|pulveriz[oó]|fertiliz[oó]|sembr[oó]|cosech[oó]|reg[oó]|ar[oó]|labr[oó])\s+(?:(?:en|del?)\s+)?(?:(?:el|mi)\s+)?lote\s+(.+)/,
      // "cuando se sembró/fumigó [por última vez] [en] [el] lote X"
      /(?:cuando|cuándo)\s+(?:se\s+)?(?:fumig|pulveriz|fertiliz|sembr|cosech|reg|ar[oó]|labr)\S*\s+(?:.*?\s+)?(?:(?:en|del?)\s+)?(?:(?:el|mi)\s+)?lote\s+(.+)/,
      // "hubo lluvia en el lote X"
      /(?:hubo|hay|cay[oó]|llov[ií][oó]?)\s+(?:lluvias?|precipitacion(?:es)?|agua)\s+(?:(?:en|del?)\s+)?(?:(?:el|mi)\s+)?lote\s+(.+)/,
    ],
    extract: (m, fullText) => {
      const plotName = m[1]?.trim()
        .replace(/[?¿!¡.,;:]+$/g, '')
        .replace(/\s+(?:por\s+)?(?:ultima|última)\s+vez.*$/i, '')
        .replace(/\s+(?:en|de|del|durante|este|esta|estos|estas|el|la|los|las)\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|semana|mes|año|hoy|ayer|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo).*$/i, '')
        .replace(/\s+(?:(?:ultimos|últimos|ultimas|últimas)\s+\d+\s+d[ií]as?).*$/i, '')
        .trim() || null;
      const activityFilter = parseActivityFilter(fullText);
      const lower = fullText.toLowerCase();
      const isUltimaVez = /(?:ultima|última)\s+vez/.test(lower)
        || /(?:cuando|cuándo)\s+(?:se\s+)?(?:fumig|pulveriz|fertiliz|sembr|cosech|reg|ar[oó]|labr)/i.test(lower);
      const isBinaryQuestion = /(?:se\s+)?(?:fumig[oó]|pulveriz[oó]|fertiliz[oó]|sembr[oó]|cosech[oó]|reg[oó]|ar[oó]|labr[oó])\s/.test(lower)
        && !isUltimaVez;
      return { plotName, activityFilter, isUltimaVez, isBinaryQuestion };
    },
    condition: (n) => /lote\s+\S/.test(n) && /(?:qu[eé]\s+pas|que\s+hay|actividad|historial|ultima|última|cuando|cuándo|(?:se\s+)?(?:fumig|pulveriz|fertiliz|sembr|cosech|reg[oó]|ar[oó]|labr)|hubo\s+(?:lluvia|agua)|llov[ií])/.test(n),
  },

  {
    command: "add_field_city",
    patterns: [/tengo\s+(?:un\s+)?(lote|campo|parcela)\s+en\s+(.+)/],
    extract: (m) => ({
      entityKeyword: m[1],
      city: m[2].trim().charAt(0).toUpperCase() + m[2].trim().slice(1),
    }),
  },
  {
    command: "add_field_city",
    patterns: [/(?:agregar|agrega|nuevo|crear)\s+(?:un\s+)?(?:campo|parcela)\s+en\s+(.+)/],
    extract: (m) => ({
      entityKeyword: 'campo',
      city: m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1),
    }),
  },
  {
    command: "add_field",
    // Stop city extraction at the first comma so compound messages like
    // "agregar campo X en Y, lotes A,B" don't smuggle the rest into city.
    patterns: [/(?:agregar|agrega|nuevo|crear)\s+(lote|campo|parcela)\s+((?:\w+)(?:\s+(?!en\s)\w+){0,3})(?:\s+en\s+([^,]+))?/],
    extract: (m, _norm, original) => {
      // If the original message contains additional clauses (lotes/sembré/etc.),
      // defer to the agent — trivial parsing would smuggle "Junín con lotes A"
      // into the city and DROP the lotes. The agent's ONBOARDING rule turns
      // "agregar campo X en Y con lotes A,B" into add_field + add_plots_batch.
      if (original && (
        /,\s+(lotes?|sembr[ée]|fumig[ué]|coseché|cosech[ée]|llov[ií][oó]?|fertilic[ée]|y\s+\w)/i.test(original)
        || /\bcon\s+(?:los\s+|el\s+|un\s+)?lotes?\b/i.test(original)
        || /\b(sembr[ée]|fumig[ué]|cosech[ée]|fertilic[ée]|llov[ií])/i.test(original)
      )) {
        return null;
      }
      // Re-matchear contra el texto ORIGINAL para preservar las mayúsculas del
      // nombre propio ("La Loma" debe quedar "La Loma", no "la loma"). `m` viene
      // del texto normalizado (minúsculas, sin acentos) — solo sirve para
      // detectar el comando. Bug visto live (Jun 2026): el campo se guardaba en
      // minúscula. Char-class incluye acentos para nombres como "La Peña".
      const reOrig = /(?:agregar|agrega|nuevo|crear)\s+(?:lote|campo|parcela)\s+((?:[\wáéíóúüñ]+)(?:\s+(?!en\s)[\wáéíóúüñ]+){0,3})(?:\s+en\s+([^,]+))?/i;
      const om = original ? original.match(reOrig) : null;
      const nameSrc = (om && om[1]) ? om[1] : m[2];
      const citySrc = (om && om[2] != null) ? om[2] : m[3];
      return {
        entityKeyword: m[1],
        fieldName: nameSrc.trim(),
        city: citySrc ? citySrc.trim().charAt(0).toUpperCase() + citySrc.trim().slice(1) : null,
      };
    },
  },

  {
    // "quiero agregar un campo" / "crear un campo" — generic, no name given
    command: "prompt_add_field",
    patterns: [
      /^(?:quiero\s+)?(?:agregar|agrega|crear|añadir|nuevo)\s+(?:(?:un|el|mi)\s+)?campo\s*$/,
    ],
    extract: () => ({}),
  },

  // --- Renombrar campo ---
  {
    command: "rename_field",
    patterns: [
      /(?:renombrar|cambiar\s+(?:el\s+)?nombre(?:\s+del?)?)\s+campo\s+(.+?)\s+(?:a|por)\s+(.+)/,
    ],
    extract: (m, _norm, original) => {
      const re = /(?:renombrar|cambiar\s+(?:el\s+)?nombre(?:\s+del?)?)\s+campo\s+(.+?)\s+(?:a|por)\s+(.+)/i;
      const cm = original ? original.match(re) : null;
      return { oldName: (cm ? cm[1] : m[1]).trim(), newName: (cm ? cm[2] : m[2]).trim(), entityKeyword: 'campo' };
    },
  },
  // --- Renombrar lote ---
  {
    command: "rename_plot",
    patterns: [
      /(?:renombrar|cambiar\s+(?:el\s+)?nombre(?:\s+del?)?)\s+lote\s+(.+?)\s+(?:a|por)\s+(.+?)(?:\s+(?:en|del?)\s+(?:campo\s+)?(.+))?$/,
      // "el lote Norte se llama Lote 1" / "el lote Norte ahora se llama X" / "...pasa a llamarse X"
      /(?:el\s+)?lote\s+(.+?)\s+(?:ahora\s+)?(?:se\s+llama|pasa\s+a\s+llamarse)\s+(.+?)(?:\s+(?:en|del?)\s+(?:campo\s+)?(.+))?$/,
    ],
    extract: (m, _norm, original) => {
      const reA = /(?:renombrar|cambiar\s+(?:el\s+)?nombre(?:\s+del?)?)\s+lote\s+(.+?)\s+(?:a|por)\s+(.+?)(?:\s+(?:en|del?)\s+(?:campo\s+)?(.+))?$/i;
      const reB = /(?:el\s+)?lote\s+(.+?)\s+(?:ahora\s+)?(?:se\s+llama|pasa\s+a\s+llamarse)\s+(.+?)(?:\s+(?:en|del?)\s+(?:campo\s+)?(.+))?$/i;
      const cm = original ? (original.match(reA) || original.match(reB)) : null;
      return {
        oldName: (cm ? cm[1] : m[1]).trim(),
        newName: (cm ? cm[2] : m[2]).trim(),
        fieldName: (cm ? cm[3] : m[3])?.trim() || null,
      };
    },
  },

  // --- Restaurar campo/lote ---
  {
    command: "restore_field",
    patterns: [/(?:restaurar|recuperar|deshacer)\s+(?:el\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/],
    extract: (m) => ({ entityKeyword: m[1], fieldName: m[2].trim() }),
  },

  // --- Ubicación campo/lote ---
  {
    command: "set_field_city",
    patterns: [/(?:quiero\s+)?(?:agregar|poner|configurar|cambiar|asignar)\s+(?:la\s+)?ubicaci[oó]n\s+(?:d?el?\s+)?(?:campo|lote|parcela)?/],
    extract: () => ({ fieldName: null, city: null }),
  },
  {
    command: "set_field_city",
    patterns: [/ubicar\s+(?:el\s+)?(?:campo|lote|parcela)(?:\s+(.+))?/],
    extract: (m) => ({ fieldName: m[1]?.trim() || null, city: null }),
  },
  {
    command: "set_field_city",
    patterns: [
      /(?:la\s+)?ubicaci[oó]n\s+(?:de\s+)?(?:mi\s+)?(campo|lote|parcela)\s+(?:es\s+(?:en\s+)?|est[aá]\s+(?:en\s+)?)(.+)/,
      /(?:mi\s+)(campo|lote|parcela)\s+(?:esta|está|es|queda)\s+(?:en\s+)?(.+)/,
    ],
    extract: (m) => ({
      entityKeyword: m[1],
      fieldName: null,
      city: m[2].trim().charAt(0).toUpperCase() + m[2].trim().slice(1),
    }),
  },
  {
    command: "set_field_city",
    // Anchor at the start of the message and require explicit "ubicad[oa]" OR
    // "está en X" with no agro-stage / activity verb between them, so messages
    // like "el soybean del lote 1A está en V4" don't fall into set_field_city.
    patterns: [/^(?:el\s+|la\s+|mi\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+(?!esta\s|queda\s)\w+){0,3})\s+(?:esta|queda)\s+ubicad[oa]\s+en\s+(.+)/],
    extract: (m) => ({
      entityKeyword: m[1],
      fieldName: m[2].trim(),
      city: m[3].trim().charAt(0).toUpperCase() + m[3].trim().slice(1),
    }),
  },
  {
    command: "set_field_city",
    patterns: [/tengo\s+(?:un\s+)?(lote|campo|parcela)\s+((?:\w+)(?:\s+(?!en\s)\w+){0,3})\s+en\s+(.+)/],
    extract: (m) => ({
      entityKeyword: m[1],
      fieldName: m[2].trim(),
      city: m[3].trim().charAt(0).toUpperCase() + m[3].trim().slice(1),
    }),
  },
  {
    command: "add_field_city",
    patterns: [/tengo\s+(?:un\s+)?(lote|campo|parcela)\s+en\s+(.+)/],
    extract: (m) => ({
      entityKeyword: m[1],
      city: m[2].trim().charAt(0).toUpperCase() + m[2].trim().slice(1),
    }),
  },

  // --- Ubicación / ciudad usuario ---
  {
    command: "set_city",
    patterns: [/^(?:(?:mi\s+)?(?:ciudad|ubicacion|zona)\s+(?:es\s+)?|estoy en\s+)(.+)/],
    extract: (m) => ({
      city: m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1),
    }),
  },

  // --- Identidad ---
  {
    command: "set_name",
    patterns: [/^(?:soy|me llamo)\s+(.+)/],
    extract: (m) => ({
      name: m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1),
    }),
  },

  // --- Presupuesto ---
  // Delegates to parseBudget() so "presupuesto de X para Y", "límite de $X en Y",
  // "tope Y X" all resolve the category via detectarCategoria (not the raw "de").
  {
    command: "set_budget",
    patterns: [/\b(?:presupuesto|presup|limite|tope|techo)\b/],
    extract: (_m, _normalized, original) => {
      const parsed = parseBudget(original);
      if (!parsed) return null;
      return { category: parsed.category, amount: parsed.amount };
    },
  },

  // --- Borrar gasto específico ---
  {
    command: "delete_specific",
    patterns: [/borr(?:ar|a)\s+gasto\s+(?:de\s+)?(.+)/],
    extract: (m, normalized) => {
      if (normalized.includes("ultimo")) return null;
      return { filter: m[1].trim() };
    },
  },

  // --- Borrar último gasto/ingreso/actividad ---
  { command: "delete_last", patterns: [/(?:borr(?:ar|a)|elimin(?:ar|a))\s+(?:el\s+|la\s+)?(?:ultim[oa]|ultima)\s+gasto/] },
  { command: "delete_last_income", patterns: [/(?:borr(?:ar|a)|elimin(?:ar|a))\s+(?:el\s+|la\s+)?(?:ultim[oa]|ultima)\s+ingreso/] },
  { command: "delete_last_activity", patterns: [/(?:borr(?:ar|a)|elimin(?:ar|a))\s+(?:el\s+|la\s+)?(?:ultim[oa]|ultima)\s+(?:actividad|siembra|fumigaci[oó]n|fertilizaci[oó]n|cosecha|labranza|riego)/] },

  // --- Editar gasto específico ---
  {
    command: "edit_specific",
    patterns: [/edit(?:ar|a)\s+gasto\s+(?:de\s+)?(.+?)\s+a\s+(.+)/],
    extract: (m, normalized, original) => {
      if (normalized.includes("ultimo")) return null;
      const newAmount = normalizarMonto(m[2]);
      if (!newAmount) return null;
      return { filter: m[1].trim(), amount: newAmount };
    },
  },

  // --- Editar último gasto ---
  {
    command: "edit_last",
    patterns: [/edit(?:ar|a)\s+ultimo\s+gasto\s+a\s+(.+)/],
    extract: (m) => {
      const newAmount = normalizarMonto(m[1]);
      if (!newAmount) return null;
      return { amount: newAmount };
    },
  },

  // --- Exportar ---
  { command: "export_csv", patterns: [/exportar\s+(?:mes|csv|gastos)/] },
];

// --- Weather helpers ---

function isWeatherContext(normalized) {
  const isWeatherKeyword = /(?:clima|tiempo|pronostico|temperatura)/.test(normalized);
  const isFutureLluvia = /(?:va a llover|llovera|esperan?\s*lluvia|habra\s*lluvia)/.test(normalized);
  const isLluviaMañana = /lluvia/.test(normalized) && /manana/.test(normalized)
    && !/\d+\s*mm/.test(normalized) && !/llovio|cayeron|llovieron|registrar/.test(normalized);
  return isWeatherKeyword || isFutureLluvia || isLluviaMañana;
}

function dispatchWeather(normalized) {
  // "clima todos" / "clima campos"
  if (/clima\s+(todos|campos|general)/.test(normalized)) {
    return { command: "weather_all" };
  }

  // Any mention of "lote/campo X" in a weather question
  const matchAnyLote = normalized.match(/(?:lote|campo|parcela)\s+(\w+)/);
  if (matchAnyLote) {
    return { command: "weather_field", fieldName: matchAnyLote[1] };
  }

  // "clima en Junín", "tiempo en Pergamino"
  const matchCiudad = normalized.match(/(?:clima|tiempo|pronostico)\s+(?:en\s+)?(?:de\s+)?(\w[\w\s]*?)(?:\s+(?:manana|hoy|semana|esta semana|\d+ dias))?$/);
  let city = matchCiudad?.[1]?.replace(/\b(manana|hoy|semana|esta)\b/g, "").trim() || null;

  // "va a llover en Alberdi?", "llovera en Junin mañana?"
  if (!city) {
    const matchEn = normalized.match(/(?:llover|llovera|lluvia)\s+en\s+(\w[\w\s]*?)(?:\s+(?:manana|hoy|semana|esta|\?))?[\s?]*$/);
    city = matchEn?.[1]?.replace(/\b(manana|hoy|semana|esta)\b/g, "").trim() || null;
  }

  if (normalized.includes("semana") || /\d+\s*dias/.test(normalized)) {
    const matchDias = normalized.match(/(\d+)\s*dias/);
    const days = matchDias ? Math.min(parseInt(matchDias[1]), 5) : 5;
    return { command: "weather_forecast", city: city || null, days };
  }
  if (normalized.includes("manana")) {
    return { command: "weather_forecast", city: city || null, days: 1 };
  }
  // Default: current + 3 day forecast
  return { command: "weather_full", city: city || null };
}

// ============================================================================
// parseCommand — Itera COMMAND_PATTERNS, misma API de salida
// ============================================================================

export function parseCommand(texto) {
  const normalized = normalizeText(texto);

  for (const entry of COMMAND_PATTERNS) {
    // Check condition first if present
    if (entry.condition && !entry.condition(normalized)) continue;

    for (const pattern of entry.patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;

      // If there's an extractor, use it
      if (entry.extract) {
        const extracted = entry.extract(match, normalized, texto);
        if (extracted === null) continue;

        // If the extractor returned a command override (for dispatch patterns)
        if (extracted.command) {
          return extracted;
        }

        return { command: entry.command, ...extracted };
      }

      // No extractor — just return the command
      return { command: entry.command };
    }
  }

  return null;
}

// ============================================================================
// Expense / Income parsers — Misma API
// ============================================================================

export function parseMensajeIngreso(texto) {
  const lower = texto.toLowerCase();

  if (!/(?:vend[ií]|cobr[eé]|ingres[eéo]|entr[oó]|factur[eé])/.test(lower)) return null;
  if (esComplejo(texto)) return null;

  // Number-first: income verb check already gates entry, use extractAmount
  const amount = extractAmount(texto);
  const category = detectarCategoriaIngreso(texto);

  if (!amount) return null;

  return {
    type: "income",
    amount,
    category: category || "Otros",
    description: texto,
    currency: lower.includes("dólar") || lower.includes("dolar") || lower.includes("usd") ? "USD" : "ARS",
  };
}

export function parseMensaje(texto) {
  if (isLikelyQuestion(texto)) return null;
  if (esComplejo(texto)) return null;

  const category = detectarCategoria(texto);
  if (!category) return null;

  // Number-first: for financial context use extractAmount, otherwise structured only
  const amount = hasFinancialIntent(texto) ? extractAmount(texto) : normalizarMonto(texto);
  if (!amount) return null;

  return {
    type: "expense",
    amount,
    category,
    description: texto,
    currency: "ARS",
  };
}

/**
 * Parse an agronomic observation from text.
 * Supports both plot-level ("lote 1 ...") and field-level ("campo X ...") observations.
 * Returns null if neither lot nor field reference is found.
 */
export function parsearObservacion(texto) {
  // Strip observation prefix before any processing (with or without colon/dash)
  texto = texto.replace(/^(?:observaci[oó]n|obs|nota)\s*[:\-\u2014]?\s*/i, '').trim();

  const plotName = detectarLote(texto);
  const lower = texto.toLowerCase();

  // 1. Plot observation (lot reference found)
  if (plotName) {
    // Sentinel references are valid (resolved later)
    if (plotName === '__last__') {
      return { plotName, fieldName: null, observationText: texto, category: _detectCategory(lower), type: 'plot' };
    }

    let observationText = texto;
    // Remove "en [el] lote X" or bare "lote X" — MUST remove preposition to avoid trailing "en"
    observationText = observationText.replace(/\s*(?:en\s+(?:el\s+)?)?(?:lote\s+(?:del?\s+la?\s*)?)\w+(?:\s+\w+)?/i, '').trim();
    // Also remove "en [el] campo X" if present alongside the lot
    observationText = observationText.replace(/\s*(?:en\s+(?:el\s+)?)?(?:campo|parcela)\s+[\w\s]+?(?=\s+(?:presencia|estado|estres|estrés|helada|granizo|maleza|plaga|oruga|chinche|deficiencia|clorosis|floración|floracion|nutrici|hongo|roya|enfermedad|sequía|sequia|encharcamiento|viento|llenado|emergencia|macollaje|panojamiento|buen|mal|mucha|poca|alta|baja|hay|se\s+observ|se\s+detect))/i, '').trim();
    observationText = observationText.replace(/\s*(?:en\s+(?:el\s+)?)?(?:campo|parcela)\s+\w+/i, '').trim();
    // Remove trailing bare prepositions left over
    observationText = observationText.replace(/\s+(?:en|en\s+el|del?)\s*$/i, '').trim();
    // Remove leading dashes, colons, commas
    observationText = observationText.replace(/^[\s,:\-—]+/, '').trim();

    if (!observationText || observationText.length < 3) return null;

    const fieldName = _detectCampoMultiWord(lower);
    const category = _detectCategory(lower);
    return { plotName, fieldName, observationText, category, type: 'plot' };
  }

  // 2. Field observation (no lot, but field reference found)
  const fieldName = _detectCampoMultiWord(lower);
  if (fieldName) {
    let observationText = texto;
    // Remove "campo X Y Z" from the text
    observationText = observationText.replace(/(?:campo|parcela)\s+[\w\s]+?(?=\s+(?:presencia|estado|estres|estrés|helada|granizo|maleza|plaga|oruga|chinche|deficiencia|clorosis|floración|floracion|nutrici|hongo|roya|enfermedad|sequía|sequia|encharcamiento|viento|llenado|emergencia|macollaje|panojamiento|buen|mal|mucha|poca|alta|baja|hay|se\s+observ|se\s+detect))/i, '').trim();
    observationText = observationText.replace(/(?:campo|parcela)\s+\w+(?:\s+\w+)*/i, '').trim();
    // Remove leading dashes, colons, commas
    observationText = observationText.replace(/^[\s,:\-—]+/, '').trim();

    if (observationText && observationText.length >= 3) {
      const category = _detectCategory(lower);
      return { plotName: null, fieldName, observationText, category, type: 'field' };
    }
  }

  // 3. Bare observation (no lot/field reference, but strong agronomic keyword detected)
  const category = _detectCategory(lower);
  if (category !== 'general') {
    // Has a specific agronomic category → treat as bare observation
    let observationText = texto.replace(/^[\s,:\-—]+/, '').trim();
    if (observationText && observationText.length >= 3) {
      return { plotName: null, fieldName: null, observationText, category, type: 'bare' };
    }
  }

  return null;
}

/**
 * Detect campo name supporting multi-word names like "la esperanza".
 * Captures up to 3 words after "campo".
 */
function _detectCampoMultiWord(lower) {
  // "campo la esperanza", "campo san pedro", "campo norte"
  const match = lower.match(/(?:campo|parcela)\s+((?:\w+)(?:\s+\w+){0,3})/);
  if (!match) return null;
  // Trim trailing observation keywords that leaked into the name
  let name = match[1].trim();
  name = name.replace(/\s+(?:presencia|estado|estres|estrés|helada|granizo|maleza|plaga|deficiencia|clorosis|nutrici|hongo|roya|enfermedad|sequía|sequia|hay|se|buen|mal).*$/i, '').trim();
  if (!name || name.length < 2) return null;
  return name;
}

function _detectCategory(lower) {
  if (/maleza|rama\s*negra|yuyo|sorgo\s*de\s*alepo|cardo|gramon|gramilla/.test(lower)) return 'malezas';
  if (/oruga|plaga|chinche|isoca|trips|ara[ñn]uela|mosca|pulg[oó]n|bolillera|cogollero|bicho|enfermedad|hongo|roya|mancha/.test(lower)) return 'sanidad';
  if (/nutrici[oó]n|deficiencia|clorosis|amarill|carencia/.test(lower)) return 'nutricion';
  if (/estado\s+(?:fen|v\d|r\d)|fenolog|floraci[oó]n|llenado|emergencia|macollaje|espigaz[oó]n|panojamiento|(?:^|\s)[vr]\d+(?:\s|$)/.test(lower)) return 'fenologia';
  if (/helada|granizo|sequ[ií]a|encharcamiento|stress|estr[eé]s|viento|inundaci[oó]n/.test(lower)) return 'clima';
  return 'general';
}
