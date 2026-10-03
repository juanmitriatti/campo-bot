// PRESENTACIÓN conversacional de los formularios (WhatsApp sin Flows).
//
// Acá vive SOLO cómo se le pregunta al usuario: la pregunta natural, el emoji
// del resumen y si un OPCIONAL se ofrece (con "Omitir") o solo se agrega desde
// "Editar". Qué es obligatorio, qué valores valen y cómo se validan es de la
// FormDefinition (form-definitions.ts) — nunca se repite acá. Un test exige
// que cada campo de cada definición tenga su presentación.
import type { FormAction } from '../form-definitions.js';
import { isGrainSaleCategory } from '../../utils/crops.js';

const isGrainSale = (v: Record<string, unknown>) => isGrainSaleCategory(v.category) || isGrainSaleCategory(v.category_other);
const hasBuyer = (v: Record<string, unknown>) => typeof v.buyer === 'string' && v.buyer.trim() !== '';

export interface FieldPresentation {
  /** Pregunta natural ("¿Cuánto gastaste?"). */
  ask: string;
  /** Emoji del renglón en el resumen. */
  emoji: string;
  /**
   * Solo para OPCIONALES: `offer` = se pregunta una vez, con "Omitir", después
   * de los obligatorios; `never` (default) = no se pregunta, se agrega desde
   * "✏️ Editar" en el resumen.
   */
  optional?: 'offer' | 'never';
  /** Formato esperado, para la escalera (2º rechazo del mismo campo). */
  hint?: string;
  /**
   * Con `optional: 'offer'`: solo se ofrece si esto da true con lo ya cargado
   * (comprador y toneladas solo en una venta de grano). Sin esto, siempre.
   */
  offerIf?: (values: Record<string, unknown>) => boolean;
}

export interface FormPresentation {
  /** Sustantivo con artículo para los mensajes: "el gasto". */
  noun: string;
  fields: Record<string, FieldPresentation>;
}

const DATE: FieldPresentation = {
  ask: '📅 ¿Qué día fue?',
  emoji: '📅',
  hint: 'Tocá *Hoy* o *Ayer*, o escribí la fecha (ej: *25/09*).',
};

export const FORM_PRESENTATION: Record<FormAction, FormPresentation> = {
  sow_crop: {
    noun: 'la siembra',
    fields: {
      plot_id: { ask: '📍 ¿En qué lote sembraste?', emoji: '📍', hint: 'Elegí el lote de la lista o escribí su nombre.' },
      crop: { ask: '🌱 ¿Qué cultivo sembraste?', emoji: '🌱', hint: 'Escribí el cultivo (ej: *soja*, *maíz*, *trigo*).' },
      event_date: DATE,
      hectares: { ask: '📐 ¿Cuántas hectáreas sembraste? (solo si fue una parte del lote)', emoji: '📐', hint: 'Escribí solo el número (ej: *120*).' },
      variety: { ask: '🧬 ¿Qué variedad?', emoji: '🧬' },
    },
  },
  harvest_crop: {
    noun: 'la cosecha',
    fields: {
      plot_id: { ask: '📍 ¿Qué lote cosechaste?', emoji: '📍', hint: 'Elegí el lote de la lista (solo aparecen los que tienen cultivo activo).' },
      event_date: DATE,
      yield_kg_per_ha: {
        ask: '📊 ¿Cuánto rindió? Decime por hectárea (ej: *3500 kg/ha*, *42 qq/ha*) o el total (ej: *130 tn*).',
        emoji: '📊',
        optional: 'offer',
        hint: 'Ej: *3500 kg/ha*, *42 qq/ha* o *130 tn* en total.',
      },
      yield_kg: { ask: '⚖️ ¿Cuántos kilos cosechaste en total? (ej: *130 tn*)', emoji: '⚖️', hint: 'Ej: *130 tn* o *130000 kg*.' },
      hectares: {
        ask: '📐 ¿Cosechaste todo el lote? Si fue una parte, decime cuántas hectáreas (ej: *40 ha*). Si fue todo, tocá *Omitir*.',
        emoji: '📐',
        optional: 'offer',
        hint: 'Las hectáreas cosechadas (ej: *40*), o *Omitir* si fue el lote entero.',
      },
      humidity_pct: { ask: '💧 ¿Con qué humedad? (ej: *14%*)', emoji: '💧', hint: 'Un porcentaje entre 0 y 50 (ej: *14%*).' },
      loads: {
        ask: '🚛 Mandame los camiones, uno por renglón: *chofer peso* y, si querés, destino y humedad (con %).\nEj:\nJuan 28500 Cargill 14%\nPedro 30000',
        emoji: '🚛',
        hint: 'Un camión por renglón: *nombre del chofer* y *peso en kg* (ej: *Juan 28500*).',
      },
    },
  },
  log_expense: {
    noun: 'el gasto',
    fields: {
      amount: { ask: '💰 ¿Cuánto gastaste?', emoji: '💰', hint: 'Escribí el importe (ej: *250000*, *250 mil* o *$250.000*).' },
      currency: { ask: '💱 ¿En pesos o en dólares?', emoji: '💱' },
      category: { ask: '🏷️ ¿Qué tipo de gasto fue?', emoji: '🏷️', hint: 'Elegí una categoría de la lista o escribila.' },
      location: {
        ask: '📍 ¿Es de algún lote o campo en particular?',
        emoji: '📍',
        optional: 'offer',
        hint: 'Elegí de la lista o escribí el nombre del lote. Si no corresponde a ninguno, tocá *Omitir*.',
      },
      event_date: DATE,
      description: { ask: '📝 ¿Algún detalle? (ej: *200 lt de gasoil en YPF*)', emoji: '📝' },
    },
  },
  log_income: {
    noun: 'el ingreso',
    fields: {
      amount: { ask: '💰 ¿Cuánto cobraste?', emoji: '💰', hint: 'Escribí el importe (ej: *1500000*, *1,5 palos* o *$1.500.000*).' },
      currency: { ask: '💱 ¿En pesos o en dólares?', emoji: '💱' },
      category: { ask: '🏷️ ¿De qué fue el ingreso?', emoji: '🏷️', hint: 'Elegí una categoría de la lista o escribila.' },
      buyer: {
        ask: '🏢 ¿A quién se lo vendiste? (ej: *Cargill*)',
        emoji: '🏢',
        optional: 'offer',
        offerIf: isGrainSale,
        hint: 'El nombre del comprador o acopio, o *Omitir*.',
      },
      quantity_tn: {
        ask: '⚖️ ¿Cuántas toneladas vendiste? (ej: *30 tn*)',
        emoji: '⚖️',
        optional: 'offer',
        offerIf: isGrainSale,
        hint: 'La cantidad vendida (ej: *30 tn* o *30000 kg*), o *Omitir*.',
      },
      location: {
        ask: '📍 ¿Es de algún lote o campo en particular?',
        emoji: '📍',
        optional: 'offer',
        // Venta de grano con comprador: el lote se deduce de la campaña (igual que el chat).
        offerIf: v => !(isGrainSale(v) && hasBuyer(v)),
        hint: 'Elegí de la lista o escribí el nombre del lote. Si no corresponde a ninguno, tocá *Omitir*.',
      },
      event_date: DATE,
      description: { ask: '📝 ¿Algún detalle? (ej: *30 tn de soja a Cargill*)', emoji: '📝' },
    },
  },
  log_activity: {
    noun: 'la labor',
    fields: {
      activity_type: { ask: '🧪 ¿Qué labor hiciste?', emoji: '🧪' },
      plot_id: { ask: '📍 ¿En qué lote?', emoji: '📍', hint: 'Elegí el lote de la lista o escribí su nombre.' },
      product: { ask: '🧴 ¿Qué producto o implemento usaste?', emoji: '🧴', hint: 'Escribí el producto (ej: *glifosato*, *urea*) o el implemento (ej: *rastra*).' },
      quantity: {
        ask: '⚗️ ¿Qué dosis o cantidad? (ej: *2 lt/ha*, *100 kg/ha*, *25 mm*)',
        emoji: '⚗️',
        optional: 'offer',
        hint: 'Número y unidad (ej: *2 lt/ha*, *100 kg/ha*, *25 mm*).',
      },
      unit: { ask: '📏 ¿En qué unidad?', emoji: '📏' },
      event_date: DATE,
      notes: { ask: '📝 ¿Alguna observación?', emoji: '📝' },
    },
  },
  add_livestock: {
    noun: 'la hacienda',
    fields: {
      category: { ask: '🐄 ¿Qué categoría de animales?', emoji: '🐄', hint: 'Elegí de la lista (vacas, terneros, novillos…).' },
      count: { ask: '🔢 ¿Cuántas cabezas?', emoji: '🔢', hint: 'Escribí solo el número (ej: *40*).' },
      breed: { ask: '🧬 ¿Qué raza?', emoji: '🧬' },
      location: { ask: '📍 ¿En qué lote o corral están?', emoji: '📍', hint: 'Elegí de la lista o escribí el nombre del lote o corral.' },
      unit_price: {
        ask: '💲 ¿Fue una compra? Decime el precio por cabeza (ej: *500 mil*). Si no, tocá *Omitir*.',
        emoji: '💲',
        optional: 'offer',
        hint: 'Precio por cabeza (ej: *500000* o *500 mil*), o *Omitir*.',
      },
      currency: { ask: '💱 ¿El precio es en pesos o en dólares?', emoji: '💱' },
      event_date: DATE,
      notes: { ask: '📝 ¿Alguna observación?', emoji: '📝' },
    },
  },
};
