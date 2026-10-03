// Formulario conversacional (WhatsApp sin Flows): extractor determinístico,
// renderer y presentación. Sin DB — el ciclo completo (draft, confirmación,
// idempotencia) vive en pipeline.integration.test.ts § "formulario conversacional".
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, FORM_ACTIONS, crossCheckIssues, validateFieldValue } from '../form-definitions.js';
import { FORM_PRESENTATION } from '../conversation/presentation.js';
import { extractFieldValues, isFieldEmpty, type ExtractContext } from '../conversation/field-extractor.js';
import { renderQuestion, renderSummary, renderEditMenu, cbId, parseCbId } from '../conversation/renderer.js';
import type { FormOptions } from '../form-options.js';
import { isSkipAnswer, isFormCancel, matchesFormDomainVerb, namesFormField, stripFieldCue } from '../../utils/lexicon.js';
import { mentionsEntityName } from '../../utils/entity-matcher.js';
import { getTodayISO } from '../../utils/date.js';

const TODAY = '2026-09-28';

const OPTIONS: FormOptions = {
  plots: [
    { id: 1, name: 'A1', fieldId: 10, fieldName: 'La Esperanza', activeCrop: 'soja' },
    { id: 2, name: 'A2', fieldId: 10, fieldName: 'La Esperanza', activeCrop: null },
    { id: 3, name: 'Norte', fieldId: 20, fieldName: 'San Martín', activeCrop: null },
    { id: 4, name: 'Norte', fieldId: 10, fieldName: 'La Esperanza', activeCrop: null },
  ],
  fields: [{ id: 10, name: 'La Esperanza' }, { id: 20, name: 'San Martín' }],
  corrals: [{ id: 5, name: '1', feedlotName: 'Feedlot' }],
  crops: ['soja', 'maíz', 'trigo'],
  lists: {
    plots: [
      { id: '1', title: 'A1 (La Esperanza) · soja' }, { id: '2', title: 'A2 (La Esperanza)' },
      { id: '3', title: 'Norte (San Martín)' }, { id: '4', title: 'Norte (La Esperanza)' },
    ],
    locations: [
      { id: 'p:1', title: 'A1 (La Esperanza)' }, { id: 'p:2', title: 'A2 (La Esperanza)' },
      { id: 'p:3', title: 'Norte (San Martín)' }, { id: 'p:4', title: 'Norte (La Esperanza)' },
      { id: 'f:10', title: 'Todo el campo La Esperanza' }, { id: 'f:20', title: 'Todo el campo San Martín' },
    ],
    crops: [{ id: 'soja', title: 'soja' }, { id: 'maíz', title: 'maíz' }, { id: 'trigo', title: 'trigo' }],
    expense_categories: [
      { id: 'Combustible', title: 'Combustible' }, { id: 'Semillas', title: 'Semillas' },
      { id: 'Agroquímicos', title: 'Agroquímicos' }, { id: 'Fertilizantes', title: 'Fertilizantes' },
      { id: 'Maquinaria', title: 'Maquinaria' }, { id: 'Otros', title: 'Otros' },
    ],
    livestock_categories: [{ id: 'vaca', title: 'Vaca' }, { id: 'ternero', title: 'Ternero' }, { id: 'ternera', title: 'Ternera' }],
    livestock_locations: [{ id: 'p:1', title: 'A1 (La Esperanza)' }, { id: 'c:5', title: 'Corral 1 (Feedlot)' }],
    breeds: [{ id: 'Angus', title: 'Angus' }],
  },
};

function ctx(action: keyof typeof FORM_DEFINITIONS, over: Partial<ExtractContext> = {}): ExtractContext {
  return {
    def: FORM_DEFINITIONS[action], options: OPTIONS, values: {}, awaiting: null,
    overwrite: false, todayISO: TODAY, choices: null, ...over,
  };
}

describe('presentación: cada campo de cada formulario sabe cómo preguntarse', () => {
  it.each(FORM_ACTIONS)('%s', (action) => {
    const pres = FORM_PRESENTATION[action];
    expect(pres).toBeDefined();
    for (const f of FORM_DEFINITIONS[action].fields) {
      expect(pres.fields[f.key], `${action}.${f.key} sin presentación`).toBeDefined();
      // "offer" solo tiene sentido en opcionales: un obligatorio SIEMPRE se pregunta.
      if (f.required) expect(pres.fields[f.key].optional).toBeUndefined();
    }
  });
});

describe('reglas compartidas (una sola fuente con el form web y el Flow)', () => {
  const def = FORM_DEFINITIONS.log_expense;
  const amount = def.fields.find(f => f.key === 'amount')!;
  const date = def.fields.find(f => f.key === 'event_date')!;

  it('obligatorio vacío → error; inválido → error; válido → valor', () => {
    expect(validateFieldValue(amount, '', TODAY).error).toMatch(/obligatorio/);
    expect(validateFieldValue(amount, 'abc', TODAY).error).toMatch(/número/);
    expect(validateFieldValue(amount, -5, TODAY).error).toMatch(/al menos/);
    expect(validateFieldValue(amount, 250000, TODAY).value).toBe(250000);
  });

  it('fecha futura rechazada; opcional vacío = sin valor ni error', () => {
    expect(validateFieldValue(date, '2026-12-31', TODAY).error).toMatch(/futura/);
    const desc = def.fields.find(f => f.key === 'description')!;
    expect(validateFieldValue(desc, '', TODAY)).toEqual({});
  });

  it('requerido condicional del crossCheck viene atribuido a un campo', () => {
    const issues = crossCheckIssues(FORM_DEFINITIONS.log_activity, { activity_type: 'spraying', plot_id: '1', event_date: TODAY });
    expect(issues).toEqual([{ field: 'product', message: expect.stringContaining('producto') }]);
    expect(crossCheckIssues(FORM_DEFINITIONS.log_activity, { activity_type: 'irrigation', plot_id: '1', event_date: TODAY }))
      .toEqual([{ field: 'quantity', message: expect.any(String) }]);
  });
});

describe('extractor: varios datos en un mensaje', () => {
  it('"Cargá $250.000 de combustible en el lote A1 de La Esperanza de hoy" llena 4 campos', () => {
    const r = extractFieldValues('Cargá $250.000 de combustible en el lote A1 de La Esperanza de hoy', ctx('log_expense'));
    expect(r.values.amount).toBe(250000);
    expect(r.values.category).toBe('Combustible');
    expect(r.values.location).toBe('p:1');
    expect(r.values.event_date).toBe(TODAY);
  });

  it('"200 lucas" con el importe preguntado → 200000', () => {
    const r = extractFieldValues('200 lucas', ctx('log_expense', { awaiting: 'amount' }));
    expect(r.values.amount).toBe(200000);
  });

  it('"u$s 300" es dólares y "1.5 palos" es un millón y medio', () => {
    const usd = extractFieldValues('u$s 300', ctx('log_expense', { awaiting: 'amount' }));
    expect(usd.values.amount).toBe(300);
    expect(usd.values.currency).toBe('USD');
    expect(extractFieldValues('us$ 300', ctx('log_expense', { awaiting: 'amount' })).values.currency).toBe('USD');
    expect(extractFieldValues('1.5 palos', ctx('log_expense', { awaiting: 'amount' })).values.amount).toBe(1500000);
    // Una palabra que CONTIENE un término de moneda no es moneda.
    expect(extractFieldValues('compré verdeo', ctx('log_expense', { awaiting: 'description' })).values.currency).toBeUndefined();
  });

  it('un número pelado solo responde la pregunta abierta', () => {
    const r = extractFieldValues('40', ctx('add_livestock', { awaiting: 'location' }));
    expect(r.values.count).toBeUndefined();
  });

  it('un número sin pista de dinero NO se toma como importe si no se preguntó', () => {
    const r = extractFieldValues('llovió 20 mm', ctx('log_expense', { awaiting: 'location' }));
    expect(r.values.amount).toBeUndefined();
  });

  it('fechas: ayer / dd-mm / Hoy', () => {
    // "ayer" se resuelve con el reloj real (relative-dates), no con TODAY.
    const realToday = getTodayISO();
    const d = new Date(`${realToday}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    expect(extractFieldValues('fue ayer', ctx('log_expense')).values.event_date).toBe(d.toISOString().slice(0, 10));
    expect(extractFieldValues('hoy', ctx('log_expense')).values.event_date).toBe(TODAY);
    expect(extractFieldValues('el 25/09', ctx('log_expense')).values.event_date).toBe('2026-09-25');
    // Sin año y futura → el año anterior (noFuture).
    expect(extractFieldValues('el 30/12', ctx('log_expense')).values.event_date).toBe('2025-12-30');
  });

  // QA formularios (oct 2026): el producto «2-4-D» mandaba la labor al 2 de
  // abril y un lote «3-4» al 3 de abril — la fecha autocompletada se re-busca en
  // cada mensaje y cualquier "n-n" contaba.
  it('una fecha con números necesita señal de fecha; los guiones no cuentan', () => {
    expect(extractFieldValues('2-4-D', ctx('log_activity', { awaiting: 'product' })).values.event_date).toBeUndefined();
    expect(extractFieldValues('2-4-D 1 lt/ha', ctx('log_activity', { awaiting: 'product' })).values.event_date).toBeUndefined();
    expect(extractFieldValues('3-4', ctx('sow_crop', { awaiting: 'plot_id' })).values.event_date).toBeUndefined();
    // Con barra pero como respuesta a OTRA pregunta: tampoco.
    expect(extractFieldValues('3/4', ctx('sow_crop', { awaiting: 'plot_id' })).values.event_date).toBeUndefined();
    // Con barra en medio de una frase sin pista: tampoco.
    expect(extractFieldValues('250 mil de gasoil 25/09', ctx('log_expense', { awaiting: 'amount' })).values.event_date).toBeUndefined();
    // Sí: pista, mensaje que es solo la fecha, o respuesta a "¿qué día fue?".
    expect(extractFieldValues('250 mil de gasoil el 25/09', ctx('log_expense', { awaiting: 'amount' })).values.event_date).toBe('2026-09-25');
    expect(extractFieldValues('25/09', ctx('log_expense')).values.event_date).toBe('2026-09-25');
    expect(extractFieldValues('creo que 25/09', ctx('log_expense', { awaiting: 'event_date' })).values.event_date).toBe('2026-09-25');
    expect(extractFieldValues('25-09', ctx('log_expense', { awaiting: 'event_date' })).values.event_date).toBe('2026-09-25');
  });

  it('modo resumen: solo datos de tipo inequívoco; nada que se reconozca por nombre', () => {
    const r = extractFieldValues('viento del Norte de San Martín', ctx('log_activity', { overwrite: true, summary: true }));
    expect(r.values).toEqual({});
    const typed = extractFieldValues('no, eran 300 mil y fue ayer', ctx('log_expense', { overwrite: true, summary: true }));
    expect(typed.values.amount).toBe(300000);
    expect(typed.values.event_date).toBeDefined();
    expect(typed.values.category).toBeUndefined();
  });

  it('etiquetas de campo: "el detalle era X" nombra el campo y deja el valor', () => {
    expect(namesFormField('no, el monto era 300 mil', 'amount')).toBe(true);
    expect(namesFormField('viento del norte', 'plot_id')).toBe(false);
    expect(stripFieldCue('no, el detalle era Compra en YPF', 'description')).toBe('Compra en YPF');
    expect(stripFieldCue('La categoría es Veterinaria', 'category')).toBe('Veterinaria');
    expect(stripFieldCue('cambiá el producto', 'product')).toBeNull();
  });

  it('rinde: en quintales sin "/ha" es por hectárea; kg y tn sin "/ha" son el total', () => {
    const y = (t: string) => extractFieldValues(t, ctx('harvest_crop', { awaiting: 'yield_kg_per_ha' })).values;
    expect(y('42 qq')).toMatchObject({ yield_kg_per_ha: 4200, yield_kg: null });
    expect(y('rindió 35 quintales')).toMatchObject({ yield_kg_per_ha: 3500 });
    expect(y('130 tn')).toMatchObject({ yield_kg: 130000, yield_kg_per_ha: null });
    expect(y('4200 kg')).toMatchObject({ yield_kg: 4200 });
    // Más de 200 qq ya no es un rinde por hectárea.
    expect(y('1500 qq')).toMatchObject({ yield_kg: 150000 });
  });

  it('cargas: humedad solo con %, y un número chico es parte del nombre', () => {
    const l = (t: string) => extractFieldValues(t, ctx('harvest_crop', { awaiting: 'loads' }));
    expect(l('Juan 28500 Silo 2').values.loads).toEqual([{ driver_name: 'Juan', weight_kg: 28500, destinatario: 'Silo 2' }]);
    expect(l('Camión 2 Juan 28500').values.loads).toEqual([{ driver_name: 'Camión 2 Juan', weight_kg: 28500 }]);
    const two = l('Juan 28,5 tn Cargill 14%\nPedro 30000');
    expect(two.values.loads).toEqual([
      { driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill', humidity_pct: 14 },
      { driver_name: 'Pedro', weight_kg: 30000 },
    ]);
    // El 14% es de Juan: no sube a la humedad general (Pedro la heredaría).
    expect(two.values.humidity_pct).toBeUndefined();
  });

  it('cargas: más de 20 camiones se recortan CON aviso', () => {
    const lines = Array.from({ length: 23 }, (_, i) => `Chofer${String.fromCharCode(65 + i)} 28000`).join('\n');
    const r = extractFieldValues(lines, ctx('harvest_crop', { awaiting: 'loads' }));
    expect((r.values.loads as unknown[]).length).toBe(20);
    expect(r.warnings?.join(' ')).toMatch(/primeros 20 camiones de 23/);
  });

  it('producto esperado: sin la dosis pegada', () => {
    const r = extractFieldValues('glifosato 2 lt/ha', ctx('log_activity', { awaiting: 'product' }));
    expect(r.values).toMatchObject({ product: 'glifosato', quantity: 2, unit: 'lt/ha' });
    expect(extractFieldValues('con 2,4-D', ctx('log_activity', { awaiting: 'product' })).values.product).toBe('2,4-D');
  });

  it('ingreso: comprador y toneladas de una venta de grano', () => {
    const o = { ...OPTIONS, lists: { ...OPTIONS.lists, income_categories: [{ id: 'Soja', title: 'Soja' }, { id: 'Otros', title: 'Otros' }] } };
    const r = extractFieldValues('vendí 30 tn de soja a Cargill 9 palos', { ...ctx('log_income'), options: o });
    expect(r.values).toMatchObject({ amount: 9000000, category: 'Soja', buyer: 'Cargill', quantity_tn: 30 });
    const kg = extractFieldValues('vendí 28500 kg de soja a AGD por 8 palos', { ...ctx('log_income'), options: o });
    expect(kg.values).toMatchObject({ buyer: 'AGD', quantity_tn: 28.5 });
    // "a fijar" / "a 320 dólares" no son un comprador.
    expect(extractFieldValues('vendí la soja a fijar', { ...ctx('log_income'), options: o }).values.buyer).toBeUndefined();
    expect(extractFieldValues('vendí soja a 320 dólares', { ...ctx('log_income'), options: o }).values.buyer).toBeUndefined();
    // Respuesta a "¿A quién se lo vendiste?"
    expect(extractFieldValues('a Cargill', { ...ctx('log_income', { awaiting: 'buyer' }), options: o }).values.buyer).toBe('Cargill');
    expect(extractFieldValues('30', { ...ctx('log_income', { awaiting: 'quantity_tn' }), options: o }).values.quantity_tn).toBe(30);
  });

  it('hacienda: "40 terneros en el corral 1"', () => {
    const r = extractFieldValues('40 terneros en el corral 1', ctx('add_livestock'));
    expect(r.values.count).toBe(40);
    expect(r.values.category).toBe('ternero');
    expect(r.values.location).toBe('c:5');
  });

  it('labor: tipo + producto + dosis con unidad', () => {
    const r = extractFieldValues('fumigué el A2 con glifosato 2 lt/ha', ctx('log_activity'));
    expect(r.values.activity_type).toBe('spraying');
    expect(r.values.plot_id).toBe('2');
    expect(r.values.product).toMatch(/glifosato/);
    expect(r.values.quantity).toBe(2);
    expect(r.values.unit).toBe('lt/ha');
  });

  it('cosecha: rinde por ha vs total son excluyentes', () => {
    const perHa = extractFieldValues('42 qq/ha', ctx('harvest_crop', { awaiting: 'yield_kg_per_ha' }));
    expect(perHa.values.yield_kg_per_ha).toBe(4200);
    expect(perHa.values.yield_kg).toBeNull();
    const total = extractFieldValues('rindió 130 tn en total', ctx('harvest_crop'));
    expect(total.values.yield_kg).toBe(130000);
    expect(total.values.yield_kg_per_ha).toBeNull();
  });

  it('cargas por camión: un renglón inválido se informa, no se descarta en silencio', () => {
    const r = extractFieldValues('Juan 28500 Cargill 14%\nPedro 30 tn\nsin peso', ctx('harvest_crop', { awaiting: 'loads' }));
    expect(r.values.loads).toEqual([
      { driver_name: 'Juan', weight_kg: 28500, destinatario: 'Cargill', humidity_pct: 14 },
      { driver_name: 'Pedro', weight_kg: 30000 },
    ]);
    expect(r.warnings?.[0]).toMatch(/Renglón 3/);
  });

  it('categoría fuera de la lista con "otro" permitido → texto libre (el handler la matchea o crea)', () => {
    const r = extractFieldValues('flete de hacienda', ctx('log_expense', { awaiting: 'category' }));
    expect(r.values.category_other).toBe('flete de hacienda');
  });

  it('respuesta por número a la lista mostrada', () => {
    const r = extractFieldValues('2', ctx('log_expense', {
      awaiting: 'category', choices: { field: 'category', ids: ['Combustible', 'Semillas'] },
    }));
    expect(r.values.category).toBe('Semillas');
  });
});

describe('extractor: consistencia campo ↔ lote', () => {
  it('lote de OTRO campo → no se toma, se explica', () => {
    const r = extractFieldValues('en el A1 de San Martín', ctx('log_expense', { awaiting: 'location' }));
    expect(r.values.location).toBeUndefined();
    expect(r.notFound?.message).toMatch(/A1.*San Martín.*La Esperanza/);
  });

  it('dos lotes homónimos sin campo → pregunta cuál, nunca elige el primero', () => {
    const r = extractFieldValues('en el Norte', ctx('sow_crop', { awaiting: 'plot_id' }));
    expect(r.values.plot_id).toBeUndefined();
    expect(r.ambiguous?.candidates.map(c => c.id)).toEqual(['3', '4']);
  });

  it('homónimo desambiguado por el campo', () => {
    const r = extractFieldValues('el Norte de San Martín', ctx('sow_crop', { awaiting: 'plot_id' }));
    expect(r.values.plot_id).toBe('3');
  });

  it('campo entero en un gasto', () => {
    const r = extractFieldValues('es de todo el campo San Martín', ctx('log_expense', { awaiting: 'location' }));
    expect(r.values.location).toBe('f:20');
  });

  it('lote inexistente → razón legible', () => {
    const r = extractFieldValues('A7', ctx('sow_crop', { awaiting: 'plot_id' }));
    expect(r.notFound?.message).toMatch(/No encontré «A7»/);
  });

  it('mentionsEntityName: nombres cortos/numéricos exigen la palabra "lote"', () => {
    expect(mentionsEntityName('compré 3 bolsas', '3')).toBe(false);
    expect(mentionsEntityName('en el lote 3', '3')).toBe(true);
    expect(mentionsEntityName('3', '3')).toBe(true);
    expect(mentionsEntityName('en el 11 d', '11D')).toBe(true);
  });
});

describe('extractor: no pisa lo cargado salvo en el resumen', () => {
  it('fuera del resumen, un campo lleno no se sobrescribe', () => {
    const r = extractFieldValues('300 mil', ctx('log_expense', { values: { amount: 250000 }, awaiting: 'category' }));
    expect(r.values.amount).toBeUndefined();
  });
  it('en el resumen, "el monto era 300 mil" corrige', () => {
    const r = extractFieldValues('no, el monto era 300 mil', ctx('log_expense', { values: { amount: 250000 }, awaiting: '__confirm', overwrite: true }));
    expect(r.values.amount).toBe(300000);
  });
  it('isFieldEmpty entiende el "otro" de un select', () => {
    const f = FORM_DEFINITIONS.log_expense.fields.find(x => x.key === 'category')!;
    expect(isFieldEmpty({ category_other: 'Flete' }, f)).toBe(false);
    expect(isFieldEmpty({}, f)).toBe(true);
  });
});

describe('lexicon del formulario', () => {
  it.each(['omitir', 'Saltar', 'no', 'no sé', 'nada', 'sin detalle'])('"%s" omite un opcional', (t) => {
    expect(isSkipAnswer(t)).toBe(true);
  });
  it('"no" NO cancela el formulario (cancelar sí)', () => {
    expect(isFormCancel('no')).toBe(false);
    expect(isFormCancel('cancelar')).toBe(true);
    expect(isFormCancel('Cancelá')).toBe(true);
  });
  it('verbo del mismo dominio = respuesta; de otro dominio = cambio de tema', () => {
    expect(matchesFormDomainVerb('log_expense', 'gasté 200 lucas en gasoil')).toBe(true);
    expect(matchesFormDomainVerb('log_expense', 'llovió 20 mm')).toBe(false);
  });
});

describe('renderer', () => {
  const def = FORM_DEFINITIONS.log_expense;
  const pres = FORM_PRESENTATION.log_expense;
  const token = 'abcdef0123456789abcdef0123456789';

  it('ids de botón cortos (≤64 bytes, Telegram) y parseables', () => {
    const id = cbId(token, 'o9');
    expect(id.length).toBeLessThanOrEqual(64);
    expect(parseCbId(id)).toEqual({ tok8: 'abcdef01', verb: 'o9' });
    expect(parseCbId('cform_zzz_ok')).toBeNull();
  });

  it('"Me falta solamente…" cuando es el único obligatorio', () => {
    const r = renderQuestion({
      def, pres, field: def.fields[0], options: OPTIONS, token, todayISO: TODAY, onlyMissing: true,
    });
    const body = r.items[0].type === 'text' ? r.items[0].text : r.items[0].interactive?.body;
    expect(body).toMatch(/Me falta solamente monto/);
    expect(body).toMatch(/¿Cuánto gastaste\?/);
  });

  it('lista ≤10 filas con títulos ≤24 y "Omitir" en el opcional', () => {
    const r = renderQuestion({
      def, pres, field: def.fields.find(f => f.key === 'location')!, options: OPTIONS, token, todayISO: TODAY, skippable: true,
    });
    const rows = r.items[0].interactive?.sections?.[0].rows ?? [];
    expect(rows.length).toBeLessThanOrEqual(10);
    for (const row of rows) expect(row.title.length).toBeLessThanOrEqual(24);
    expect(rows.at(-1)?.title).toMatch(/Omitir/);
  });

  it('botones ≤3 con títulos ≤20', () => {
    const r = renderQuestion({
      def, pres, field: def.fields.find(f => f.key === 'currency')!, options: OPTIONS, token, todayISO: TODAY,
    });
    const buttons = r.items[0].interactive?.buttons ?? [];
    expect(buttons.length).toBeLessThanOrEqual(3);
    for (const b of buttons) expect(b.title.length).toBeLessThanOrEqual(20);
  });

  it('resumen: títulos legibles (no ids), fecha con "(hoy)" y Confirmar/Editar/Cancelar', () => {
    const items = renderSummary({
      def, pres, token, todayISO: TODAY, options: OPTIONS,
      values: { amount: 250000, currency: 'ARS', category: 'Combustible', location: 'p:1', event_date: TODAY },
    });
    const body = items[0].interactive?.body ?? '';
    expect(body).toMatch(/\$250\.000/);
    expect(body).toMatch(/A1 \(La Esperanza\)/);
    expect(body).not.toMatch(/p:1/);
    expect(body).toMatch(/28\/09\/2026 \(hoy\)/);
    expect(items[0].interactive?.buttons?.map(b => b.title)).toEqual(['✅ Confirmar', '✏️ Editar', '❌ Cancelar']);
  });

  it('menú Editar: una fila por campo con su valor actual', () => {
    const items = renderEditMenu({
      def, pres, token, todayISO: TODAY, options: OPTIONS, values: { amount: 250000, currency: 'ARS' },
    });
    const rows = items[0].interactive?.sections?.[0].rows ?? [];
    expect(rows).toHaveLength(def.fields.length);
    expect(rows[0].description).toMatch(/250\.000/);
  });
});
