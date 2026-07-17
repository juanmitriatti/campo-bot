import { describe, it, expect } from 'vitest';
import { evaluateLockBump } from '../conversation-lock-store.js';

describe('evaluateLockBump', () => {
  it('entra al lock en el turno 1 sin liberar', () => {
    expect(evaluateLockBump(0, 5)).toEqual({ turns: 1, released: false });
  });

  it('sigue en lock por debajo del tope', () => {
    expect(evaluateLockBump(2, 5)).toEqual({ turns: 3, released: false });
  });

  it('libera al alcanzar el tope', () => {
    expect(evaluateLockBump(4, 5)).toEqual({ turns: 5, released: true });
  });

  it('respeta un tope configurable de 2', () => {
    expect(evaluateLockBump(1, 2)).toEqual({ turns: 2, released: true });
  });
});
