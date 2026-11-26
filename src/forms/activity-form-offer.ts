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

/**
 * Gasto / ingreso al que le falta el monto o la categoría. No se ofrece si el
 * mensaje trae algo que el formulario no tiene (precio unitario; cantidad o
 * producto en un gasto; una cantidad que no es de peso en un ingreso).
 */
export function partialMoneyFormOffer(action: 'log_expense' | 'log_income', data: Record<string, unknown>): OfferForm | undefined {
  const quantity = num(data.quantity);
  const isMass = quantity !== null && canonicalMassUnit(str(data.unit)) !== null;
  const lost = num(data.unit_price) !== null
    || (action === 'log_expense' ? quantity !== null || !!data.product : quantity !== null && !isMass);
  if (lost) {
    console.log(`[FORM] skip offer ${action}: el mensaje trae datos que el formulario no tiene`);
    return undefined;
  }
  const kg = isMass ? normalizeToKg(quantity, str(data.unit)) : null;
  return {
    action,
    prefill: {
      currency: data.currency === 'USD' ? 'USD' : 'ARS',
      category: str(data.category),
      description: str(data.description),
      eventDate: str(action === 'log_expense' ? data.expenseDate : data.incomeDate),
      plotName: str(data.plot) ?? str(data.plotName),
      fieldName: str(data.field) ?? str(data.fieldName),
      buyer: str(data.buyer),
      quantity_tn: kg !== null ? kg / 1000 : null,
    },
  };
}
