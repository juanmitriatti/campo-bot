import { describe, it, expect } from 'vitest';
import { parseHectares } from '../pending-plot-area-handler.js';

describe('parseHectares', () => {
  it('parses a plain number', () => {
    expect(parseHectares('150')).toBe(150);
  });
  it('parses "150 ha"', () => {
    expect(parseHectares('150 ha')).toBe(150);
  });
  it('parses a decimal comma', () => {
    expect(parseHectares('150,5')).toBe(150.5);
  });
  // The prod bug: mid-message correction took the first number (40) instead of 60.
  it('takes the corrected (last) number on "40, ah no eran 60"', () => {
    expect(parseHectares('40, ah no perdón eran 60')).toBe(60);
  });
  it('takes the corrected number on "no, son 80 no 50"', () => {
    expect(parseHectares('no, son 80 no 50')).toBe(50);
  });
  it('rejects non-numeric input', () => {
    expect(parseHectares('muchas')).toBeNull();
  });
  it('rejects out-of-range', () => {
    expect(parseHectares('0')).toBeNull();
    expect(parseHectares('200000')).toBeNull();
  });
});
