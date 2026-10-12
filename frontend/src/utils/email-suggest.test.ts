import { describe, it, expect } from 'vitest';
import { suggestEmailFix } from './email-suggest';

describe('suggestEmailFix', () => {
  it.each([
    ['juan@gmial.com', 'juan@gmail.com'],
    ['juan@gmail.con', 'juan@gmail.com'],
    ['juan@gmai.com', 'juan@gmail.com'],
    ['juan@gmail.co', 'juan@gmail.com'],
    ['juan@hotmal.com', 'juan@hotmail.com'],
    ['juan@hotmail.con.ar', 'juan@hotmail.com.ar'],
    ['juan@outlok.com', 'juan@outlook.com'],
    ['juan@yaho.com.ar', 'juan@yahoo.com.ar'],
    ['juan@gmail.com.ar', 'juan@gmail.com'],
    ['  Juan@GMIAL.com ', 'juan@gmail.com'],
  ])('%s → %s', (input, expected) => {
    expect(suggestEmailFix(input)).toBe(expected);
  });

  it.each([
    'juan@gmail.com',
    'juan@hotmail.com.ar',
    'juan@yahoo.com.ar',
    'juan@me.com',
    'juan@agroferreyra.com.ar', // dominio propio: nada parecido
    'juan@inta.gob.ar',
    'juan', 'juan@', '@gmail.com', '',
  ])('%s → sin sugerencia', (input) => {
    expect(suggestEmailFix(input)).toBeNull();
  });
});
