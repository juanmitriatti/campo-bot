import type { ParseResult, ParsedExpense, ParsedIncome, ParsedCommand, Currency } from '../types/index.js';
import { EXPENSE_CATEGORY_SET, EXPENSE_CATEGORIES, INCOME_CATEGORY_SET, INCOME_CATEGORIES, INSUMO_CATEGORIES, EXPENSE_KEYWORD_MAP, type IncomeCategory } from '../constants/agro-terms.js';
import { resolveRelativeDate, TOOLS_WITH_DATE_PARAM, dateKeyForTool } from '../utils/relative-dates.js';
import { extractCropFromText } from '../utils/crops.js';
import { normalizarMonto } from '../utils/parser.js';
import type { AgentResult } from './agent.service.js';
import { validateToolCall, type ValidationOptions } from './agent-output-validator.js';
import { buildFallbackMessage } from '../utils/fuzzy-suggest.js';

/**
 * When the user's expense text is just a crop name with no category keyword,
 * Haiku tends to invent a category (e.g. "girasol" → "Agroquímicos"). This
 * guard detects that case so we can drop the agent's category and let the
 * handler ask the user via the picker.
 *
 * Returns true when:
 *   - originalText mentions a known crop (girasol, soja, maíz, etc.), AND
 *   - originalText does NOT mention any category keyword (gasoil, sueldos,
 *     fertilizantes, etc. — anything in EXPENSE_KEYWORD_MAP), AND
 *   - originalText does NOT mention any of the canonical expense categories
 *     directly (Sueldos, Combustible, Agroquímicos, etc.).
 *
 * Trigger example: "gasté 1 peso en girasol" → true (only crop, no category)
 * Non-trigger:     "gasté 80 mil de semilla de girasol" → false (semilla → Semillas)
 * Non-trigger:     "gasté 1 peso en sueldos" → false (sueldos is a category)
 */
function userMentionedCropButNoCategory(originalText: string | null | undefined): boolean {
  if (!originalText) return false;
  const norm = originalText.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Does the text contain a known crop name?
  const tokens = norm.split(/[\s,.!?;:]+/).filter(Boolean);
  const hasCrop = tokens.some(t => extractCropFromText(t) !== null);
  if (!hasCrop) return false;
  // Does the text contain ANY expense category keyword? If yes, the agent's
  // category is probably right — don't drop it.
  for (const kw of Object.keys(EXPENSE_KEYWORD_MAP)) {
    const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(norm)) return false;
  }
  // Does the text contain any canonical category name directly?
  for (const cat of EXPENSE_CATEGORIES) {
    const re = new RegExp(`\\b${cat.toLowerCase()}\\b`, 'i');
    if (re.test(norm)) return false;
  }
  return true;
}

/**
 * Parse Argentine-format weight to kg.
 *   "31.320"   → 31320   (dot = thousands, 3-digit group)
 *   "31.320,5" → 31320.5 (dot = thousands, comma = decimal)
 *   "31320"    → 31320
 *   "30,5"     → 30.5
 *   "28.4"     → 28.4    (2-digit after dot: treat as decimal)
 */
/**
 * Normalize crop names that may come in English or with informal variants.
 * Idempotent: passes Spanish names through unchanged.
 */
const CROP_SYNONYMS: Record<string, string> = {
  soybean: 'soja', soybeans: 'soja', soy: 'soja', soya: 'soja',
  corn: 'maíz', maize: 'maíz', maiz: 'maíz', choclo: 'maíz', maicito: 'maíz',
  wheat: 'trigo',
  sunflower: 'girasol',
  sorghum: 'sorgo',
  barley: 'cebada',
  oat: 'avena', oats: 'avena',
  cotton: 'algodón', algodon: 'algodón',
  rye: 'centeno',
};
/**
 * Reject placeholder strings the agent sometimes emits when it doesn't know a
 * value (despite the prompt forbidding them). Treats them as if the param were
 * absent so the handler triggers its pending-action flow instead of saving
 * literal garbage like a category called "NEWCATEGORY".
 */
const PLACEHOLDER_TOKENS = new Set([
  'newcategory', 'new_category', 'new category', 'new',
  '<unknown>', 'unknown', 'desconocido', 'desconocida',
  '?', '??', '???',
  'cultivo', 'crop', 'producto', 'product',
  'categoria', 'categoría', 'category',
  'ninguna', 'ninguno', 'none', 'null', 'undefined',
  'sin definir', 'sin especificar', 'placeholder',
]);
export function isPlaceholderCategory(input: unknown): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return true;
  return PLACEHOLDER_TOKENS.has(trimmed);
}

/**
 * Safety net for the harvest-goes-chatty case: when the agent returns no tool
 * but the message is clearly a past-tense cosecha WITH a yield, synthesize a
 * harvest_crop command. Conservative: skips questions, requires a cosecha verb +
 * a yield number. Crop/plot are optional (the handler resolves the active crop /
 * single plot). Returns null when it's not unambiguously a harvest.
 */
export function synthesizeHarvestFromText(text: string): ParseResult | null {
  if (!text || !text.trim()) return null;
  if (/\?\s*$/.test(text.trim())) return null; // a question, not a registration
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!/\b(coseche|cosechamos|cosecho|cosechaste|trille|trillamos|levante\s+la\s+cosecha|saque\s+\d)\b/.test(t)) return null;
  // Yield: "40 qq/ha", "200 tn", "5000 kg", or "rindio 42 qq"
  const m = t.match(/(\d[\d.,]*)\s*(tn|toneladas?|qq|quintales?|kg|kilos?)\b/) || t.match(/rind\w*\s+(?:de\s+)?(\d[\d.,]*)\s*(tn|qq|kg)?/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  if (!num || num <= 0) return null;
  const unit = (m[2] || 'kg').toLowerCase();
  const toKg = unit.startsWith('tn') || unit.startsWith('tonel') ? num * 1000
    : unit.startsWith('qq') || unit.startsWith('quint') ? num * 100
    : num;
  const perHa = /\/\s*ha\b|por\s+hect[aá]rea|qq\/ha|kg\/ha|tn\/ha/.test(t);
  const crop = extractCropFromText(text);
  const plotM = text.match(/\b(?:en|del?)\s+(?:el\s+|los\s+|la\s+)?(?:lote|potrero|parcela)\s+([^\s,.;]+(?:\s+[^\s,.;]+){0,2})/i);
  const cmd: ParsedCommand = { command: 'harvest_crop' };
  if (crop) cmd.crop = crop as string;
  if (plotM) cmd.plotName = plotM[1].trim();
  if (perHa) (cmd as Record<string, unknown>).yieldKgPerHa = Math.round(toKg);
  else (cmd as Record<string, unknown>).yieldKg = Math.round(toKg);
  return { intent: { type: 'command', data: cmd }, confidence: 0.6, aiUsed: true, source: 'ai', missingFields: [] };
}

export function normalizeCropName(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const lower = input.trim().toLowerCase();
  return CROP_SYNONYMS[lower] || input;
}

function parseArNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes(',')) {
    const cleaned = s.replace(/\./g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const dotGroups = s.split('.');
  if (dotGroups.length > 1 && dotGroups.slice(1).every(g => g.length === 3 && /^\d+$/.test(g))) {
    const n = Number(s.replace(/\./g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Regex fallback: extract harvest loads from raw user message when the agent
 * misses them. Handles single-line formats like
 *   "Cosecha del lote X Britos 31.320 Contreras 31.487 ..."
 * Only runs when the text contains a cosecha/carga keyword. Captures (surname, weight)
 * pairs — multi-word drivers or explicit destinatarios should be handled by the
 * agent itself (this is the last-resort net for single-word surname lists).
 */
export function extractHarvestLoadsFromText(text: string): Array<{ driver_name: string; weight_kg: number }> {
  if (!text) return [];
  if (!/(cosech|cargar|se\s+carg|carga[sr])/i.test(text)) return [];

  const pairRegex = /([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\s+((?:\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?))\s*(kg|tn|toneladas?|qq|quintales?)?/g;
  const loads: Array<{ driver_name: string; weight_kg: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(text)) !== null) {
    const name = match[1];
    if (/^(Cosecha|Lote|Campo|Soja|Ma[íi]z|Trigo|Girasol|Sorgo|Cebada|Campa[ñn]a|Don|Cargill|Acopio|Silo|Rinde|Rindieron)$/i.test(name)) continue;
    const weight = parseArNumber(match[2]);
    if (weight == null || weight <= 0) continue;
    const unit = (match[3] || '').toLowerCase();
    let weightKg = weight;
    if (unit.startsWith('t')) weightKg = weight * 1000;
    else if (unit.startsWith('q')) weightKg = weight * 100;
    else if (!unit && weight < 1000) weightKg = weight * 1000; // bare small number → assume tn
    loads.push({ driver_name: name, weight_kg: weightKg });
  }
  return loads;
}

/**
 * Convert (quantity, unit) to kg for grain/seed/fertilizer flow.
 * Argentine commercial: tn=1000, qq=100, kg=1. Returns null if can't normalize.
 */
export function normalizeToKg(quantity: number | null | undefined, unit: string | null | undefined): number | null {
  if (quantity == null || !Number.isFinite(Number(quantity))) return null;
  const q = Number(quantity);
  const u = (unit || '').toLowerCase().trim();
  if (u === 'tn' || u.startsWith('tonel')) return q * 1000;
  if (u === 'qq' || u.startsWith('quint')) return q * 100;
  return q;
}

/** Strip accents for comparison */
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Accent-insensitive category match against a known set */
function matchCategory(raw: string, categories: readonly string[]): string | null {
  // Exact match first
  if (new Set(categories).has(raw)) return raw;
  // Accent-insensitive
  const norm = stripAccents(raw).toLowerCase();
  for (const cat of categories) {
    if (stripAccents(cat).toLowerCase() === norm) return cat;
  }
  return null;
}

/** Known product keywords → { category, expense_type } for fallback inference */
const PRODUCT_CATEGORY_KEYWORDS: Record<string, { category: string; expenseType: 'insumo' | 'varios' }> = {
  roundup: { category: 'Agroquímicos', expenseType: 'insumo' },
  glifosato: { category: 'Agroquímicos', expenseType: 'insumo' },
  atrazina: { category: 'Agroquímicos', expenseType: 'insumo' },
  '2,4-d': { category: 'Agroquímicos', expenseType: 'insumo' },
  '24d': { category: 'Agroquímicos', expenseType: 'insumo' },
  herbicida: { category: 'Agroquímicos', expenseType: 'insumo' },
  insecticida: { category: 'Agroquímicos', expenseType: 'insumo' },
  fungicida: { category: 'Agroquímicos', expenseType: 'insumo' },
  cipermetrina: { category: 'Agroquímicos', expenseType: 'insumo' },
  fipronil: { category: 'Agroquímicos', expenseType: 'insumo' },
  urea: { category: 'Fertilizantes', expenseType: 'insumo' },
  dap: { category: 'Fertilizantes', expenseType: 'insumo' },
  map: { category: 'Fertilizantes', expenseType: 'insumo' },
  fosfato: { category: 'Fertilizantes', expenseType: 'insumo' },
  fertilizante: { category: 'Fertilizantes', expenseType: 'insumo' },
  semilla: { category: 'Semillas', expenseType: 'insumo' },
  semillas: { category: 'Semillas', expenseType: 'insumo' },
  gasoil: { category: 'Combustible', expenseType: 'insumo' },
  nafta: { category: 'Combustible', expenseType: 'insumo' },
  diesel: { category: 'Combustible', expenseType: 'insumo' },
  combustible: { category: 'Combustible', expenseType: 'insumo' },
};

/** Infer category/expense_type from product name */
function inferFromProduct(product: string): { category: string; expenseType: 'insumo' | 'varios' } | null {
  const norm = stripAccents(product).toLowerCase();
  for (const [keyword, info] of Object.entries(PRODUCT_CATEGORY_KEYWORDS)) {
    if (norm.includes(keyword)) return info;
  }
  return null;
}

/**
 * Converts AgentResult (tool_use output) → ParseResult[] for backward compatibility
 * with the existing DomainRouter / handlers pipeline.
 */
export class AgentResponseMapper {
  /**
   * Map agent result to ParseResult array.
   * - Each tool call becomes one ParseResult.
   * - If no tool calls and there's conversational text, returns a single 'unknown' ParseResult
   *   with _conversationalResponse attached.
   */
  mapToParseResults(
    result: AgentResult,
    originalText: string,
    validationOptions: ValidationOptions = {},
  ): ParseResult[] {
    if (result.toolCalls.length === 0) {
      // Harvest safety net: the agent sometimes goes chatty on a clear cosecha
      // with a yield ("coseché trigo, 40 qq/ha…") and never fires harvest_crop →
      // silent data loss (LLM variance). If the message is unambiguously a
      // harvest with a yield, synthesize the command instead of just chatting.
      const synthHarvest = synthesizeHarvestFromText(originalText);
      if (synthHarvest) {
        console.warn('[HARVEST_NET] agent went chatty on a harvest — synthesizing harvest_crop for:', originalText.slice(0, 80));
        return [synthHarvest];
      }
      if (result.conversationalText) {
        // Detect "false confirmation" hallucination: agent text claims an
        // action was performed (✅ Registré X, ✅ Anotado, ✅ Guardado,
        // 💰 Gasto registrado) but no tool actually fired → DB is unchanged
        // and the user thinks data was saved. Replace with an honest
        // message that explains the bot didn't process the action and asks
        // them to retry. Real-world example caught: user wrote "llovieron
        // 2mm en vedia", agent answered "✅ Registré 2mm en Vedia" without
        // firing log_rainfall. Subsequent "lluvia esta semana" returned
        // "no hay registros".
        const FALSE_CONFIRM_RE = /✅\s*(?:Registr|Anotad|Guardad|Listo,|Cargad|Sumad|Cosechad|Sembrad)|💰\s*(?:Gasto|Ingreso)\s+registrad|🌱\s*\w+\s+sembrad|🌾\s*\w+\s+cosechad|📥\s*Stock\s+actualizad|📤\s*Stock\s+descontad|🐄\s*Hacienda\s+(?:actualizad|descontad)/i;
        if (FALSE_CONFIRM_RE.test(result.conversationalText)) {
          console.warn(
            'AI_AGENT FALSE_CONFIRMATION: agent claimed success in text without firing a tool — replacing.',
            'msg:', originalText.substring(0, 80),
            '| text excerpt:', result.conversationalText.substring(0, 120),
          );
          return [{
            intent: { type: 'unknown', raw: originalText },
            confidence: 0.50,
            aiUsed: true,
            source: 'ai',
            missingFields: [],
            _conversationalResponse: '🤔 No alcancé a procesar tu pedido. ¿Podés reescribirlo más explícito? Ej: *"llovieron 2 mm en X"*, *"compré 50 lt de glifosato"*.',
          } as ParseResult & { _conversationalResponse: string }];
        }
        return [{
          intent: { type: 'unknown', raw: originalText },
          confidence: 0.90,
          aiUsed: true,
          source: 'ai',
          missingFields: [],
          _conversationalResponse: result.conversationalText,
        } as ParseResult & { _conversationalResponse: string }];
      }
      // Defensive fallback: agent returned NEITHER a tool call NOR text. Don't
      // leave the user with an empty response — emit a polite "didn't get it"
      // so they at least know to rephrase. Surfaced by qa-chaos persona runs
      // on ambiguous follow-ups like "y la cosecha?" / "Perfecto. Confirmó...".
      console.warn('AI_AGENT EMPTY: 0 tools + 0 text — emitting fallback for', originalText.substring(0, 80));
      // Use the fuzzy-suggest helper to upgrade the generic "no entendí"
      // into an actionable message with up to 2 example phrases close to
      // what the user typed (Levenshtein distance ≤ 1-2).
      return [{
        intent: { type: 'unknown', raw: originalText },
        confidence: 0.50,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
        _conversationalResponse: buildFallbackMessage(originalText),
      } as ParseResult & { _conversationalResponse: string }];
    }

    // Filter: if agent returned log_expense alongside an agro activity, drop the expense
    // (Haiku sometimes hallucinates an expense for activity messages like "hoy sembramos soja")
    const AGRO_ACTIVITY_TOOLS = new Set([
      'sow_crop', 'harvest_crop', 'log_spraying', 'log_fertilization',
      'log_tillage', 'log_irrigation', 'log_activity', 'log_tacto',
    ]);
    let filteredCalls = result.toolCalls;
    const hasAgroActivity = filteredCalls.some(tc => AGRO_ACTIVITY_TOOLS.has(tc.toolName));
    if (hasAgroActivity) {
      // Only drop spurious expense/income calls that have NO explicit amount
      // AND no quantity*unit_price the mapper could auto-compute later.
      // Otherwise we'd drop valid compound items like "vendí 20 tn de maíz a 200 USD"
      // (no precomputed amount, but quantity=20 + unit_price=200 → mapper produces 4000).
      // Dropping these silently turns "1 expense + 1 income" into "1 expense", which
      // flips compound bulkMode=false and triggers the single-action plot prompt.
      filteredCalls = filteredCalls.filter(tc => {
        if (tc.toolName !== 'log_expense' && tc.toolName !== 'log_income') return true;
        const input = tc.toolInput as Record<string, unknown>;
        const amount = typeof input.amount === 'number' ? input.amount : 0;
        const qty = typeof input.quantity === 'number' ? input.quantity : 0;
        const unitPrice = typeof input.unit_price === 'number' ? input.unit_price : 0;
        const computable = qty > 0 && unitPrice > 0;
        return amount > 0 || computable; // keep if real amount OR computable from qty*price
      });
      if (filteredCalls.length === 0) filteredCalls = result.toolCalls; // safety: don't drop everything
    }

    return filteredCalls.map(tc => this.mapToolCall(tc, originalText, validationOptions));
  }

  private mapToolCall(
    toolCall: AgentResult['toolCalls'][0],
    originalText: string,
    validationOptions: ValidationOptions = {},
  ): ParseResult {
    const { toolName, toolInput } = toolCall;
    // Validate agent output against the user text. Per-field rules ship behind
    // their own flags in `validationOptions`; when none are enabled this is a
    // passthrough.
    const { input } = validateToolCall(
      { toolName, input: toolInput as Record<string, unknown>, originalText },
      validationOptions,
    );

    // Safety net for relative dates: agent often forgets to set event_date
    // when user says "ayer pagué...", "hace 3 días", "anteayer cargué..." etc.
    // Detect it from the user text and inject the resolved ISO date so the
    // handler doesn't default to CURRENT_DATE. Only fills when:
    //   1. Tool accepts a date param (gastos / actividades / livestock / etc.)
    //   2. Agent did NOT already set it (we never overwrite an explicit date)
    if (TOOLS_WITH_DATE_PARAM.has(toolName)) {
      const dateKey = dateKeyForTool(toolName);
      const inputAsRec = input as Record<string, unknown>;
      // When the user text carries a relative/weekday phrase, OVERRIDE the agent's
      // date with the server-computed one. The agent is unreliable on relative and
      // named-weekday dates (it landed weekdays +1 day, computed against UTC); our
      // resolver is deterministic and AR-local. Absolute dates ("el 3 de junio")
      // aren't matched by resolveRelativeDate → the agent's value is kept.
      const resolved = resolveRelativeDate(originalText);
      if (resolved) inputAsRec[dateKey] = resolved;
    }

    if (toolName === 'log_expense') {
      return this.mapExpense(input, originalText);
    }

    if (toolName === 'log_income') {
      return this.mapIncome(input, originalText);
    }

    // respond_text → conversational response (same as no-tool text)
    if (toolName === 'respond_text') {
      const text = typeof input.text === 'string' ? input.text : '';
      return {
        intent: { type: 'unknown', raw: originalText },
        confidence: 0.90,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
        _conversationalResponse: text,
      } as ParseResult & { _conversationalResponse: string };
    }

    // Everything else → command
    return this.mapCommand(toolName, input, originalText);
  }

  private mapExpense(input: Record<string, unknown>, originalText: string): ParseResult {
    // Auto-compute amount when the agent passes quantity + unit_price instead
    // of a precomputed amount (same defensive pattern as mapIncome).
    let amount = typeof input.amount === 'number' ? input.amount : 0;
    if (
      amount <= 0 &&
      typeof input.quantity === 'number' && input.quantity > 0 &&
      typeof input.unit_price === 'number' && input.unit_price > 0
    ) {
      amount = Math.round(input.quantity * input.unit_price * 100) / 100;
    }

    if (amount > 0) {
      let rawCategory = typeof input.category === 'string' ? input.category.trim() : '';
      let categoryMatch = typeof input.category_match === 'string' ? input.category_match : undefined;
      // Reject agent-emitted placeholders before normalization (see income mapper for rationale).
      if (isPlaceholderCategory(rawCategory)) {
        rawCategory = '';
        categoryMatch = undefined;
      }
      // Reject agent-invented categories when the user only mentioned a crop
      // name. Haiku tends to associate "girasol"/"soja"/"maíz" with farming
      // and pick "Agroquímicos" or similar out of thin air — user 30 hit this
      // on 2026-05-28 ("Gaste 1 peso en girasoles" → category=Agroquímicos).
      // When this guard fires, the category picker takes over and asks the
      // user which category to use, with their own categories as options.
      if (rawCategory && userMentionedCropButNoCategory(originalText)) {
        console.warn(`[AGENT_GUARD] dropped log_expense category="${rawCategory}" — user text was crop-only (no category keyword)`);
        rawCategory = '';
        categoryMatch = undefined;
      }

      // When the agent omits both category and category_match, it means "ask the user" →
      // pass category='' and no category_match so CategoryService shows the picker buttons.
      // When category is provided, try to normalize it against known constants first.
      let category = rawCategory
        ? (matchCategory(rawCategory, EXPENSE_CATEGORIES) ?? rawCategory)
        : '';
      const currency: Currency = input.currency === 'USD' ? 'USD' : 'ARS';
      // Determine expense_type: explicit from agent, or infer from category, or infer from product
      let expenseType: 'insumo' | 'varios' = 'varios';
      if (input.expense_type === 'insumo' || input.expense_type === 'varios') {
        expenseType = input.expense_type;
      } else if (INSUMO_CATEGORIES.has(category)) {
        expenseType = 'insumo';
      }

      // Fallback: infer from product name when category is Otros or expense_type is missing
      const productStr = typeof input.product === 'string' ? input.product : '';
      if (productStr && (category === 'Otros' || expenseType === 'varios')) {
        const inferred = inferFromProduct(productStr);
        if (inferred) {
          if (category === 'Otros') category = inferred.category;
          if (expenseType === 'varios') expenseType = inferred.expenseType;
        }
      }

      // When the agent left category empty (conservative on informal phrasings
      // like "sueldos del lote A1" or "semillas para el lote A2"), recover it
      // from the original text via the keyword map. Avoids triggering the
      // category-picker prompt for words that are clearly a known category.
      if (!category) {
        const haystack = `${productStr} ${originalText}`
          .toLowerCase()
          .normalize('NFD')
          .replace(/[̀-ͯ]/g, '');
        for (const [kw, cat] of Object.entries(EXPENSE_KEYWORD_MAP)) {
          if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack)) {
            category = cat;
            if (INSUMO_CATEGORIES.has(cat) && expenseType === 'varios') expenseType = 'insumo';
            break;
          }
        }
      }

      const data: ParsedExpense & { field?: string; plot?: string; category_match?: string } = {
        type: 'expense',
        amount,
        category,
        description: typeof input.description === 'string' ? input.description : originalText,
        currency,
        expenseType,
      };
      if (categoryMatch) (data as Record<string, unknown>).category_match = categoryMatch;
      if (typeof input.product === 'string') data.product = input.product;
      if (typeof input.quantity === 'number') data.quantity = input.quantity;
      if (typeof input.unit === 'string') data.unit = input.unit;
      if (typeof input.unit_price === 'number') data.unit_price = input.unit_price;
      if (typeof input.field === 'string') data.field = input.field;
      if (typeof input.plot === 'string') data.plot = input.plot;
      if (typeof input.event_date === 'string') data.expenseDate = input.event_date;

      return {
        intent: { type: 'expense', data },
        confidence: 0.95,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial expense — agent omitted amount. Preserve quantity/unit/product/etc.
    // so the flow doesn't make the user repeat them.
    const missingFields: string[] = [];
    if (!input.amount) missingFields.push('amount');
    if (!input.category) missingFields.push('category');

    return {
      intent: {
        type: 'expense_partial',
        data: {
          type: 'expense',
          ...(amount > 0 ? { amount } : {}),
          ...(input.category ? { category: input.category as string } : {}),
          ...(input.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
          ...(typeof input.quantity === 'number' ? { quantity: input.quantity } : {}),
          ...(typeof input.unit === 'string' ? { unit: input.unit } : {}),
          ...(typeof input.unit_price === 'number' ? { unit_price: input.unit_price } : {}),
          ...(typeof input.product === 'string' ? { product: input.product } : {}),
          ...(typeof input.expense_type === 'string' ? { expense_type: input.expense_type } : {}),
          ...(typeof input.field === 'string' ? { field: input.field } : {}),
          ...(typeof input.plot === 'string' ? { plot: input.plot } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
        },
      },
      confidence: 0.60,
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapIncome(input: Record<string, unknown>, originalText: string): ParseResult {
    // Auto-compute amount when the agent passes quantity + unit_price instead of
    // a precomputed amount. "vendí 25 tn de maíz a 900 USD" → quantity=25,
    // unit_price=900, amount = 25 × 900 = 22500. Without this fallback the
    // handler treats it as income_partial and asks "¿Cuánto cobraste?" — the
    // exact loop the Martin QA report surfaced.
    let amount = typeof input.amount === 'number' ? input.amount : 0;
    if (
      amount <= 0 &&
      typeof input.quantity === 'number' && input.quantity > 0 &&
      typeof input.unit_price === 'number' && input.unit_price > 0
    ) {
      amount = Math.round(input.quantity * input.unit_price * 100) / 100;
    }

    if (amount > 0) {
      let rawCategory = typeof input.category === 'string' ? input.category.trim() : '';
      let categoryMatch = typeof input.category_match === 'string' ? input.category_match : undefined;
      // Reject agent-emitted placeholder strings ("NEWCATEGORY", "new", etc.).
      // If the agent didn't actually know the category, we want the system to
      // ask the user via CategoryService — not save a literal "NEWCATEGORY".
      if (isPlaceholderCategory(rawCategory)) {
        rawCategory = '';
        categoryMatch = undefined;
      }
      // When agent omits category → '' → CategoryService will show picker buttons.
      // When category is provided, normalize against known constants; keep original if not found.
      let category = rawCategory
        ? (matchCategory(rawCategory, INCOME_CATEGORIES) ?? rawCategory)
        : '';
      // Crop-derived fallback: if the resolved category isn't a known income
      // category (Soja/Maíz/Trigo/etc.) BUT the description / rawCategory
      // contains a crop keyword, use the crop name as the income category.
      // Fixes the trigo→"Otros" gap when the agent passes things like
      // "venta_granos" / "venta trigo" / generic descriptions.
      const cropKeywords: Record<string, string> = {
        soja: 'Soja', soya: 'Soja',
        maiz: 'Maíz', maíz: 'Maíz',
        trigo: 'Trigo',
        girasol: 'Girasol',
        sorgo: 'Sorgo',
        cebada: 'Cebada',
      };
      if (!INCOME_CATEGORIES.includes(category as IncomeCategory)) {
        const description = typeof input.description === 'string' ? input.description : '';
        const haystack = `${rawCategory} ${description} ${originalText}`.toLowerCase();
        for (const [kw, cropCat] of Object.entries(cropKeywords)) {
          if (new RegExp(`\\b${kw}\\b`, 'i').test(haystack)) {
            category = cropCat;
            break;
          }
        }
      }
      const currency: Currency = input.currency === 'USD' ? 'USD' : 'ARS';
      const data: ParsedIncome & { field?: string; plot?: string; category_match?: string } = {
        type: 'income',
        amount,
        category,
        description: typeof input.description === 'string' ? input.description : originalText,
        currency,
        quantity: typeof input.quantity === 'number' ? input.quantity : null,
        unit: typeof input.unit === 'string' ? input.unit : null,
        unit_price: typeof input.unit_price === 'number' ? input.unit_price : null,
      };
      if (categoryMatch) (data as Record<string, unknown>).category_match = categoryMatch;
      if (typeof input.field === 'string') data.field = input.field;
      if (typeof input.plot === 'string') data.plot = input.plot;
      if (typeof input.event_date === 'string') data.incomeDate = input.event_date;

      return {
        intent: { type: 'income', data },
        confidence: 0.95,
        aiUsed: true,
        source: 'ai',
        missingFields: [],
      };
    }

    // Partial income — agent omitted amount (most common: "vendí 2 tn de maní"
    // without a price). Keep quantity/unit/category/etc. so the flow doesn't
    // make the user repeat them.
    const missingFields: string[] = [];
    if (!input.amount) missingFields.push('amount');
    if (!input.category) missingFields.push('category');

    return {
      intent: {
        type: 'income_partial',
        data: {
          type: 'income',
          ...(amount > 0 ? { amount } : {}),
          ...(input.category ? { category: input.category as string } : {}),
          ...(input.currency === 'USD' ? { currency: 'USD' as Currency } : { currency: 'ARS' as Currency }),
          ...(typeof input.quantity === 'number' ? { quantity: input.quantity } : {}),
          ...(typeof input.unit === 'string' ? { unit: input.unit } : {}),
          ...(typeof input.unit_price === 'number' ? { unit_price: input.unit_price } : {}),
          ...(typeof input.field === 'string' ? { field: input.field } : {}),
          ...(typeof input.plot === 'string' ? { plot: input.plot } : {}),
          ...(typeof input.description === 'string' ? { description: input.description } : {}),
        },
      },
      confidence: 0.60,
      aiUsed: true,
      source: 'ai',
      missingFields,
    };
  }

  private mapCommand(toolName: string, input: Record<string, unknown>, originalText = ''): ParseResult {
    // Rename override: "el lote X se llama Y" / "...pasa a llamarse Y" is a
    // RENAME, but Haiku maps it to add_plot (creating a duplicate lote). Catch
    // the phrasing server-side and rewrite to rename_plot before mapping.
    if ((toolName === 'add_plot' || toolName === 'add_field' || toolName === 'add_plots_batch') && originalText) {
      const rn = originalText.match(/(?:^|\b)(?:el\s+)?lote\s+(.+?)\s+(?:ahora\s+)?(?:se\s+llama|pasa\s+a\s+llamarse)\s+(.+?)\s*$/i);
      if (rn) {
        const oldName = rn[1].trim();
        const newName = rn[2].trim().replace(/^lote\s+/i, '');
        if (oldName && newName && oldName.toLowerCase() !== newName.toLowerCase()) {
          return {
            intent: { type: 'command', data: { command: 'rename_plot', oldName, newName, fieldName: null } },
            confidence: 0.95, aiUsed: true, source: 'ai', missingFields: [],
          } as ParseResult;
        }
      }
    }

    const cmd: ParsedCommand = { command: toolName };

    // Reject obviously-not-a-plot/field tokens that the agent sometimes
    // extracts from filler words ("porfa", "x si acaso", "che", etc.).
    // Without this, the handler returns "No encontré el lote *porfa*" and
    // the user has to repeat themselves. Only filters single-word tokens
    // ≤4 chars that are common discourse markers — proper plot names like
    // "X1" or "AB" are kept (single letter + digit).
    const FILLER_TOKENS = new Set([
      'x', 'che', 'eh', 'ah', 'si', 'sí', 'no', 'va', 'va.', 'porfa', 'pls',
      'plis', 'porfis', 'dale', 'ok', 'okey', 'okay', 'tmb', 'pq', 'q',
      'gracias', 'graciax', 'graxias', 'thanks', 'lo', 'la', 'lo', 'me', 'te',
      'mira', 'mire', 'fijate', 'acaso',
    ]);
    const isFiller = (s: unknown): boolean => {
      if (typeof s !== 'string') return false;
      const norm = s.trim().toLowerCase();
      if (norm.length === 0) return true;
      // Keep alphanumerics with at least one digit (real plot codes like "1A", "X1")
      if (/\d/.test(norm)) return false;
      return norm.length <= 4 && FILLER_TOKENS.has(norm);
    };

    // Map field/plot names (tool schema uses 'field'/'plot', handlers expect 'fieldName'/'plotName')
    if (input.field != null && !isFiller(input.field)) cmd.fieldName = input.field;
    if (input.fieldName != null && !isFiller(input.fieldName)) cmd.fieldName = input.fieldName;
    if (input.plot != null && !isFiller(input.plot)) cmd.plotName = input.plot;
    if (input.plotName != null && !isFiller(input.plotName)) cmd.plotName = input.plotName;
    if (input.plotNames != null) cmd.plotNames = input.plotNames;
    if (input.city != null) cmd.city = input.city;
    if (input.province != null) cmd.province = input.province;
    if (input.hectares != null) cmd.hectares = input.hectares;
    if (input.oldName != null) cmd.oldName = input.oldName;
    if (input.newName != null) cmd.newName = input.newName;
    if (input.entityKeyword != null) cmd.entityKeyword = input.entityKeyword;

    // Name+city recovery for "(tengo otro) campo en <city> que se llama <name>"
    // — Haiku often drops the name and/or city for this phrasing, so the field
    // is never created and a follow-up "agregá lotes al campo <name>" fails.
    if (toolName === 'add_field' && originalText) {
      if (!cmd.fieldName) {
        const mn = originalText.match(/(?:que\s+)?se\s+llama\s+(?:el\s+|la\s+)?([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9.'\s-]*?)\s*[?.!]*$/i);
        if (mn) cmd.fieldName = mn[1].trim().replace(/^(?:campo|lote)\s+/i, '');
      }
      if (!cmd.city) {
        const mc = originalText.match(/\ben\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'\s-]*?)\s+que\s+se\s+llama\b/i);
        if (mc) cmd.city = mc[1].trim();
      }
    }

    // City recovery net for field creation: Haiku reliably extracts the city
    // for "agregá/doy de alta el campo X en Y" but often DROPS it for "cargá el
    // campo X en Y". When we have a field name, no city, and a single-clause
    // message ending in "...en <lugar>", recover the locality (the handler still
    // validates it via localidadLookup, so a bad guess just becomes a re-ask).
    if (toolName === 'add_field' && !cmd.city && cmd.fieldName && originalText && !/[,]/.test(originalText)) {
      const m = originalText.match(/\ben\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'\s-]*?)\s*[?.!¡¿]*$/);
      if (m) {
        const cand = m[1].trim();
        if (cand.length >= 3 && cand.toLowerCase() !== String(cmd.fieldName).toLowerCase()) {
          cmd.city = cand;
        }
      }
    }

    // Activity fields
    if (input.product != null) cmd.product = input.product;
    if (input.product_type != null) cmd.productType = input.product_type;
    if (input.quantity != null) cmd.quantity = input.quantity;
    if (input.unit != null) cmd.unit = input.unit;
    if (input.crop != null) cmd.crop = normalizeCropName(input.crop);
    if (input.event_date != null) cmd.eventDate = input.event_date;

    // Observation
    if (input.observation != null) cmd.observation = input.observation;

    // Report fields
    if (input.period != null) cmd.period = input.period;
    if (input.date_range != null) cmd.date_range = input.date_range;
    if (input.timeRef != null) cmd.timeRef = input.timeRef;
    if (input.activityFilter != null) cmd.activityFilter = input.activityFilter;
    if (input.isUltimaVez != null) cmd.isUltimaVez = input.isUltimaVez;
    if (input.isBinaryQuestion != null) cmd.isBinaryQuestion = input.isBinaryQuestion;
    if (input.desde != null) cmd.desde = input.desde;
    if (input.hasta != null) cmd.hasta = input.hasta;
    if (input.days != null) cmd.days = input.days;
    if (input.category != null) cmd.category = input.category;
    if (input.type != null) cmd.reportType = input.type;
    if (input.report_type != null) cmd.reportType = input.report_type;
    if (input.include_activities != null) cmd.include_activities = input.include_activities;
    if (input.activity_filter != null) cmd.activity_filter = input.activity_filter;

    // financial_report: extended params (view dispatch, thresholds, multi-turn, etc.)
    // These were silently dropped before, causing every analytical query to fall back to aggregate.
    if (input.view != null) cmd.view = input.view;
    if (input.amount_min != null) cmd.amount_min = input.amount_min;
    if (input.amount_max != null) cmd.amount_max = input.amount_max;
    if (input.currency != null) cmd.currency = input.currency;
    if (input.exclude_categories != null) cmd.exclude_categories = input.exclude_categories;
    if (input.categories != null) cmd.categories = input.categories;
    if (input.description_search != null) cmd.description_search = input.description_search;
    if (input.sort_by != null) cmd.sort_by = input.sort_by;
    if (input.sort_desc != null) cmd.sort_desc = input.sort_desc;
    if (input.top_n != null) cmd.top_n = input.top_n;
    if (input.group_by != null) cmd.group_by = input.group_by;
    if (input.inherit != null) cmd.inherit = input.inherit;
    if (input.compare_desde != null) cmd.compare_desde = input.compare_desde;
    if (input.compare_hasta != null) cmd.compare_hasta = input.compare_hasta;
    if (input.compare_category != null) { cmd.compare_category = input.compare_category; cmd.compareCategory = input.compare_category; }

    // query_scoutings: structured scouting filters + view dispatch (same shape as financial_report)
    if (input.stage_prefix != null) cmd.stagePrefix = input.stage_prefix;
    if (input.pest_species != null) cmd.pestSpeciesQuery = input.pest_species;
    if (input.pest_severity_min != null) cmd.pestSeverityMin = input.pest_severity_min;
    if (input.has_pest != null) cmd.hasPest = input.has_pest;
    if (input.weed_species_any != null) cmd.weedSpeciesAny = input.weed_species_any;
    if (input.weed_min_pct != null) cmd.weedMinPct = input.weed_min_pct;
    if (input.weed_max_pct != null) cmd.weedMaxPct = input.weed_max_pct;
    if (input.has_weeds != null) cmd.hasWeeds = input.has_weeds;
    if (input.emergence_min_pct != null) cmd.emergenceMinPct = input.emergence_min_pct;
    if (input.emergence_max_pct != null) cmd.emergenceMaxPct = input.emergence_max_pct;
    if (input.density_min != null) cmd.densityMin = input.density_min;
    if (input.density_max != null) cmd.densityMax = input.density_max;
    if (input.soil_moisture_min != null) cmd.soilMoistureMin = input.soil_moisture_min;
    if (input.soil_moisture_max != null) cmd.soilMoistureMax = input.soil_moisture_max;
    if (input.aggregate_metric != null) cmd.aggregateMetric = input.aggregate_metric;
    if (input.compare_plot != null) { cmd.compare_plot = input.compare_plot; cmd.comparePlot = input.compare_plot; }
    if (input.compare_field != null) { cmd.compare_field = input.compare_field; cmd.compareField = input.compare_field; }

    // query_harvest_loads: unified harvest filter + view dispatch
    if (input.driver_name != null) cmd.driverName = input.driver_name;
    if (input.destinatario != null) cmd.destinatario = input.destinatario;
    if (input.truck_plate != null) cmd.truckPlate = input.truck_plate;
    if (input.weight_min_kg != null) cmd.weightMinKg = input.weight_min_kg;
    if (input.weight_max_kg != null) cmd.weightMaxKg = input.weight_max_kg;
    if (input.humidity_min_pct != null) cmd.humidityMinPct = input.humidity_min_pct;
    if (input.humidity_max_pct != null) cmd.humidityMaxPct = input.humidity_max_pct;
    if (input.protein_min_pct != null) cmd.proteinMinPct = input.protein_min_pct;
    if (input.protein_max_pct != null) cmd.proteinMaxPct = input.protein_max_pct;
    if (input.oil_min_pct != null) cmd.oilMinPct = input.oil_min_pct;
    if (input.oil_max_pct != null) cmd.oilMaxPct = input.oil_max_pct;
    if (input.gluten_min_pct != null) cmd.glutenMinPct = input.gluten_min_pct;
    if (input.gluten_max_pct != null) cmd.glutenMaxPct = input.gluten_max_pct;
    if (input.event_date != null && toolName === 'query_harvest_loads') cmd.eventDate = input.event_date;
    if (input.compare_crop != null) cmd.compareCrop = input.compare_crop;
    if (input.compare_driver != null) cmd.compareDriver = input.compare_driver;
    if (input.compare_destinatario != null) cmd.compareDestinatario = input.compare_destinatario;

    // check_stock unified filters
    if (input.warehouse != null && toolName === 'check_stock') cmd.warehouseName = input.warehouse;
    if (input.low_stock_only != null) cmd.lowStockOnly = input.low_stock_only;
    if (input.quantity_min != null) cmd.quantityMin = input.quantity_min;
    if (input.quantity_max != null) cmd.quantityMax = input.quantity_max;
    if (input.has_min_stock != null) cmd.hasMinStock = input.has_min_stock;
    if (input.compare_warehouse != null) cmd.compareWarehouse = input.compare_warehouse;
    if (input.compare_product != null) cmd.compareProduct = input.compare_product;

    // list_livestock unified filters
    if (input.in_feedlot != null) cmd.inFeedlot = input.in_feedlot;
    if (input.weight_min_kg != null && toolName === 'list_livestock') cmd.weightMinKg = input.weight_min_kg;
    if (input.weight_max_kg != null && toolName === 'list_livestock') cmd.weightMaxKg = input.weight_max_kg;
    if (input.count_min != null) cmd.countMin = input.count_min;
    if (input.count_max != null) cmd.countMax = input.count_max;
    if (input.compare_corral != null) cmd.compareCorral = input.compare_corral;

    // query_plot_history (activities) unified filters
    if (input.activity_types != null) cmd.activityTypes = input.activity_types;
    if (input.product_search != null && toolName === 'query_plot_history') cmd.productSearch = input.product_search;
    if (input.quantity_min != null && toolName === 'query_plot_history') cmd.quantityMin = input.quantity_min;
    if (input.quantity_max != null && toolName === 'query_plot_history') cmd.quantityMax = input.quantity_max;
    if (input.compare_activity_type != null) cmd.compareActivityType = input.compare_activity_type;

    // rainfall_report unified filters
    if (input.mm_min != null) cmd.mmMin = input.mm_min;
    if (input.mm_max != null) cmd.mmMax = input.mm_max;
    if (input.days != null && toolName === 'rainfall_report') cmd.days = input.days;

    // Rainfall: quantity → mm (handler expects cmd.mm)
    if (toolName === 'log_rainfall' && input.quantity != null) {
      cmd.mm = input.quantity;
    }

    // Stock
    if (input.warehouse != null) cmd.warehouseName = input.warehouse;
    if (input.reason != null) cmd.reason = input.reason;
    if (input.name != null && !cmd.product) cmd.warehouseName = input.name; // create_warehouse: name → warehouseName
    if (input.unit_price_ars != null) cmd.unit_price_ars = input.unit_price_ars;
    if (input.unit_price_usd != null) cmd.unit_price_usd = input.unit_price_usd;

    // Livestock price recovery: "vendí 8 vacas a 900 USD" / "compré 5 toros a
    // 1.2 palos" — Haiku only sets unit_price_* when "cada uno/una" is explicit,
    // so the natural "a $X" silently dropped the linked income/expense. Recover
    // it as the per-head price (matches the explicit "cada una" behaviour).
    if ((toolName === 'add_livestock' || toolName === 'remove_livestock')
        && cmd.unit_price_ars == null && cmd.unit_price_usd == null && originalText) {
      const m = originalText.match(/\ba\s+(?:\$|us\$)?\s*([\d][\d.,]*\s*(?:millones?|millon|palos?|palo|mil|lucas|luca)?)\s*(usd|u\$s|d[oó]lares?|d[oó]lar)?/i);
      if (m) {
        const amt = normalizarMonto(m[1]);
        if (amt && amt > 0) {
          if (m[2]) cmd.unit_price_usd = amt; else cmd.unit_price_ars = amt;
        }
      }
    }

    // Sharing
    if (input.phone != null) cmd.phone = input.phone;
    if (input.code != null) cmd.code = input.code;
    if (input.member != null) { cmd.memberName = input.member; cmd.phone = input.member; }

    // Documents
    if (input.documentId != null) cmd.documentId = input.documentId;
    if (input.expenseId != null) cmd.expenseId = input.expenseId;
    if (input.context != null) cmd.context = input.context;

    // Campaign / harvest yield
    if (input.yield_kg != null) cmd.yieldKg = input.yield_kg;
    if (input.yield_kg_per_ha != null) cmd.yieldKgPerHa = input.yield_kg_per_ha;
    if (input.yield_notes != null) cmd.yieldNotes = input.yield_notes;
    // Harvest yield backfill: the agent often puts the total in quantity+unit
    // ("coseché maíz, 200 tn" → quantity:200, unit:'tn') instead of yield_kg, so
    // the yield was never persisted. Convert quantity→kg into the right field.
    if (toolName === 'harvest_crop' && cmd.yieldKg == null && cmd.yieldKgPerHa == null && input.quantity != null) {
      const u = String(input.unit ?? '').toLowerCase();
      const perHa = /\/\s*ha\b/.test(u) || /por\s*hect/.test(u);
      const kg = normalizeToKg(Number(input.quantity), u.replace(/\s*\/\s*ha\b/, '').trim() || 'kg');
      if (kg != null && kg > 0) {
        if (perHa) cmd.yieldKgPerHa = kg; else cmd.yieldKg = kg;
      }
    }
    if (input.season_year != null) cmd.seasonYear = input.season_year;
    if (input.season_year_1 != null) cmd.seasonYear1 = input.season_year_1;
    if (input.season_year_2 != null) cmd.seasonYear2 = input.season_year_2;

    // Edit activity / expense / income / observation / rainfall
    if (input.new_plot != null) cmd.newPlotName = input.new_plot;
    if (input.new_field != null) cmd.newFieldName = input.new_field;
    if (input.new_crop != null) cmd.newCrop = input.new_crop;
    if (input.new_date != null) cmd.newDate = input.new_date;
    if (input.new_amount != null) cmd.newAmount = input.new_amount;
    if (input.new_category != null) cmd.newCategory = input.new_category;
    if (input.new_text != null) cmd.newText = input.new_text;       // edit_last_observation
    if (input.new_mm != null) cmd.newMm = input.new_mm;             // edit_last_rainfall
    if (input.activity_filter != null && (toolName === 'edit_last_activity' || toolName === 'delete_last_activity')) cmd.activityFilter = input.activity_filter;
    // Target plot of the record being edited/deleted (distinct from new_plot).
    if (input.target_plot != null && (toolName === 'edit_last_activity' || toolName === 'delete_last_activity')) cmd.targetPlotName = input.target_plot;
    if (input.category_filter != null) cmd.categoryFilter = input.category_filter;
    if (input.clear_lot != null) cmd.clearLot = input.clear_lot;
    // Filter fields for delete_specific / edit_specific
    if (input.filter_amount != null) cmd.filterAmount = input.filter_amount;
    if (input.filter_category != null) cmd.filterCategory = input.filter_category;
    if (input.filter_date != null) cmd.filterDate = input.filter_date;

    // Livestock
    if (input.count != null) cmd.count = input.count;
    if (input.breed != null) cmd.breed = input.breed;
    if (input.avg_weight_kg != null) cmd.avg_weight_kg = input.avg_weight_kg;
    if (input.total_weight_kg != null) cmd.total_weight_kg = input.total_weight_kg;
    if (input.unit_price_ars != null) cmd.unit_price_ars = input.unit_price_ars;
    if (input.unit_price_usd != null) cmd.unit_price_usd = input.unit_price_usd;
    if (input.price_per_kg_ars != null) cmd.price_per_kg_ars = input.price_per_kg_ars;
    if (input.price_per_kg_usd != null) cmd.price_per_kg_usd = input.price_per_kg_usd;
    if (input.is_purchase != null) cmd.isPurchase = input.is_purchase;
    if (input.is_sale != null) cmd.isSale = input.is_sale;
    if (input.source_field != null) cmd.sourceField = input.source_field;
    if (input.source_plot != null) cmd.sourcePlot = input.source_plot;
    if (input.source_corral != null) cmd.sourceCorral = input.source_corral;
    if (input.dest_field != null) cmd.destField = input.dest_field;
    if (input.dest_plot != null) cmd.destPlot = input.dest_plot;
    if (input.dest_corral != null) cmd.destCorral = input.dest_corral;
    if (input.dest_category != null) cmd.destCategory = input.dest_category;
    if (input.corral != null) cmd.corralName = input.corral;

    // Grupo (sociedad)
    if (input.grupo != null) cmd.grupo = input.grupo;

    // Feedlot
    if (input.capacity != null) cmd.capacity = input.capacity;
    if (input.name != null && !cmd.fieldName && !cmd.warehouseName) cmd.feedlotName = input.name;

    // Tacto (pregnancy check)
    if (input.total_checked != null) cmd.totalChecked = input.total_checked;
    if (input.pregnant_count != null) cmd.pregnantCount = input.pregnant_count;
    if (input.open_count != null) cmd.openCount = input.open_count;
    if (input.uncertain_count != null) cmd.uncertainCount = input.uncertain_count;
    if (input.veterinarian != null) cmd.implement = input.veterinarian;
    if (input.notes != null) cmd.notes = input.notes;

    // Health events
    if (input.health_type != null) cmd.healthType = input.health_type;
    if (input.disease_or_vaccine != null) cmd.diseaseOrVaccine = input.disease_or_vaccine;
    if (input.animals_affected != null) cmd.animalsAffected = input.animals_affected;
    if (input.dose_quantity != null) cmd.doseQuantity = input.dose_quantity;
    if (input.dose_unit != null) cmd.doseUnit = input.dose_unit;

    // Repro events
    if (input.repro_type != null) cmd.reproType = input.repro_type;
    if (input.sire_info != null) cmd.sireInfo = input.sire_info;
    if (input.method != null) cmd.method = input.method;

    // Weighing
    if (input.animals_weighed != null) cmd.animalsWeighed = input.animals_weighed;

    // Crop scouting query filters
    if (input.min_severity != null) cmd.minSeverity = input.min_severity;
    if (input.desde != null) cmd.desde = input.desde;
    if (input.hasta != null) cmd.hasta = input.hasta;

    // Crop scouting (structured monitoring)
    if (input.stage_code != null) cmd.stageCode = input.stage_code;
    if (input.weed_coverage_pct != null) cmd.weedCoveragePct = input.weed_coverage_pct;
    if (input.weed_species != null) cmd.weedSpecies = input.weed_species;
    if (input.pest_species != null) cmd.pestSpecies = input.pest_species;
    if (input.pest_severity_1_5 != null) cmd.pestSeverity = input.pest_severity_1_5;
    if (input.pest_affected_pct != null) cmd.pestAffectedPct = input.pest_affected_pct;
    if (input.soil_moisture_1_5 != null) cmd.soilMoisture = input.soil_moisture_1_5;
    if (input.emergence_pct != null) cmd.emergencePct = input.emergence_pct;
    if (input.plant_density_m2 != null) cmd.plantDensityM2 = input.plant_density_m2;

    // Harvest loads. Defensive filter: drop loads whose driver_name is an
    // article / filler word ("el", "la", "los", "che", "rindió") — the agent
    // sometimes mis-segments "El 11D rindió 4500 kg/ha" as driver="El",
    // weight=11000. A real driver name is a proper noun (capitalised
    // person's name), not a function word.
    if (input.loads != null) {
      const ARTICLES_FILLERS = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
        'che', 'boludo', 'rindió', 'rinde', 'rendimiento', 'cosecha', 'lote',
        'campo', 'mi', 'tu', 'ese', 'esa']);
      const filtered = (input.loads as Array<{ driver_name?: string }>).filter(l => {
        const name = (l?.driver_name || '').trim().toLowerCase();
        return name.length > 1 && !ARTICLES_FILLERS.has(name);
      });
      if (filtered.length > 0) cmd.loads = filtered;
    }
    if (input.driver_name != null) cmd.driverName = input.driver_name;
    if (input.destinatario != null) cmd.destinatario = input.destinatario;
    if (input.driver_names != null) cmd.driverNames = input.driver_names;
    if (input.only_without_destination != null) cmd.onlyWithoutDestination = input.only_without_destination;

    // Safety net for harvest_crop: if AI missed loads[] but the raw text has a
    // `Nombre Número` list (common when user sends a single-line message), parse
    // them with a regex and inject so the handler persists them.
    if (toolName === 'harvest_crop'
        && (!Array.isArray(cmd.loads) || (cmd.loads as unknown[]).length === 0)
        && originalText) {
      const fallbackLoads = extractHarvestLoadsFromText(originalText);
      if (fallbackLoads.length > 0) {
        cmd.loads = fallbackLoads;
      }
    }

    // Expense templates (recurring)
    if (input.template_id != null) cmd.templateId = input.template_id;
    if (input.recurrence_type != null) cmd.recurrenceType = input.recurrence_type;
    if (input.recurrence_day != null) cmd.recurrenceDay = input.recurrence_day;
    if (toolName.includes('expense_template')) {
      if (input.name != null) cmd.name = input.name;
      if (input.amount != null) cmd.amount = input.amount;
      if (input.currency != null) cmd.currency = input.currency;
      if (input.description != null) cmd.description = input.description;
    }

    return {
      intent: { type: 'command', data: cmd },
      confidence: 0.95,
      aiUsed: true,
      source: 'ai',
      missingFields: [],
    };
  }
}
