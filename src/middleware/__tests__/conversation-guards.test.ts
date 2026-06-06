import { describe, it, expect } from 'vitest';
import { isAffirmation, isNegationOrCancel, looksLikeNewActionOrQuery, isContentlessMessage } from '../conversation-guards.js';

describe('isContentlessMessage', () => {
  it.each(['', '   ', '...', '??', '🚜🌽', '👍', '— ', '\n\n'])('"%s" → true', (t) => {
    expect(isContentlessMessage(t)).toBe(true);
  });
  it.each(['gasté 50 mil', 'soja', 'lote norte', '40', 'hola', 'sí 🚜'])('"%s" → false', (t) => {
    expect(isContentlessMessage(t)).toBe(false);
  });
});

describe('isAffirmation', () => {
  it.each(['si', 'sí', 'SI', 'dale', 'ok', 'okey', 'listo', 'confirmo', 'confirmar', 'dale!', 'sip', 'de una', 'ya está'])('"%s" → true', (t) => {
    expect(isAffirmation(t)).toBe(true);
  });
  it.each(['lote norte', '40', '40 has', 'aftosa', 'soja', 'no', 'cancelar', 'gasté 50 lucas'])('"%s" → false', (t) => {
    expect(isAffirmation(t)).toBe(false);
  });
});

describe('isNegationOrCancel', () => {
  it.each(['no', 'cancelar', 'salir', 'olvidalo'])('"%s" → true', (t) => expect(isNegationOrCancel(t)).toBe(true));
  it.each(['si', 'lote norte', '40'])('"%s" → false', (t) => expect(isNegationOrCancel(t)).toBe(false));
});

describe('looksLikeNewActionOrQuery', () => {
  // The accent-bug regression cases (these used to slip through and corrupt pendings):
  it.each([
    'vendí 10 novillos del lote Norte a 800 USD cada uno',
    'eché el toro con las vacas',
    'pesé los novillos, promedio 320 kg',
    'gasté 50 lucas en gasoil',
    'sembré maíz en el lote Sur',
    'coseché soja, rindió 42 qq',
    'fumigué con glifosato',
    'compré 500 kg de urea',
  ])('action verb: "%s" → true', (t) => {
    expect(looksLikeNewActionOrQuery(t)).toBe(true);
  });

  it.each([
    'va a llover en Rosario?',
    'cómo vamos?',
    'cuánto gasté este mes?',
    'mis lotes',
    'clima en Pergamino',
    'reporte financiero',
  ])('query intent: "%s" → true', (t) => {
    expect(looksLikeNewActionOrQuery(t)).toBe(true);
  });

  it.each([
    'tengo 200 vacas en el lote norte',
    '30 terneros en El Alto',
    '120 cabezas',
    'aparte 30 terneros',
  ])('livestock registration: "%s" → true', (t) => {
    expect(looksLikeNewActionOrQuery(t)).toBe(true);
  });

  // Bare answers to a pending/flow prompt must NOT be treated as new intents:
  it.each(['40', '40 has', 'lote norte', 'Norte', 'todos 40', 'Norte 40, Sur 30', 'aftosa', 'soja', '320', 'saltar'])('bare answer: "%s" → false', (t) => {
    expect(looksLikeNewActionOrQuery(t)).toBe(false);
  });
});
