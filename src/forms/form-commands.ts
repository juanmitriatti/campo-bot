// Del payload VALIDADO de un formulario al comando que entra por
// DomainRouter.routeCommand — el MISMO handler que el chat, cero IA.
//
// Puro a propósito: las referencias (lote, campo, corral, cultivo activo) las
// resuelve form-submit contra la DB con scoping por usuario y las pasa acá
// ya resueltas. Un builder por acción; sumar un formulario = una entrada.
import type { FormAction } from './form-definitions.js';

export interface ResolvedRefs {
  plot?: { id: number; name: string; fieldName: string } | null;
  field?: { id: number; name: string } | null;
  corral?: { id: number; name: string; feedlotName: string | null } | null;
  /** Cosecha: cultivo activo del lote (el form no lo pide). */
  activeCrop?: string | null;
}

const ACTIVITY_COMMAND: Record<string, string> = {
  spraying: 'log_spraying',
  fertilization: 'log_fertilization',
  tillage: 'log_tillage',
  irrigation: 'log_irrigation',
};

const ACTIVITY_LABEL: Record<string, string> = {
  spraying: 'fumigación',
  fertilization: 'fertilización',
  tillage: 'labranza',
  irrigation: 'riego',
};

function locationNames(refs: ResolvedRefs): { plotName: string | null; fieldName: string | null; corralName: string | null } {
  if (refs.plot) return { plotName: refs.plot.name, fieldName: refs.plot.fieldName, corralName: null };
  if (refs.corral) return { plotName: null, fieldName: null, corralName: refs.corral.name };
  if (refs.field) return { plotName: null, fieldName: refs.field.name, corralName: null };
  return { plotName: null, fieldName: null, corralName: null };
}

function where(refs: ResolvedRefs): string {
  if (refs.plot) return ` en ${refs.plot.name}`;
  if (refs.corral) return ` en corral ${refs.corral.name}`;
  if (refs.field) return ` en ${refs.field.name}`;
  return '';
}

export function buildFormCommand(
  action: FormAction,
  data: Record<string, unknown>,
  refs: ResolvedRefs,
): Record<string, unknown> {
  const eventDate = data.event_date as string;
  const loc = locationNames(refs);

  switch (action) {
    case 'sow_crop':
      return {
        command: 'sow_crop',
        crop: (data.crop as string) ?? null,
        plotName: refs.plot?.name ?? null,
        fieldName: refs.plot?.fieldName ?? null,
        eventDate,
        hectares: (data.hectares as number) ?? null,
        variety: (data.variety as string) ?? null,
        originalText: `[formulario] siembra ${(data.crop as string) ?? ''}${where(refs)}`.trim(),
      };

    case 'harvest_crop':
      return {
        command: 'harvest_crop',
        crop: refs.activeCrop ?? null,
        plotName: refs.plot?.name ?? null,
        fieldName: refs.plot?.fieldName ?? null,
        eventDate,
        yieldKg: (data.yield_kg as number) ?? null,
        yieldKgPerHa: (data.yield_kg_per_ha as number) ?? null,
        humidity_pct: (data.humidity_pct as number) ?? null,
        loads: (data.loads as Array<Record<string, unknown>>) ?? null,
        originalText: `[formulario] cosecha ${refs.activeCrop ?? ''}${where(refs)}`.trim(),
      };

    case 'log_expense':
    case 'log_income': {
      const isExpense = action === 'log_expense';
      const description = (data.description as string) || (data.category as string);
      return {
        command: action,
        amount: data.amount as number,
        currency: (data.currency as string) === 'USD' ? 'USD' : 'ARS',
        category: data.category as string,
        description,
        plotName: loc.plotName,
        fieldName: loc.fieldName,
        ...(isExpense ? { expenseDate: eventDate } : { incomeDate: eventDate }),
        originalText: `[formulario] ${isExpense ? 'gasto' : 'ingreso'} ${data.category as string}${where(refs)}`,
      };
    }

    case 'log_activity': {
      const type = data.activity_type as string;
      const product = (data.product as string) ?? null;
      return {
        command: ACTIVITY_COMMAND[type],
        product,
        // Labranza: el handler acepta implemento O producto; el form pide uno solo.
        ...(type === 'tillage' && product ? { implement: product } : {}),
        quantity: (data.quantity as number) ?? null,
        unit: (data.unit as string) ?? null,
        plotName: refs.plot?.name ?? null,
        fieldName: refs.plot?.fieldName ?? null,
        eventDate,
        notes: (data.notes as string) ?? null,
        originalText: `[formulario] ${ACTIVITY_LABEL[type] ?? type}${product ? ` con ${product}` : ''}${where(refs)}`,
      };
    }

    case 'add_livestock': {
      const price = data.unit_price as number | undefined;
      const usd = (data.currency as string) === 'USD';
      return {
        command: 'add_livestock',
        category: data.category as string,
        count: data.count as number,
        breed: (data.breed as string) ?? null,
        plotName: loc.plotName,
        fieldName: loc.fieldName,
        corralName: loc.corralName,
        eventDate,
        ...(price !== undefined ? (usd ? { unit_price_usd: price } : { unit_price_ars: price }) : {}),
        notes: (data.notes as string) ?? null,
        // La oferta "¿son nuevos o los muevo?" se dispara por verbo en el texto;
        // un formulario de alta es un alta.
        __skipMoveOffer: true,
        originalText: `[formulario] alta ${data.count as number} ${data.category as string}${where(refs)}`,
      };
    }
  }
}
