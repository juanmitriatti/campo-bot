import { describe, it, expect } from 'vitest';
import { classifyResponse } from './response-assertions.js';

describe('classifyResponse', () => {
  it('flags a clarifying question', () => {
    expect(classifyResponse('🧪 Fumigación — me faltan datos: ¿qué cantidad?')).toBe('question');
  });
  it('flags a plain question mark', () => {
    expect(classifyResponse('¿En qué lote?')).toBe('question');
  });
  it('treats a confirmation as a statement', () => {
    expect(classifyResponse('✅ Gasto registrado\n📍 La Esperanza > Norte')).toBe('statement');
  });
  it('treats an "Observación registrada" confirmation as a statement', () => {
    expect(classifyResponse('🔍 Observación registrada 📝 la soja está amarilla')).toBe('statement');
  });
  it('treats a confirmation PROMPT as a statement, not a question', () => {
    expect(classifyResponse('💸 ¿Confirmo gasto de $50.000 en Combustible?')).toBe('statement');
  });
});
