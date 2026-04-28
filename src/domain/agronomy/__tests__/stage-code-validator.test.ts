import { describe, it, expect } from 'vitest';
import { validateStageCode } from '../stage-code-validator.js';

describe('validateStageCode', () => {
  it('accepts soja R5', () => {
    expect(validateStageCode('soja', 'R5').ok).toBe(true);
  });
  it('accepts soja V3', () => {
    expect(validateStageCode('soja', 'V3').ok).toBe(true);
  });
  it('rejects soja R12 (out of range)', () => {
    const r = validateStageCode('soja', 'R12');
    expect(r.ok).toBe(false);
    expect(r.warning).toMatch(/no es típico/);
    expect(r.validRanges).toMatch(/R1\.\.R8/);
  });
  it('rejects soja V20 (out of range)', () => {
    expect(validateStageCode('soja', 'V20').ok).toBe(false);
  });
  it('accepts maíz V12', () => {
    expect(validateStageCode('maíz', 'V12').ok).toBe(true);
  });
  it('accepts maíz VT', () => {
    expect(validateStageCode('maiz', 'VT').ok).toBe(true);
  });
  it('rejects maíz R8 (only R1..R6)', () => {
    expect(validateStageCode('maíz', 'R8').ok).toBe(false);
  });
  it('passes through when no crop', () => {
    expect(validateStageCode(null, 'R12').ok).toBe(true);
  });
  it('passes through unknown crops', () => {
    expect(validateStageCode('alfalfa', 'X9').ok).toBe(true);
  });
});
