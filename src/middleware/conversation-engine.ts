import { ConversationStateRepository } from './conversation-state.repository.js';
import { FlowRegistry } from './flows/flow-registry.js';
import type { ConversationObserver } from './conversation-observer.js';
import type { FlowContext, FlowState, HandlerResponse, InteractiveMessage, UserId } from '../types/index.js';
import type { FlowDefinition, FlowStep, FlowStepValidationSuccess } from './flows/flow.interface.js';

import { getSettingNumber } from '../services/settings.service.js';
import { logError } from '../services/error-logger.js';
import { normalizarMonto, detectarCategoria, detectarCategoriaIngreso } from '../utils/parser.js';
import { resolveRelativeDate } from '../utils/relative-dates.js';
import {
  CORRECTION_PREFIX_RE, CORRECTION_ALT, COPULA_ALT, detectCurrencyTerm, QUANTITY_UNIT_RE,
  MONEY_HINT_RE, hasDeleteVerb, startsWithCorrectionCue, normLex,
} from '../utils/lexicon.js';
import { looksLikeCategoryWord } from '../ai/correction-classifier.js';

// Defaults — overridden by system_settings at runtime
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_STEP_FAILURES = 3;

// Cached settings (refreshed on each startFlow call)
let FLOW_TIMEOUT_MS = DEFAULT_FLOW_TIMEOUT_MS;
let MAX_STEP_FAILURES = DEFAULT_MAX_STEP_FAILURES;

async function refreshFlowSettings(): Promise<void> {
  FLOW_TIMEOUT_MS = (await getSettingNumber('FLOW_TIMEOUT_MS')) ?? DEFAULT_FLOW_TIMEOUT_MS;
  MAX_STEP_FAILURES = (await getSettingNumber('FLOW_MAX_STEP_FAILURES')) ?? DEFAULT_MAX_STEP_FAILURES;
}

// --- Spanish labels for user-facing notifications ---
const FLOW_LABELS: Record<string, string> = {
  expense_flow: 'gasto',
  income_flow: 'ingreso',
  field_flow: 'campo',
  activity_flow: 'actividad',
  rainfall_flow: 'lluvia',
  confirming: 'pendiente',
};

export function getFlowLabel(flowState: string): string {
  return FLOW_LABELS[flowState] ?? 'formulario';
}

export function buildTimeoutMessage(flowState: string): string {
  const label = getFlowLabel(flowState);
  return `⏰ Cerré el ${label} anterior por inactividad. Si querés seguir, escribime de nuevo.`;
}

export function buildHalflifeMessage(flowState: string): string {
  const label = getFlowLabel(flowState);
  return `👋 ¿Seguís ahí? Tu ${label} quedó a medias. Respondé o escribí *cancelar* para salir.`;
}

/**
 * Detect "se llama X, no Y" / "no Y, se llama X" / "se llama X" / "es X, no Y"
 * style corrections to the field name. Returns the new name or null.
 */
export function extractRenameCorrection(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // "Se llama Don Carletti, no Carleti" / "se llama Don Carletti"
  let m = t.match(/^se\s+llama\s+(.+?)(?:\s*,\s*no\s+.+)?$/i);
  if (m) return m[1].trim();
  // "no Carleti, se llama Don Carletti"
  m = t.match(/^no\s+.+?,\s*(?:se\s+llama|es)\s+(.+)$/i);
  if (m) return m[1].trim();
  // "es Don Carletti, no Carleti"
  m = t.match(/^es\s+(.+?)\s*,\s*no\s+.+$/i);
  if (m) return m[1].trim();
  // "el nombre es X" / "el campo se llama X"
  m = t.match(/^(?:el\s+)?(?:campo\s+)?(?:nombre|nombre\s+real)\s+(?:es|correcto\s+es)\s+(.+)$/i);
  if (m) return m[1].trim();
  return null;
}

/**
 * Detect mid-flow amount corrections like "no, eran 20000" / "en realidad 50mil" / "perdón, 30000".
 * Returns the corrected amount or null if not a correction.
 */
/**
 * Herencia de escala en correcciones de monto (QA agentes Ago 2026): tras un
 * gasto de $200.000, "no, eran 350" significa 350 MIL en el habla argentina —
 * tomarlo literal guardaba un monto 1000× menor. Regla: corrección "pelada"
 * (< 1000, sin "mil/palo/pesos") sobre un monto previo grande y redondo en
 * miles → heredar la escala. "350 pesos" explícito NO se toca.
 */
export function inheritAmountScale(corrected: number, previous: number | null | undefined, rawText?: string | null, currency?: string | null): number {
  if (!corrected || corrected >= 1000) return corrected;
  if (!previous || previous < 100_000 || previous % 1000 !== 0) return corrected;
  // La herencia de escala es un modismo de PESOS en miles. Sobre montos USD
  // multiplica por mil un valor correcto ("eran 500 dólares" → USD 500.000,
  // regresión detectada por el barrido de agentes Ago 2026).
  if (currency === 'USD') return corrected;
  if (rawText && /\b(?:pesos?|centavos?|ars|d[oó]lar(?:es)?|usd|u\$s|verdes?)\b/i.test(rawText)) return corrected;
  console.log(`[INTERCEPT] amount-scale inherit: corrección ${corrected} → ${corrected * 1000} (monto previo ${previous})`);
  return corrected * 1000;
}

export function extractAmountCorrection(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  // A correction cue (optionally + copula) OR a bare copula, then the value.
  // Cue/copula lists come from lexicon (add synonyms there). normalizarMonto
  // returns null when there's no number, so this only fires on amount corrections.
  const nt = normLex(t);
  const m = nt.match(
    new RegExp(`^(?:(?:${CORRECTION_ALT})\\b,?\\s+(?:(?:${COPULA_ALT})\\s+)?|(?:${COPULA_ALT})\\s+)(.+)$`, 'i'),
  );
  if (!m) return null;
  if (/(?:^|\s)(?:en\s+)?(?:el\s+|la\s+)?(?:lote|potrero|corral|campo)\b/i.test(m[1])) return null;
  let amount = normalizarMonto(m[1]) ?? 0;
  // m[1] may still carry nested cue words ("perdón, en realidad 15000" → m[1] =
  // "en realidad 15000"), which normalizarMonto chokes on. Fall back to pulling
  // the money token. Without this, a SECOND consecutive correction was misread as
  // a brand-new expense → duplicate row.
  if (!amount || amount <= 0) {
    const stripped = m[1].normalize('NFD').replace(/[̀-ͯ]/g, '');
    const toks = stripped.match(/\d[\d.,]*\s*(?:mil(?:lones?)?|millon\w*|palos?|lucas?|k|m)?/gi) || [];
    for (const tok of toks) { const v = normalizarMonto(tok); if (v && v > amount) amount = v; }
  }
  return amount && amount > 0 ? amount : null;
}

/**
 * Detect an amount correction that ALSO names which expense it refers to:
 * "no, el de urea eran 99 mil" / "el de gasoil eran 70 mil" / "perdón, el gasto
 * de semillas era 30 mil". Returns { categoryFilter, newAmount } so the handler
 * can target the RIGHT row (and say "no encuentro ese gasto" when there's none)
 * instead of silently editing the most-recent expense of a different category.
 *
 * Guarded to genuine expense referents: the captured word must resolve to a
 * known category OR look category-shaped. "el de norte era 50" (a plot/area)
 * → detectarCategoria('norte') is null and it's not category-shaped → returns
 * null, so plot corrections (handled earlier) are never hijacked.
 */
export function extractReferencedAmountCorrection(
  text: string,
): { kind: 'expense' | 'income'; categoryFilter: string; newAmount: number } | null {
  const t = normLex(text).trim();
  if (!t) return null;
  // "[corrección] el [gasto|ingreso|venta] de <referente> <copula> <monto>".
  // Correction-cue + copula lists from lexicon (accent-free on normalized text).
  const m = t.match(
    new RegExp(`^(?:(?:${CORRECTION_ALT}),?\\s*)?el\\s+(gasto|ingreso|venta)?\\s*(?:de\\s+)?([a-zñ][a-zñ\\s\\-]*?)\\s+(?:${COPULA_ALT})\\s+(.+)$`, 'i'),
  );
  if (!m) return null;
  const explicitKind = m[1] ? m[1].toLowerCase() : null; // "gasto" | "ingreso" | "venta"
  const referent = m[2].trim();
  // Strip accents on the amount before normalizarMonto — "1 millón" (accented)
  // otherwise matches the "mil" multiplier → 1000. The main parser pipeline
  // normalizes first; this direct call must too.
  const amountStr = m[3].normalize('NFD').replace(/[̀-ͯ]/g, '');
  // "era en el lote Dos" es corrección de UBICACIÓN, no de monto —
  // normalizarMonto leía el numeral del nombre del lote ("dos" → 2) y
  // corrompía el importe (barrido de agentes Ago 2026).
  if (/(?:^|\s)(?:en\s+)?(?:el\s+|la\s+)?(?:lote|potrero|corral|campo)\b/i.test(amountStr)) return null;
  const newAmount = normalizarMonto(amountStr);
  if (!newAmount || newAmount <= 0) return null;

  // categoryFilter carries the RAW referent ("grasa", "urea", "soja") — the
  // handler matches it against category OR description OR product, so two items
  // in the same category ("grasa" vs "repuestos", both Maquinaria) are still
  // told apart. detectarCategoria* is used ONLY to pick expense vs income.
  if (explicitKind === 'ingreso' || explicitKind === 'venta') {
    return { kind: 'income', categoryFilter: referent, newAmount };
  }
  if (explicitKind === 'gasto') {
    return { kind: 'expense', categoryFilter: referent, newAmount };
  }
  if (detectarCategoria(referent)) return { kind: 'expense', categoryFilter: referent, newAmount };
  if (detectarCategoriaIngreso(referent)) return { kind: 'income', categoryFilter: referent, newAmount };
  if (looksLikeCategoryWord(referent)) return { kind: 'expense', categoryFilter: referent, newAmount };
  return null;
}

/**
 * Detect "el último era de ayer" / "la última fue anteayer" / "no, era de hace 3
 * días" — a relative-date correction of the LAST record. Returns the resolved ISO
 * date or null. Guarded so it never fires on a NEW dated action ("fumigué ayer"):
 * requires an explicit "el/la último/a" reference OR a correction prefix.
 */
export function extractLastRecordDateCorrection(text: string): string | null {
  const nt = normLex(text);
  const hasReldate = /\b(ayer|anteayer|antes\s+de\s+ayer|hace\s+\d+\s+(?:dias?|semanas?|meses?))\b/i.test(nt);
  if (!hasReldate) return null;
  const lastRef = /\b(?:el|la)\s+ultim[oa]\b/i.test(nt);
  const corrDate = new RegExp(`^(?:${CORRECTION_ALT}),?\\s+(?:${COPULA_ALT})\\s+(?:de\\s+)?(?:ayer|anteayer|antes\\s+de\\s+ayer|hace\\s+)`, 'i').test(nt.trim());
  if (!lastRef && !corrDate) return null;
  return resolveRelativeDate(text);
}

/**
 * Detect a currency correction ("no, eran dólares" / "perdón, en pesos" / "eran
 * USD"). Returns 'USD' | 'ARS' | null. Requires a correction/era cue so it
 * doesn't fire on a brand-new "vendí ... dólares" (that's parsed inline).
 */
export function extractCurrencyCorrection(text: string): 'USD' | 'ARS' | null {
  // Require a correction / copula / "en" cue so it doesn't fire on a brand-new
  // sale ("vendí ... dólares" is parsed inline). Currency synonyms (verdes,
  // mangos, …) live in lexicon.detectCurrencyTerm — add new ones THERE.
  const t = normLex(text);
  const cueRe = new RegExp(`\\b(?:${COPULA_ALT}|en)\\b`, 'i');
  if (!startsWithCorrectionCue(text) && !cueRe.test(t)) return null;
  return detectCurrencyTerm(text);
}

/**
 * Detect a DOSE/quantity correction of the last activity: "no, eran 5.5 litros",
 * "la fumigación eran 5 kg", "perdón, fueron 2 litros". Returns { quantity, unit }
 * or null. Guarded to AGRO units (litros/kg/cc/…) and a correction phrasing, and
 * rejects money so it never steals an amount correction. Dose is safety-relevant
 * and the activity correction engine previously ignored it (P1-B).
 */
export function extractActivityQuantityCorrection(
  text: string,
): { quantity: number; unit: string } | null {
  const t = normLex(text);
  // Correction phrasing: a leading correction cue / "la fumigación …" + a copula,
  // or a bare copula before a number. Cue + copula + unit lists come from lexicon.
  const isCorrection = new RegExp(`^(?:(?:${CORRECTION_ALT}),?\\s*|la\\s+[a-zñ]+\\s+)?(?:${COPULA_ALT})\\s+`, 'i').test(t)
    || new RegExp(`\\b(?:${COPULA_ALT})\\s+\\d`, 'i').test(t);
  if (!isCorrection) return null;
  if (MONEY_HINT_RE.test(t)) return null;       // it's an AMOUNT correction, not a dose
  const m = t.match(QUANTITY_UNIT_RE);
  if (!m) return null;
  const quantity = parseFloat(m[1].replace(',', '.'));
  if (!(quantity > 0)) return null;
  return { quantity, unit: m[2].toLowerCase() };
}

/**
 * True when the message is a correction or delete that names a DIFFERENT, already
 * recorded item (not the current pending's slot answer): "no, el alambre fueron
 * 15000", "el último era de ayer", "borrá el gasto de grasa", "eliminá el de
 * gasoil". Used so an open flow / pending confirmation does NOT swallow it as its
 * own slot answer (which silently dropped the correction/delete — P1-B).
 */
export function isOtherItemCorrectionOrDelete(text: string): boolean {
  if (extractReferencedAmountCorrection(text)) return true;
  if (extractLastRecordDateCorrection(text)) return true;
  // Delete naming a referent: "borrá el gasto de grasa", "anulá el de gasoil",
  // "dá de baja el ingreso de soja". Delete verbs come from lexicon.hasDeleteVerb.
  if (hasDeleteVerb(text) && /\b(gasto|ingreso|venta|compra|el\s+de|la\s+de)\b/i.test(normLex(text))) return true;
  return false;
}

/**
 * Detect mid-flow category corrections.
 *
 * Patterns covered:
 *   - "no, es <X>"
 *   - "no, era en <X>" / "no, fue en <X>"   (user-style category correction)
 *   - "no, categoría <X>"
 *   - "cambiar a <X>" / "en realidad categoría <X>"
 *
 * The "no, era en X" pattern is intentionally restricted to candidates that
 * look like CATEGORY words (sueldos, gasoil, semillas, fertilizante, ...)
 * via a shared stoplist in correction-classifier. Without that guard the
 * pattern would gobble up "no, era en lote Norte" — which is a plot
 * correction handled elsewhere. The correction-classifier runs FIRST in
 * the intent pipeline and catches plot corrections; here we accept the
 * leftovers that look like category swaps.
 */
/**
 * Strip a trailing negation suffix the user appends to disambiguate a correction,
 * e.g. "sueldos no gasoil" → "sueldos" ("era en sueldos NO gasoil"). Without this,
 * the leftover old category ("gasoil") gets matched by detectarCategoria and the
 * correction silently saves the very category the user was correcting away from.
 * Safe because no real category contains a standalone " no " token.
 */
function stripTrailingNegation(s: string): string {
  return s.replace(/[\s,]+no\s+\S.*$/i, '').trim();
}

export function extractCategoryCorrection(text: string): string | null {
  // Normalizar acentos para el matching: los cues del lexicon son accent-free
  // ("perdon"), así que "perdón fue en X" no matcheaba. El candidato sin acento
  // está bien — detectarCategoria lo canonicaliza después.
  const t = text.trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!t) return null;
  // "no, es X" / "no, categoría X" / "cambiar a X" / "en realidad categoría X"
  const m1 = t.match(
    /^(?:no,?\s*(?:es|categor[ií]a)|cambiar\s+a|en\s+realidad\s+categor[ií]a)\s+(.+)$/i,
  );
  if (m1) return stripTrailingNegation(m1[1].trim()) || null;

  // "<cue(s)> (era|fue) en X" — acepta CUALQUIER prefijo de corrección del
  // lexicon, encadenado ("no, en realidad era en X", "perdón fue en X",
  // "en realidad era en X"). Antes solo aceptaba un "no," literal, por lo que
  // "no, en realidad era en fertilizante" se ignoraba y persistía la categoría
  // vieja (hallazgo QA Jun 2026 — asimetría con extractAmountCorrection, que ya
  // usaba CORRECTION_ALT). El "era/fue" es opcional ("no, en realidad en X").
  // El guard looksLikeCategoryWord evita comerse correcciones de lote
  // ("no, era en lote Norte"), que ya intercepta el correction-classifier.
  const m2 = t.match(
    new RegExp(`^(?:(?:${CORRECTION_ALT})\\b,?\\s+)+(?:(?:era|fue|fui|fuimos)\\s+)?en\\s+(?:el\\s+|la\\s+)?([\\p{L}][\\p{L}\\s\\-]*?)\\s*[.!?]?\\s*$`, 'iu'),
  );
  if (m2) {
    const candidate = stripTrailingNegation(m2[1].trim());
    if (looksLikeCategoryWord(candidate)) return candidate || null;
  }
  return null;
}

export interface FlowMessageResult {
  response: HandlerResponse;
  nextContext: FlowContext | null; // null = clear flow
}

export class ConversationEngine {
  private observer?: ConversationObserver;

  constructor(
    private stateRepo: ConversationStateRepository,
    private registry: FlowRegistry,
    observer?: ConversationObserver,
  ) {
    this.observer = observer;
  }

  async getFlowContext(userId: UserId): Promise<FlowContext> {
    const ctx = await this.stateRepo.getFlowContext(userId);
    // Flow state recovery: if state isn't idle/confirming and flow not in registry, auto-clear
    if (ctx.state !== 'idle' && ctx.state !== 'confirming' && !this.registry.has(ctx.state)) {
      await this.stateRepo.clearFlow(userId);
      return { state: 'idle', step: 0, data: {}, startedAt: null, expiresAt: null };
    }
    return ctx;
  }

  async setFlowContext(userId: UserId, ctx: FlowContext): Promise<void> {
    await this.stateRepo.setFlowContext(userId, ctx);
  }

  /**
   * Nombre del `field` del paso en el que está parado el flow (null en
   * idle/confirming o fuera de rango). Lo usa el pipeline para scopear los
   * taps de flow al paso que les corresponde: un `flow_plot_*` duplicado que
   * llega con el flow ya en el paso `product` NO debe consumirse como
   * producto (bug de prod Ago 2026: "Producto: norte").
   */
  getCurrentStepField(ctx: FlowContext): string | null {
    if (ctx.state === 'idle' || ctx.state === 'confirming') return null;
    const flow = this.registry.get(ctx.state);
    return flow?.steps[ctx.step]?.field ?? null;
  }

  async clearFlow(userId: UserId): Promise<void> {
    await this.stateRepo.clearFlow(userId);
  }

  isExpired(ctx: FlowContext): boolean {
    if (!ctx.expiresAt) return false;
    return new Date() > new Date(ctx.expiresAt);
  }

  /**
   * FlowGuard: validates flow state consistency.
   * Returns null if valid, or a FlowMessageResult to send if the state is invalid.
   */
  async validateFlowState(userId: UserId, ctx: FlowContext): Promise<FlowMessageResult | null> {
    // Idle state is always valid
    if (ctx.state === 'idle') return null;

    // Confirming state — check originFlow exists
    if (ctx.state === 'confirming') {
      const originFlow = ctx.originFlow;
      if (!originFlow || !this.registry.has(originFlow)) {
        await this.stateRepo.clearFlow(userId);
        return {
          response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
          nextContext: null,
        };
      }
      return null;
    }

    // Active flow — check flow exists and step is in bounds
    const flow = this.registry.get(ctx.state);
    if (!flow) {
      await this.stateRepo.clearFlow(userId);
      return {
        response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    if (ctx.step < 0 || ctx.step >= flow.steps.length) {
      await this.stateRepo.clearFlow(userId);
      return {
        response: { messages: ['Error en el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    return null;
  }

  async startFlow(
    userId: UserId,
    flowState: FlowState,
    prefillData?: Record<string, unknown>,
  ): Promise<FlowMessageResult> {
    // Refresh settings from DB (cached 5 min)
    await refreshFlowSettings();

    const flow = this.registry.get(flowState);
    if (!flow) {
      return {
        response: { messages: ['Flujo no disponible.'] },
        nextContext: null,
      };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + FLOW_TIMEOUT_MS);
    const data = prefillData ?? {};

    // Find the first non-skippable step
    let startStep = 0;
    while (startStep < flow.steps.length) {
      const step = flow.steps[startStep];
      if (step.skipIf && step.skipIf(data)) {
        startStep++;
        continue;
      }
      // If data already has this field from prefill, skip
      if (data[step.field] !== undefined) {
        startStep++;
        continue;
      }
      break;
    }

    // If all steps already filled (e.g., from prefill), go to confirmation
    if (startStep >= flow.steps.length) {
      const ctx: FlowContext = {
        state: 'confirming',
        step: flow.steps.length,
        data,
        startedAt: now,
        expiresAt,
        originFlow: flowState,
      };
      await this.stateRepo.setFlowContext(userId, ctx);
      return {
        response: flow.buildConfirmation(data),
        nextContext: ctx,
      };
    }

    const ctx: FlowContext = {
      state: flowState,
      step: startStep,
      data,
      startedAt: now,
      expiresAt,
      stepFailCount: 0,
    };
    await this.stateRepo.setFlowContext(userId, ctx);

    const stepDef = flow.steps[startStep];
    const prompt = await this.resolvePrompt(stepDef, data, userId);
    const interactive = await this.resolveInteractive(stepDef, data, userId);

    return {
      response: {
        messages: interactive ? [] : [prompt],
        interactive,
      },
      nextContext: ctx,
    };
  }

  async processFlowMessage(
    userId: UserId,
    text: string,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    // If in confirming state, handle text-based confirm/cancel + corrections
    if (ctx.state === 'confirming') {
      const lower = text.toLowerCase().trim();
      if (['si', 'sí', 'confirmar', 'confirmado', 'dale', 'ok', 'listo', 'perfecto', 'va', 'vamos', 'seguro', 'claro', '👍'].includes(lower)) {
        return this.executeConfirm(userId, ctx);
      }

      const corrCurrencyConf = extractCurrencyCorrection(text);

      // Allow amount correction during confirmation ("no, eran 20000")
      if (ctx.data.amount != null) {
        const correctedAmount = extractAmountCorrection(text);
        if (correctedAmount) {
          if (typeof ctx.data.amount === 'object' && (ctx.data.amount as Record<string, unknown>).currency) {
            ctx.data.amount = { amount: correctedAmount, currency: corrCurrencyConf ?? (ctx.data.amount as Record<string, unknown>).currency };
          } else if (corrCurrencyConf) {
            ctx.data.amount = { amount: correctedAmount, currency: corrCurrencyConf };
          } else {
            ctx.data.amount = correctedAmount;
          }
          // Re-show confirmation with updated data
          const originFlow = ctx.originFlow ?? ctx.state;
          const flow = this.registry.get(originFlow as FlowState);
          if (flow) {
            await this.stateRepo.setFlowContext(userId, ctx);
            const fmtAmount = correctedAmount.toLocaleString('es-AR');
            const confirmation = flow.buildConfirmation(ctx.data);
            return {
              response: {
                messages: [`✏️ Monto actualizado a *$${fmtAmount}*.`, ...confirmation.messages],
                interactive: confirmation.interactive,
              },
              nextContext: ctx,
            };
          }
        }
      }

      // Allow category correction during confirmation
      if (typeof ctx.data.category === 'string') {
        const correctedCat = extractCategoryCorrection(text);
        if (correctedCat) {
          ctx.data.category = correctedCat;
          const originFlow = ctx.originFlow ?? ctx.state;
          const flow = this.registry.get(originFlow as FlowState);
          if (flow) {
            await this.stateRepo.setFlowContext(userId, ctx);
            const confirmation = flow.buildConfirmation(ctx.data);
            return {
              response: {
                messages: [`✏️ Categoría actualizada a *${correctedCat}*.`, ...confirmation.messages],
                interactive: confirmation.interactive,
              },
              nextContext: ctx,
            };
          }
        }
      }

      // Currency-only correction during confirmation ("no, eran dólares")
      if (corrCurrencyConf && ctx.data.amount != null) {
        const amtVal = typeof ctx.data.amount === 'object'
          ? (ctx.data.amount as Record<string, unknown>).amount
          : ctx.data.amount;
        ctx.data.amount = { amount: amtVal, currency: corrCurrencyConf };
        const originFlow = ctx.originFlow ?? ctx.state;
        const flow = this.registry.get(originFlow as FlowState);
        if (flow) {
          await this.stateRepo.setFlowContext(userId, ctx);
          const confirmation = flow.buildConfirmation(ctx.data);
          return {
            response: {
              messages: [`✏️ Moneda actualizada a *${corrCurrencyConf}*.`, ...confirmation.messages],
              interactive: confirmation.interactive,
            },
            nextContext: ctx,
          };
        }
      }

      // Any other text in confirming state — treat as cancel
      return {
        response: { messages: ['Respondé *SI* para confirmar o *NO* para cancelar.'] },
        nextContext: ctx,
      };
    }

    const flowState = ctx.state as FlowState;
    const flow = this.registry.get(flowState);
    if (!flow) {
      return {
        response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    const stepDef = flow.steps[ctx.step];
    if (!stepDef) {
      return {
        response: { messages: ['Error en el flujo. ¿Qué querés hacer?'] },
        nextContext: null,
      };
    }

    // Field-location shortcut: at the "¿cómo querés ubicar el campo?" step, a user
    // who TYPES a locality (instead of tapping "Escribir localidad") should go
    // straight to city validation — not get bounced with "elegí una opción".
    if (stepDef.field === 'locationMethod') {
      const t = text.trim().toLowerCase();
      const isMethodOrControl = /^flow_field_loc_|^(localidad|ciudad|escribir|mapa|dibujar|compartir|gps|cancelar|volver|atr[aá]s|no)\b|ubicaci[oó]n/i.test(t);
      const looksLikeLocality = !isMethodOrControl && /[a-záéíóúñ]/i.test(t) && t.length >= 2 && t.length <= 40;
      if (looksLikeLocality) {
        const cityIdx = flow.steps.findIndex(s => s.field === 'city');
        if (cityIdx >= 0) {
          ctx.data.locationMethod = 'city';
          ctx.step = cityIdx;
          return this.processFlowMessage(userId, text, ctx);
        }
      }
    }

    // Mid-flow rename: if the user corrects the name ("se llama X, no Y" /
    // "no se llama Y, es X") and we already have a `name` in flow data, update
    // it and re-prompt the current step so the user doesn't have to cancel +
    // restart the flow.
    if (stepDef.field !== 'name' && typeof ctx.data?.name === 'string') {
      const renamed = extractRenameCorrection(text);
      if (renamed && renamed.toLowerCase() !== (ctx.data.name as string).toLowerCase()) {
        ctx.data.name = renamed;
        const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
        const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
        return {
          response: {
            messages: interactive
              ? [`✏️ Renombrado a *${renamed}*. Seguimos.`]
              : [`✏️ Renombrado a *${renamed}*.\n\n${prompt}`],
            interactive,
          },
          nextContext: ctx,
        };
      }
    }

    // Mid-flow currency correction: "no, eran dólares" while answering another
    // step (e.g. the plot question) — patch currency, keep the amount, re-prompt.
    if (ctx.data.amount != null) {
      const corrCur = extractCurrencyCorrection(text);
      // Only when it's NOT also an amount correction (that path handles currency too).
      if (corrCur && extractAmountCorrection(text) == null) {
        const amtVal = typeof ctx.data.amount === 'object'
          ? (ctx.data.amount as Record<string, unknown>).amount
          : ctx.data.amount;
        ctx.data.amount = { amount: amtVal, currency: corrCur };
        const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
        const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
        return {
          response: {
            messages: interactive ? [`✏️ Moneda actualizada a *${corrCur}*. Seguimos.`] : [`✏️ Moneda actualizada a *${corrCur}*.\n\n${prompt}`],
            interactive,
          },
          nextContext: ctx,
        };
      }
    }

    // Mid-flow amount correction: "no, eran 20000" updates amount without restarting
    if (stepDef.field !== 'amount' && ctx.data.amount != null) {
      const correctedAmount = extractAmountCorrection(text);
      const corrCurWithAmt = extractCurrencyCorrection(text);
      if (correctedAmount) {
        // Preserve currency if amount is an object (expense flow), otherwise store plain number
        if (typeof ctx.data.amount === 'object' && (ctx.data.amount as Record<string, unknown>).currency) {
          ctx.data.amount = { amount: correctedAmount, currency: corrCurWithAmt ?? (ctx.data.amount as Record<string, unknown>).currency };
        } else if (corrCurWithAmt) {
          ctx.data.amount = { amount: correctedAmount, currency: corrCurWithAmt };
        } else {
          ctx.data.amount = correctedAmount;
        }
        const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
        const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
        const fmtAmount = correctedAmount.toLocaleString('es-AR');
        return {
          response: {
            messages: interactive
              ? [`✏️ Monto actualizado a *$${fmtAmount}*. Seguimos.`]
              : [`✏️ Monto actualizado a *$${fmtAmount}*.\n\n${prompt}`],
            interactive,
          },
          nextContext: ctx,
        };
      }
    }

    // Mid-flow category correction: "no, es gasoil" updates category without restarting
    if (stepDef.field !== 'category' && typeof ctx.data.category === 'string') {
      const correctedCat = extractCategoryCorrection(text);
      if (correctedCat) {
        ctx.data.category = correctedCat;
        const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
        const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
        return {
          response: {
            messages: interactive
              ? [`✏️ Categoría actualizada a *${correctedCat}*. Seguimos.`]
              : [`✏️ Categoría actualizada a *${correctedCat}*.\n\n${prompt}`],
            interactive,
          },
          nextContext: ctx,
        };
      }
    }

    // Validate input: prefer async, fallback to sync
    const result = stepDef.validateAsync
      ? await stepDef.validateAsync(text, ctx.data, userId)
      : stepDef.validate(text, ctx.data);

    if ('error' in result) {
      // Increment step failure count
      ctx.stepFailCount = (ctx.stepFailCount ?? 0) + 1;
      this.observer?.logFlowStep(userId, ctx.state, ctx.step, { field: stepDef.field, validationFailed: true });

      const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
      const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);

      // After MAX_STEP_FAILURES, add hint
      let errorMsg = result.error;
      if (ctx.stepFailCount >= MAX_STEP_FAILURES) {
        errorMsg += '\n\n_Escribí *cancelar* para salir o elegí de la lista._';
      }

      // Merge error + re-prompt into single message (suppress prompt when interactive provides it)
      return {
        response: {
          messages: interactive ? [errorMsg] : [`${errorMsg}\n\n${prompt}`],
          interactive,
        },
        nextContext: ctx,
      };
    }

    // Store validated value, reset fail count
    ctx.data[stepDef.field] = (result as FlowStepValidationSuccess).value;
    ctx.stepFailCount = 0;

    // Advance to next step
    return this.advanceToNextStep(userId, flow.id, ctx, flow);
  }

  async skipStep(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    const flowState = ctx.state as FlowState;
    const flow = this.registry.get(flowState);
    if (!flow) {
      return { response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] }, nextContext: null };
    }

    const stepDef = flow.steps[ctx.step];
    if (!stepDef?.optional) {
      const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
      const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
      return {
        response: {
          messages: interactive ? ['Este paso es obligatorio.'] : [`Este paso es obligatorio.\n\n${prompt}`],
          interactive,
        },
        nextContext: ctx,
      };
    }

    return this.advanceToNextStep(userId, flow.id, ctx, flow);
  }

  async goBack(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    const flowState = ctx.state === 'confirming' ? (ctx.originFlow ?? ctx.state) : ctx.state;
    const flow = this.registry.get(flowState as FlowState);
    if (!flow || ctx.step <= 0) {
      return { response: { messages: ['No podés volver más atrás.'] }, nextContext: ctx };
    }

    let prevStep = (ctx.state === 'confirming' ? flow.steps.length : ctx.step) - 1;
    while (prevStep >= 0) {
      const step = flow.steps[prevStep];
      if (step.skipIf && step.skipIf(ctx.data)) {
        prevStep--;
        continue;
      }
      break;
    }

    if (prevStep < 0) {
      return { response: { messages: ['No podés volver más atrás.'] }, nextContext: ctx };
    }

    // Remove current field data
    const stepDef = flow.steps[prevStep];
    delete ctx.data[stepDef.field];

    ctx.state = flowState as FlowState;
    ctx.step = prevStep;
    ctx.stepFailCount = 0;
    await this.stateRepo.setFlowContext(userId, ctx);

    const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);

    return {
      response: { messages: interactive ? [] : [prompt], interactive },
      nextContext: ctx,
    };
  }

  async executeConfirm(
    userId: UserId,
    ctx: FlowContext,
  ): Promise<FlowMessageResult> {
    // Guard: stale/idle state (e.g. double-tap on confirm button)
    if (ctx.state === 'idle') {
      return { response: { messages: ['No hay nada pendiente para confirmar.'] }, nextContext: null };
    }

    const flowState = ctx.originFlow ?? ctx.state;
    const flow = this.registry.get(flowState as FlowState);
    if (!flow) {
      await this.stateRepo.clearFlow(userId);
      return { response: { messages: ['Hubo un problema con el flujo. ¿Qué querés hacer?'] }, nextContext: null };
    }

    // Validate required data: every non-optional, non-skipped step must have a value
    for (const step of flow.steps) {
      if (step.skipIf && step.skipIf(ctx.data)) continue;
      if (!step.optional && ctx.data[step.field] === undefined) {
        await this.stateRepo.clearFlow(userId);
        console.error(`[FLOW_CONFIRM] Missing required field "${step.field}" in ${flowState} for user ${userId}`);
        logError('flow-engine', 'MISSING_FIELD', `Missing required field "${step.field}" in ${flowState}`, { userId, context: { flowState, field: step.field } });
        return { response: { messages: ['Faltan datos en el flujo. Empezá de nuevo.'] }, nextContext: null };
      }
    }

    try {
      const response = await flow.execute(userId, ctx.data);
      await this.stateRepo.clearFlow(userId);
      const durationMs = ctx.startedAt ? Date.now() - new Date(ctx.startedAt).getTime() : undefined;
      this.observer?.logFlowCompleted(userId, flowState as string, ctx.step, { durationMs, dataKeys: Object.keys(ctx.data) });
      return { response, nextContext: null };
    } catch (err: unknown) {
      await this.stateRepo.clearFlow(userId);
      const msg = (err as Error).message;
      console.error(`[FLOW_CONFIRM] execute() failed for ${flowState}, user ${userId}:`, msg);
      logError('flow-engine', 'FLOW_EXECUTE_FAILED', err as Error, { userId, context: { flowState } });
      return { response: { messages: ['Hubo un error al guardar. Intentá de nuevo.'] }, nextContext: null };
    }
  }

  async startFlowAtConfirmation(
    userId: UserId,
    flowState: FlowState,
    data: Record<string, unknown>,
  ): Promise<HandlerResponse> {
    const flow = this.registry.get(flowState);
    if (!flow) return { messages: ['Flujo no disponible.'] };

    const now = new Date();
    const expiresAt = new Date(now.getTime() + FLOW_TIMEOUT_MS);
    const ctx: FlowContext = {
      state: 'confirming',
      step: flow.steps.length,
      data,
      startedAt: now,
      expiresAt,
      originFlow: flowState,
    };
    await this.stateRepo.setFlowContext(userId, ctx);
    return flow.buildConfirmation(data);
  }

  /**
   * Get the current step's prompt response (for re-prompting after safe interruptions).
   */
  /** The `field` name of the step the flow is currently awaiting (or null). */
  getCurrentStepField(ctx: FlowContext): string | null {
    if (!ctx || ctx.state === 'idle' || ctx.state === 'confirming') return null;
    const flow = this.registry.get(ctx.state as FlowState);
    if (!flow) return null;
    const stepDef = flow.steps[ctx.step];
    return stepDef?.field ?? null;
  }

  async getCurrentStepPrompt(ctx: FlowContext, userId: UserId): Promise<HandlerResponse | null> {
    if (ctx.state === 'confirming') {
      const originFlow = ctx.originFlow ?? ctx.state;
      const flow = this.registry.get(originFlow as FlowState);
      if (flow) return flow.buildConfirmation(ctx.data);
      return null;
    }
    const flow = this.registry.get(ctx.state as FlowState);
    if (!flow || ctx.step >= flow.steps.length) return null;
    const stepDef = flow.steps[ctx.step];
    const prompt = await this.resolvePrompt(stepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(stepDef, ctx.data, userId);
    return { messages: interactive ? [] : [prompt], interactive };
  }

  // --- Private helpers ---

  private async resolvePrompt(
    stepDef: FlowStep,
    data: Record<string, unknown>,
    userId: UserId,
  ): Promise<string> {
    if (stepDef.promptAsync) return stepDef.promptAsync(data, userId);
    return typeof stepDef.prompt === 'function' ? stepDef.prompt(data) : stepDef.prompt;
  }

  private async resolveInteractive(
    stepDef: FlowStep,
    data: Record<string, unknown>,
    userId: UserId,
  ): Promise<InteractiveMessage | undefined> {
    if (stepDef.interactiveAsync) {
      const result = await stepDef.interactiveAsync(data, userId);
      return result ?? undefined;
    }
    const interactive = typeof stepDef.interactive === 'function'
      ? stepDef.interactive(data)
      : stepDef.interactive;
    return interactive ?? undefined;
  }

  private async advanceToNextStep(
    userId: UserId,
    flowState: FlowState,
    ctx: FlowContext,
    flow: FlowDefinition,
  ): Promise<FlowMessageResult> {
    let nextStep = ctx.step + 1;
    while (nextStep < flow.steps.length) {
      const step = flow.steps[nextStep];
      if (step.skipIf && step.skipIf(ctx.data)) {
        nextStep++;
        continue;
      }
      // Skip steps already pre-filled (e.g., city from "agregar campo en Vedia")
      if (ctx.data[step.field] !== undefined) {
        nextStep++;
        continue;
      }
      break;
    }

    // All steps done → confirmation
    if (nextStep >= flow.steps.length) {
      this.observer?.logFlowStep(userId, flowState, flow.steps.length, { field: '_confirmation' });
      const confirmCtx: FlowContext = {
        state: 'confirming',
        step: flow.steps.length,
        data: ctx.data,
        startedAt: ctx.startedAt,
        expiresAt: ctx.expiresAt,
        originFlow: flowState,
      };
      await this.stateRepo.setFlowContext(userId, confirmCtx);
      return {
        response: flow.buildConfirmation(ctx.data),
        nextContext: confirmCtx,
      };
    }

    // Prompt next step
    this.observer?.logFlowStep(userId, flowState, nextStep, { field: flow.steps[nextStep].field });
    ctx.state = flowState;
    ctx.step = nextStep;
    ctx.stepFailCount = 0;
    await this.stateRepo.setFlowContext(userId, ctx);

    const nextStepDef = flow.steps[nextStep];
    const prompt = await this.resolvePrompt(nextStepDef, ctx.data, userId);
    const interactive = await this.resolveInteractive(nextStepDef, ctx.data, userId);

    return {
      response: {
        messages: interactive ? [] : [prompt],
        interactive,
      },
      nextContext: ctx,
    };
  }
}
