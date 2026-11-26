import { describe, it, expect } from 'vitest';
import { parseNumberAR } from './parse-number';

describe('parseNumberAR', () => {
  it.each([
    ['80,5', 80.5],
    ['80.5', 80.5],
    ['1.500', 1500],
    ['1.500.000', 1500000],
    ['1.500,50', 1500.5],
    ['1500', 1500],
    ['0,5', 0.5],
    ['0.500', 0.5],
    [' $ 2.300 ', 2300],
    ['28.500', 28500],
  ])('%s → %s', (input, expected) => {
    expect(parseNumberAR(input)).toBe(expected);
  });

  it.each(['', '  ', 'abc', '1,2,3', '12a', '--5'])('"%s" no es un número', (input) => {
    expect(parseNumberAR(input)).toBeNull();
  });
});
