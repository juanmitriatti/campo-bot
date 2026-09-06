// Sugerencias post-acción ("¿Y ahora?"). Integridad del catálogo + política
// del admin. Cada regla acá salió del análisis del 6 sep 2026: un título de
// 21 caracteres tiraba el mensaje entero en WhatsApp, cuatro claves emitidas
// por handlers no existían, y nada gateaba por plan.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
  SUGGESTIONS, BUTTON_FEATURE, CATALOG_BUTTON_IDS, WHATSAPP_BUTTON_TITLE_MAX,
  validateCatalog, resolveSuggestionKey, parseSuggestionOverrides, parseSuggestionPolicy, buildSuggestion,
} from '../contextual-suggestions.js';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') walk(p, out); }
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('catálogo — integridad', () => {
  it('cada botón tiene ruta, título de ≤20 caracteres y entre 1 y 3 botones; cada comando mapeado apunta a una clave que existe', () => {
    expect(validateCatalog()).toEqual([]);
  });

  it('toda suggestionKey que emite un handler existe en el catálogo (antes 4 claves no mostraban nada)', () => {
    const files = walk(path.resolve('src/domain'));
    const emitted = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/suggestionKey: '([a-z_]+)'/g)) emitted.add(m[1]);
    }
    const missing = [...emitted].filter(k => !(k in SUGGESTIONS));
    expect(missing, `claves sin entrada: ${missing.join(', ')}`).toEqual([]);
  });

  it('el límite de WhatsApp se mide en unidades UTF-16 (un emoji vale 2)', () => {
    expect('🌾 Registrar actividad'.length).toBeGreaterThan(WHATSAPP_BUTTON_TITLE_MAX); // el que rompía
    for (const m of Object.values(SUGGESTIONS)) {
      if (m.type !== 'buttons') continue;
      for (const btn of m.buttons) expect(btn.title.length, btn.title).toBeLessThanOrEqual(WHATSAPP_BUTTON_TITLE_MAX);
    }
  });

  it('los botones de ayuda dicen "ejemplos", no fingen ser una acción', () => {
    for (const m of Object.values(SUGGESTIONS)) {
      if (m.type !== 'buttons') continue;
      for (const btn of m.buttons) {
        if (btn.id.startsWith('help_') && btn.id !== 'menu_ayuda') expect(btn.title.toLowerCase()).toMatch(/ejemplos|ayuda/);
      }
    }
  });

  it('un comando sin clave mapeada no muestra nada (antes caía a un menú que nunca se dibujaba)', () => {
    expect(resolveSuggestionKey('agronomy_question')).toBeUndefined();
    expect(resolveSuggestionKey('log_expense', 'expense_saved')).toBe('expense_saved');
    expect(resolveSuggestionKey('sow_crop')).toBe('activity_logged');
  });

  it('todo botón gateable declara su feature y todo id del gate existe en el catálogo', () => {
    for (const id of Object.keys(BUTTON_FEATURE)) expect(CATALOG_BUTTON_IDS.has(id), id).toBe(true);
    // Los que abren features de plan pago tienen que estar gateados.
    for (const id of ['cmd_reporte_agro', 'menu_lluvia', 'menu_clima', 'cmd_exportar_csv', 'cmd_listar_hacienda', 'cmd_ver_stock']) {
      expect(BUTTON_FEATURE[id], id).toBeDefined();
    }
  });
});

describe('política del admin (sin deploy)', () => {
  const allow = async () => true;
  const none = async () => 0;
  const base = parseSuggestionPolicy({ enabled: true, maxPerDay: 0, disabledKeys: '', overridesJson: '' });

  it('kill switch: SUGGESTIONS_ENABLED=false → nada', async () => {
    const policy = parseSuggestionPolicy({ enabled: false, maxPerDay: 0, disabledKeys: '', overridesJson: '' });
    expect(await buildSuggestion({ key: 'expense_saved', policy, hasFeature: allow, shownToday: none })).toBeNull();
  });

  it('claves apagadas por coma', async () => {
    const policy = parseSuggestionPolicy({ enabled: true, maxPerDay: 0, disabledKeys: 'report_shown, expense_saved', overridesJson: '' });
    expect(await buildSuggestion({ key: 'expense_saved', policy, hasFeature: allow, shownToday: none })).toBeNull();
    expect(await buildSuggestion({ key: 'income_saved', policy, hasFeature: allow, shownToday: none })).not.toBeNull();
  });

  it('tope diario: con 3 mostradas y tope 3, nada; con tope 0, sin límite', async () => {
    const capped = parseSuggestionPolicy({ enabled: true, maxPerDay: 3, disabledKeys: '', overridesJson: '' });
    expect(await buildSuggestion({ key: 'expense_saved', policy: capped, hasFeature: allow, shownToday: async () => 3 })).toBeNull();
    expect(await buildSuggestion({ key: 'expense_saved', policy: capped, hasFeature: allow, shownToday: async () => 2 })).not.toBeNull();
    expect(await buildSuggestion({ key: 'expense_saved', policy: base, hasFeature: allow, shownToday: async () => 99 })).not.toBeNull();
  });

  it('gate por plan: un usuario sin agronomy ni rainfall no ve "Reporte agro PDF" ni "Registrar lluvia"', async () => {
    const hasFeature = async (f: string) => !['agronomy', 'rainfall'].includes(f);
    const m = await buildSuggestion({ key: 'activity_logged', policy: base, hasFeature, shownToday: none });
    // activity_logged = Reporte agro PDF (agronomy) · Otra actividad (agronomy) · Registrar lluvia (rainfall) → nada
    expect(m).toBeNull();
    const e = await buildSuggestion({ key: 'expense_saved', policy: base, hasFeature, shownToday: none });
    expect(e?.type === 'buttons' && e.buttons.map(x => x.id)).toEqual(['cmd_resumen_mensual', 'doc_upload_factura', 'cmd_borrar_ultimo_gasto']);
  });

  it('override válido reemplaza la terna; el inválido se ignora y loguea', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const json = JSON.stringify({
      expense_saved: { body: '¿Seguimos?', buttons: [{ id: 'cmd_resumen_mensual', title: '📈 Resultado mes' }] },
      income_saved: { body: 'x', buttons: [{ id: 'no_existe', title: 'Nada' }] },          // id sin ruta
      report_shown: { body: 'x', buttons: [{ id: 'back_menu', title: '📋 Un título demasiado largo para WhatsApp' }] }, // >20
      clave_inexistente: { body: 'x', buttons: [{ id: 'back_menu', title: 'Menú' }] },
    });
    const policy = parseSuggestionPolicy({ enabled: true, maxPerDay: 0, disabledKeys: '', overridesJson: json });
    expect(Object.keys(policy.overrides)).toEqual(['expense_saved']);
    const m = await buildSuggestion({ key: 'expense_saved', policy, hasFeature: allow, shownToday: none });
    expect(m).toEqual({ type: 'buttons', body: '¿Seguimos?', buttons: [{ id: 'cmd_resumen_mensual', title: '📈 Resultado mes' }] });
    // income_saved sigue con el catálogo
    const i = await buildSuggestion({ key: 'income_saved', policy, hasFeature: allow, shownToday: none });
    expect(i?.type === 'buttons' && i.buttons.length).toBe(3);
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3);
    warn.mockRestore();
  });

  it('JSON roto en SUGGESTIONS_OVERRIDES no rompe nada', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseSuggestionOverrides('{no es json')).toEqual({});
    expect(parseSuggestionOverrides('[1,2]')).toEqual({});
    expect(parseSuggestionOverrides('')).toEqual({});
    warn.mockRestore();
  });
});
