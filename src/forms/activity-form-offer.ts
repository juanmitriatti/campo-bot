// Cuándo una pregunta de siembra / cosecha ofrece además el formulario, y con qué
// precarga. Regla (nov 2026): si MIA tiene que preguntar, ofrece el formulario
// con lo que el usuario YA dijo; si ya pudo registrar, no ofrece nada.
//
// Dos límites:
//   - Nunca adivinar el lote: solo viaja si quien llama sabe que el usuario lo
//     nombró (`keepPlot`). Heredado del contexto o ambiguo → vacío.
//   - Nunca perder datos: si el mensaje traía algo que el formulario no tiene
//     (cargas por camión, densidad, "de segunda", notas de rinde), no se ofrece,
//     porque enviarlo reemplazaría la pregunta y ese dato se caería.
import { extractCropOrderCue } from '../utils/lexicon.js';
import { canonicalMassUnit, normalizeToKg } from '../utils/mass-units.js';
import { normalizeEntityName } from '../utils/entity-matcher.js';
import type { HandlerResponse, ParsedCommand } from '../types/index.js';

type OfferForm = NonNullable<NonNullable<HandlerResponse['sideEffects']>['offerForm']>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);

export function sowFormOffer(cmd: ParsedCommand, opts: { keepPlot?: boolean } = {}): OfferForm | undefined {
  if (cmd.__fromForm === true) return undefined;
  if (cmd.seedDensity || extractCropOrderCue(`${cmd.crop ?? ''} ${cmd.originalText ?? ''}`)) {
    console.log('[FORM] skip offer sow_crop: el mensaje trae datos que el formulario no tiene');
    return undefined;
  }
  return {
    action: 'sow_crop',
    prefill: {
      plotName: opts.keepPlot ? str(cmd.plotName) : null,
      fieldName: str(cmd.fieldName),
      crop: str(cmd.crop),
      eventDate: str(cmd.eventDate),
      hectares: num(cmd.hectares),
      variety: str(cmd.variety),
    },
  };
}

export function harvestFormOffer(cmd: ParsedCommand, opts: { keepPlot?: boolean } = {}): OfferForm | undefined {
  if (cmd.__fromForm === true) return undefined;
  if ((Array.isArray(cmd.loads) && cmd.loads.length > 0) || cmd.yieldNotes) {
    console.log('[FORM] skip offer harvest_crop: el mensaje trae datos que el formulario no puede precargar');
    return undefined;
  }
  return {
    action: 'harvest_crop',
    prefill: {
      plotName: opts.keepPlot ? str(cmd.plotName) : null,
      fieldName: str(cmd.fieldName),
      eventDate: str(cmd.eventDate),
      yield_kg_per_ha: num(cmd.yieldKgPerHa),
      yield_kg: num(cmd.yieldKg),
      hectares: num(cmd.hectares),
      humidity_pct: num(cmd.humidity_pct),
    },
  };
}

// ─── Gasto / ingreso ──────────────────────────────────────────────────
// Todo lo que el usuario ya dijo se precarga. Lo que el formulario no muestra
// (cantidad, unidad, producto, precio unitario) viaja en `_carry` con la sesión,
// se ve en el resumen y se aplica al enviar (`applyCarry`).

type MoneyAction = 'log_expense' | 'log_income';

export function moneyPrefill(action: MoneyAction, data: Record<string, unknown>): Record<string, unknown> {
  const quantity = num(data.quantity);
  const kg = action === 'log_income' && quantity !== null && canonicalMassUnit(str(data.unit)) !== null
    ? normalizeToKg(quantity, str(data.unit)) : null;
  const carry: Record<string, unknown> = {
    quantity,
    unit: str(data.unit),
    unit_price: num(data.unit_price),
    ...(action === 'log_expense' ? { product: str(data.product), expenseType: str(data.expenseType) } : {}),
  };
  for (const k of Object.keys(carry)) if (carry[k] === null) delete carry[k];
  const amount = num(data.amount);
  return {
    amount: amount !== null && amount > 0 ? amount : null,
    currency: data.currency === 'USD' ? 'USD' : 'ARS',
    category: str(data.category),
    description: str(data.description),
    eventDate: str(action === 'log_expense' ? data.expenseDate : data.incomeDate),
    plotName: str(data.plot) ?? str(data.plotName),
    fieldName: str(data.field) ?? str(data.fieldName),
    buyer: str(data.buyer),
    quantity_tn: kg !== null ? kg / 1000 : null,
    ...(Object.keys(carry).length > 0 ? { _carry: carry } : {}),
  };
}

/** Falta el monto o la categoría: ofrece el formulario con todo lo entendido. */
export function partialMoneyFormOffer(action: MoneyAction, data: Record<string, unknown>): OfferForm {
  return { action, prefill: moneyPrefill(action, data) };
}

/**
 * Suma al comando lo que viajó fuera del formulario. Si el usuario cambió la
 * categoría, esos datos ya no le corresponden; si cambió el monto o las
 * toneladas, el precio unitario deja de valer. Todo descarte se loguea.
 */
export function applyCarry(cmd: Record<string, unknown>, prefill: Record<string, unknown> | null | undefined): void {
  const carry = prefill?._carry as Record<string, unknown> | undefined;
  if (!carry) return;
  const was = str(prefill!.category);
  if (was && normalizeEntityName(was) !== normalizeEntityName(String(cmd.category ?? ''))) {
    console.log(`[FORM] carry descartado: cambió la categoría (${Object.keys(carry).join(', ')})`);
    return;
  }
  const tn = num(prefill!.quantity_tn);
  const tnKept = tn !== null && num(cmd.quantity) === tn;
  const tnChanged = tn !== null && !tnKept;
  const amountChanged = num(prefill!.amount) !== null && num(prefill!.amount) !== num(cmd.amount);
  for (const [key, value] of Object.entries(carry)) {
    if ((tnChanged || amountChanged) && key === 'unit_price') { console.log('[FORM] carry: precio unitario descartado (cambiaron los números)'); continue; }
    if (tnChanged && (key === 'quantity' || key === 'unit')) continue;
    // Toneladas sin tocar: se guarda la cantidad en la unidad que dijo el usuario.
    if ((tnKept && (key === 'quantity' || key === 'unit')) || cmd[key] === undefined || cmd[key] === null) cmd[key] = value;
  }
}
