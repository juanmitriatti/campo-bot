/**
 * Equivalencia de nombres de lote y respuestas con varios lotes (prod 12 oct
 * 2026: lotes «El Uno/El Dos/El Tres» nombrados "lote 3", "En todos", "Lote
 * Uno lote dos y lote tres").
 */
import { describe, it, expect } from 'vitest';
import { entityNameKey, findEquivalentName, resolvePlotList, mentionsEntityName } from '../entity-matcher.js';
import { collectivePlotAnswer, mentionsRegistrationOf } from '../lexicon.js';
import { validateToolCall } from '../../ai/agent-output-validator.js';
import { looksLikeNonCity } from '../../middleware/pending-field-city-handler.js';
import { hasActionVerb, isReadOnlyQuery } from '../../middleware/conversation-guards.js';
import { processPendingAction } from '../../middleware/pending-action-processor.js';

const CAMPO_2 = ['El Uno', 'El Dos', 'El Tres'];

describe('entityNameKey / findEquivalentName', () => {
  it('junta número escrito, dígito, artículo y prefijo "lote"', () => {
    for (const s of ['El Tres', 'lote 3', '3', 'tres', 'Lote Tres', 'el 3', 'lote el 3']) {
      expect(entityNameKey(s)).toBe('3');
    }
    expect(entityNameKey('La Esperanza')).toBe('esperanza');
  });

  it('«campo 2» y «corral 2» nunca son el lote «El Dos»', () => {
    expect(findEquivalentName('campo 2', CAMPO_2)).toBeNull();
    expect(findEquivalentName('corral 2', CAMPO_2)).toBeNull();
  });

  it('resuelve solo si hay un único equivalente', () => {
    expect(findEquivalentName('lote 3', CAMPO_2)).toBe('El Tres');
    expect(findEquivalentName('Uno', CAMPO_2)).toBe('El Uno');
    expect(findEquivalentName('lote 1', ['El Uno', 'Lote 1'])).toBeNull();
    expect(findEquivalentName('lote 4', CAMPO_2)).toBeNull();
  });

  it('mentionsEntityName entiende «El Tres» nombrado "lote 3"', () => {
    expect(mentionsEntityName('fumigué el lote 3', 'El Tres')).toBe(true);
    expect(mentionsEntityName('compré 3 bolsas', 'Lote 3')).toBe(false);
  });
});

describe('resolvePlotList', () => {
  it('listas con "lote", comas, "y" y números', () => {
    expect(resolvePlotList('Lote Uno lote dos y lote tres', CAMPO_2)).toEqual(['El Uno', 'El Dos', 'El Tres']);
    expect(resolvePlotList('el 2, el 3 y el 1', CAMPO_2)).toEqual(['El Dos', 'El Tres', 'El Uno']);
    expect(resolvePlotList('en los lotes 1 y 3', CAMPO_2)).toEqual(['El Uno', 'El Tres']);
    expect(resolvePlotList('Norte y Sur', ['Lote Norte', 'Sur', 'Este'])).toEqual(['Lote Norte', 'Sur']);
  });

  it('una lista a medio entender no se aplica', () => {
    expect(resolvePlotList('el 1 y el 7', CAMPO_2)).toBeNull();
    expect(resolvePlotList('El Tres', CAMPO_2)).toBeNull();
  });
});

describe('collectivePlotAnswer', () => {
  it('colectivas con y sin cantidad', () => {
    expect(collectivePlotAnswer('En todos')).toBe('all');
    expect(collectivePlotAnswer('todos los lotes')).toBe('all');
    expect(collectivePlotAnswer('en todos los lotes del campo 2')).toBe('all');
    expect(collectivePlotAnswer('todo el campo')).toBe('all');
    expect(collectivePlotAnswer('En los tres lotes')).toBe(3);
    expect(collectivePlotAnswer('ambos')).toBe(2);
  });

  it('un nombre de lote con artículo no es colectivo', () => {
    expect(collectivePlotAnswer('Los Teros')).toBeNull();
    expect(collectivePlotAnswer('los del norte')).toBeNull();
    expect(collectivePlotAnswer('el norte')).toBeNull();
  });
});

describe('validador: lote nombrado con dígito', () => {
  it('«El Tres» del agente se acepta con "en el lote 3" en el texto', () => {
    const out = validateToolCall(
      { toolName: 'log_spraying', input: { plot: 'El Tres', product: 'glifosato' }, originalText: 'sembre soja en todo el campo 2 y en el lote 3 aplique glifosato' } as never,
      { validatePlotField: true, userPlots: ['La Esperanza', 'Los Teros', ...CAMPO_2], userFields: ['campo 1', 'campo 2', 'campo 3'] } as never,
    );
    expect(out.input.plot).toBe('El Tres');
    expect(out.droppedFields).not.toContain('plot');
  });
});

describe('verbos y consultas', () => {
  it('"se sembró" es una acción, "qué se sembró" una consulta', () => {
    expect(hasActionVerb('se sembro soja en todos los lotes del campo 2')).toBe(true);
    expect(isReadOnlyQuery('que se sembro en el lote norte')).toBe(true);
  });

  it('mentionsRegistrationOf', () => {
    expect(mentionsRegistrationOf('sow_crop', 'Sembré soja en el campo 2')).toBe(true);
    expect(mentionsRegistrationOf('sow_crop', 'llovieron 20 mm')).toBe(false);
    expect(mentionsRegistrationOf('log_spraying', 'aplicamos glifosato')).toBe(true);
  });
});

describe('localidad recuperada del texto', () => {
  it('una descripción de lotes no es una localidad', () => {
    expect(looksLikeNonCity('el primero tengo dos lotes la esperanza y los teros')).toBe(true);
    expect(looksLikeNonCity('Pergamino')).toBe(false);
  });
});

describe('pending de una actividad agro no absorbe plata', () => {
  it('"en los tres lotes" no deja amount/category en una siembra', () => {
    const r = processPendingAction('En los tres lotes', {
      command: 'sow_crop', data: { crop: 'soja', fieldName: 'campo 2' }, missing: ['plot'], timestamp: Date.now(),
    });
    expect(r.finalData.amount).toBeUndefined();
    expect(r.finalData.category).toBeUndefined();
  });
});
