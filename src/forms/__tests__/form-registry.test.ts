// Registro de formularios (Sep 2026): cada FormDefinition tiene que estar
// cableada en TODOS los lugares que la consumen, o el formulario existe a
// medias (se ofrece pero no se puede abrir, o se abre pero no se guarda).
// Invariante 2 aplicada a formularios.
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, FORM_ACTIONS, validateFormPayload } from '../form-definitions.js';
import { buildFormCommand } from '../form-commands.js';
import { buildWhatsAppFlowJson, unflattenFlowPayload } from '../whatsapp-flow-generator.js';
import { SETTING_DEFINITIONS } from '../../services/settings.service.js';
import { CALLBACK_MAP } from '../../domain/interactive/interactive.router.js';
import { SYSTEM_COMMANDS } from '../../domain/router.js';

const HOY = '2026-09-06';

describe('registro de formularios — los 3 lugares', () => {
  it('cada formulario tiene su setting de flow_id registrada en el admin (grupo bot)', () => {
    for (const def of Object.values(FORM_DEFINITIONS)) {
      const setting = (SETTING_DEFINITIONS as Record<string, { group: string }>)[def.settingKey];
      expect(setting, `${def.action} → ${def.settingKey}`).toBeDefined();
      expect(setting.group).toBe('bot');
    }
  });

  it('cada formulario se puede abrir desde el picker: botón → comando de sistema', () => {
    const buttonToAction: Record<string, string> = {
      form_open_sow: 'sow_crop', form_open_harvest: 'harvest_crop',
      form_open_expense: 'log_expense', form_open_income: 'log_income',
      form_open_activity: 'log_activity', form_open_livestock: 'add_livestock',
    };
    expect(Object.values(buttonToAction).sort()).toEqual([...FORM_ACTIONS].sort());
    for (const [button, action] of Object.entries(buttonToAction)) {
      const route = (CALLBACK_MAP as Record<string, { command: string }>)[button];
      expect(route, `${button} (${action})`).toBeDefined();
      expect(SYSTEM_COMMANDS.has(route.command), `${route.command} en SYSTEM_COMMANDS`).toBe(true);
    }
  });

  it('cada formulario valida en Meta: un solo screen, cada ${data.x} declarado, payload completo', () => {
    for (const def of Object.values(FORM_DEFINITIONS)) {
      const flow = buildWhatsAppFlowJson(def) as {
        screens: Array<{ data: Record<string, unknown>; layout: { children: Array<Record<string, unknown>> } }>;
      };
      const screen = flow.screens[0];
      const json = JSON.stringify(screen.layout);
      for (const ref of json.matchAll(/\$\{data\.([a-z0-9_]+)\}/g)) {
        expect(screen.data, `${def.action}: ${ref[1]} declarado en data`).toHaveProperty(ref[1]);
      }
      const names = screen.layout.children.filter(c => 'name' in c).map(c => c.name as string);
      const footer = screen.layout.children.find(c => c.type === 'Footer') as { 'on-click-action': { payload: Record<string, string> } };
      expect(Object.keys(footer['on-click-action'].payload).sort()).toEqual([...names].sort());
    }
  });
});

describe('formularios nuevos — validación', () => {
  it('gasto: monto, moneda, categoría y fecha obligatorios; lote o campo opcional', () => {
    const def = FORM_DEFINITIONS.log_expense;
    const bad = validateFormPayload(def, { currency: 'ARS', event_date: HOY }, HOY);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/Monto.*obligatorio/);
    const ok = validateFormPayload(def, { amount: '150000', currency: 'ARS', category: 'Gasoil', event_date: HOY }, HOY);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data).toEqual({ amount: 150000, currency: 'ARS', category: 'Gasoil', event_date: HOY });
  });

  it('gasto: una moneda fuera de las opciones fijas se rechaza', () => {
    const r = validateFormPayload(FORM_DEFINITIONS.log_expense, { amount: 10, currency: 'EUR', category: 'x', event_date: HOY }, HOY);
    expect(r.ok).toBe(false);
  });

  it('categoría "otro": el texto acompañante gana sobre la opción (web y Flow mandan la misma clave)', () => {
    const r = validateFormPayload(FORM_DEFINITIONS.log_income, {
      amount: 5, currency: 'USD', category: '__other__', category_other: 'Alquiler de maquinaria', event_date: HOY,
    }, HOY);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.category).toBe('Alquiler de maquinaria');
  });

  it('labor: fumigación sin producto se rechaza; riego sin mm se rechaza; dosis sin unidad se rechaza', () => {
    const def = FORM_DEFINITIONS.log_activity;
    const noProduct = validateFormPayload(def, { activity_type: 'spraying', plot_id: '7', event_date: HOY }, HOY);
    expect(noProduct.ok).toBe(false);
    const noMm = validateFormPayload(def, { activity_type: 'irrigation', plot_id: '7', event_date: HOY }, HOY);
    expect(noMm.ok).toBe(false);
    const noUnit = validateFormPayload(def, { activity_type: 'fertilization', product: 'urea', quantity: '100', plot_id: '7', event_date: HOY }, HOY);
    expect(noUnit.ok).toBe(false);
    const ok = validateFormPayload(def, { activity_type: 'fertilization', product: 'urea', quantity: '100', unit: 'kg/ha', plot_id: '7', event_date: HOY }, HOY);
    expect(ok.ok).toBe(true);
  });

  it('hacienda: categoría, cabezas y ubicación obligatorias; precio opcional', () => {
    const def = FORM_DEFINITIONS.add_livestock;
    const bad = validateFormPayload(def, { category: 'vaca', count: '0', location: 'p:7', event_date: HOY }, HOY);
    expect(bad.ok).toBe(false);
    const ok = validateFormPayload(def, { category: 'vaca', count: '40', breed: 'Angus', location: 'c:3', unit_price: '850000', currency: 'ARS', event_date: HOY }, HOY);
    expect(ok.ok).toBe(true);
  });
});

describe('form-commands — del payload validado al comando del handler', () => {
  it('gasto a nivel campo → fieldName sin plotName, expenseDate, currency', () => {
    const cmd = buildFormCommand('log_expense',
      { amount: 150000, currency: 'ARS', category: 'Sueldos', event_date: HOY },
      { field: { id: 1, name: 'La Esperanza' } });
    expect(cmd).toMatchObject({ command: 'log_expense', amount: 150000, currency: 'ARS', category: 'Sueldos', fieldName: 'La Esperanza', plotName: null, expenseDate: HOY });
    expect(cmd.description).toBe('Sueldos'); // sin detalle, la categoría hace de descripción
  });

  it('ingreso en lote → plotName + fieldName, incomeDate', () => {
    const cmd = buildFormCommand('log_income',
      { amount: 12000, currency: 'USD', category: 'Venta de granos', description: '30 tn soja', event_date: HOY },
      { plot: { id: 7, name: 'Norte', fieldName: 'La Esperanza' } });
    expect(cmd).toMatchObject({ command: 'log_income', plotName: 'Norte', fieldName: 'La Esperanza', incomeDate: HOY, description: '30 tn soja' });
    expect(cmd).not.toHaveProperty('expenseDate');
  });

  it('labor: el tipo elige el comando; labranza duplica producto en implement', () => {
    const spray = buildFormCommand('log_activity',
      { activity_type: 'spraying', product: 'glifosato', quantity: 2, unit: 'lt/ha', event_date: HOY },
      { plot: { id: 7, name: 'Norte', fieldName: 'La Esperanza' } });
    expect(spray).toMatchObject({ command: 'log_spraying', product: 'glifosato', quantity: 2, unit: 'lt/ha', plotName: 'Norte' });
    expect(spray).not.toHaveProperty('implement');
    const till = buildFormCommand('log_activity', { activity_type: 'tillage', product: 'rastra', event_date: HOY },
      { plot: { id: 7, name: 'Norte', fieldName: 'La Esperanza' } });
    expect(till).toMatchObject({ command: 'log_tillage', product: 'rastra', implement: 'rastra' });
  });

  it('hacienda: precio en la moneda elegida y corral como destino', () => {
    const cmd = buildFormCommand('add_livestock',
      { category: 'ternero', count: 40, breed: 'Angus', unit_price: 500, currency: 'USD', event_date: HOY },
      { corral: { id: 3, name: 'C1', feedlotName: 'Feedlot Norte' } });
    expect(cmd).toMatchObject({ command: 'add_livestock', category: 'ternero', count: 40, breed: 'Angus', corralName: 'C1', plotName: null, unit_price_usd: 500 });
    expect(cmd).not.toHaveProperty('unit_price_ars');
    expect(cmd.__skipMoveOffer).toBe(true);
  });
});

describe('Flow JSON — opciones fijas y "otro"', () => {
  it('moneda va inline (sin clave *_options en data); la categoría dinámica sí va por data', () => {
    const flow = buildWhatsAppFlowJson(FORM_DEFINITIONS.log_expense) as {
      screens: Array<{ data: Record<string, unknown>; layout: { children: Array<Record<string, unknown>> } }>;
    };
    const currency = flow.screens[0].layout.children.find(c => c.name === 'currency') as { 'data-source': unknown };
    expect(Array.isArray(currency['data-source'])).toBe(true);
    expect(flow.screens[0].data).not.toHaveProperty('currency_options');
    expect(flow.screens[0].data).toHaveProperty('category_options');
    // allowOther → TextInput acompañante y su init declarado
    expect(flow.screens[0].layout.children.some(c => c.name === 'category_other' && c.type === 'TextInput')).toBe(true);
    expect(flow.screens[0].data).toHaveProperty('category_other_init');
  });

  it('unflatten deja pasar la clave *_other para que la validación la tome', () => {
    const out = unflattenFlowPayload(FORM_DEFINITIONS.log_expense, {
      flow_token: 't', amount: '100', currency: 'ARS', category: '', category_other: 'Peaje', event_date: HOY,
    });
    expect(out.category_other).toBe('Peaje');
    expect(out.flow_token).toBeUndefined();
  });
});
