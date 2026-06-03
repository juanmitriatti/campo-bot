import { describe, it, expect } from 'vitest';
import { formatMoney } from './format-money.js';

describe('formatMoney', () => {
  it('renders USD with the "USD " prefix and NEVER the peso sign', () => {
    const out = formatMoney(100000, 'USD');
    expect(out).toBe('USD 100.000');
    expect(out).not.toContain('$');
  });

  it('renders ARS (and unknown/null currency) with the peso sign', () => {
    expect(formatMoney(50000, 'ARS')).toBe('$50.000');
    expect(formatMoney(50000, null)).toBe('$50.000');
    expect(formatMoney(50000, undefined)).toBe('$50.000');
  });

  it('USD amounts of any size never contain "$"', () => {
    for (const n of [1, 3, 5000, 120000, 1_000_000]) {
      expect(formatMoney(n, 'USD')).not.toContain('$');
    }
  });
});
