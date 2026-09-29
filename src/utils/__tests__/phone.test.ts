/**
 * Casos canónicos de teléfono + PARIDAD con el espejo SQL.
 *
 * La tabla `CASES` es la misma para los dos lados: si alguien toca
 * `normalizePhone()` sin tocar `canonical_phone_ar()` (migración 122), o al
 * revés, este archivo falla. Mismo contrato que el test de paridad de
 * entity-matcher.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePhone, looksLikePhone, formatPhoneAR, samePhone } from '../phone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** [entrada, canónica esperada] — la MISMA tabla corre contra JS y contra SQL. */
const CASES: [string | null, string | null][] = [
  // Lo que manda Meta: ya es canónico.
  ['5492364469135', '5492364469135'],
  // Lo que dejaba el OTP web (con + y, peor, sin el 9 de celular).
  ['+5492364469135', '5492364469135'],
  ['+542364469135', '5492364469135'],
  ['542364469135', '5492364469135'],
  // Nacional pelado.
  ['2364469135', '5492364469135'],
  // "15" doméstico con característica de 4 dígitos.
  ['02364 15 469135', '5492364469135'],
  ['2364 15-469135', '5492364469135'],
  // Capital: característica de 2 dígitos.
  ['+54 9 11 1234 5678', '5491112345678'],
  ['11 2345 6789', '5491123456789'],
  ['011 15 2345 6789', '5491123456789'],
  // Característica de 3 dígitos.
  ['0221 15 4123456', '5492214123456'],
  ['221 15 4123456', '5492214123456'],
  ['2214123456', '5492214123456'],
  ['+54 9 351 234 5678', '5493512345678'],
  ['0351 15 2345678', '5493512345678'],
  // Prefijo internacional 00.
  ['00549 2364 469135', '5492364469135'],
  // El placeholder de Telegram es identidad, no teléfono: vuelve intacto.
  ['tg_123456789', 'tg_123456789'],
  // Nada afirmable → null. NUNCA se inventa un número.
  ['', null],
  ['   ', null],
  ['hola', null],
  ['12345', null],
  ['549236446913599999', null],
  [null, null],
];

describe('normalizePhone', () => {
  for (const [raw, expected] of CASES) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizePhone(raw)).toBe(expected);
    });
  }

  it('es idempotente: normalizar lo ya canónico no lo cambia', () => {
    for (const [, expected] of CASES) {
      if (expected === null) continue;
      expect(normalizePhone(expected)).toBe(expected);
    }
  });

  it('el bug de prod: el número del OTP web y el del webhook son el MISMO usuario', () => {
    // `normalizeArPhone` guardaba esto; Meta manda lo otro. Comparados exacto
    // no coincidían nunca y el usuario recibía "creá tu cuenta" para siempre.
    expect(samePhone('+542364469135', '5492364469135')).toBe(true);
  });
});

describe('looksLikePhone', () => {
  it('acepta un número escrito como lo escribe una persona', () => {
    expect(looksLikePhone('11 2345 6789')).toBe(true);
    expect(looksLikePhone('+54 9 2364 46-9135')).toBe(true);
    expect(looksLikePhone('(0221) 15 4123456')).toBe(true);
  });

  it('rechaza texto con letras — "lote 15" no es un teléfono', () => {
    expect(looksLikePhone('lote 15')).toBe(false);
    expect(looksLikePhone('el sábado')).toBe(false);
    expect(looksLikePhone('después te digo')).toBe(false);
  });

  it('rechaza números que no llegan a un celular argentino', () => {
    expect(looksLikePhone('12345')).toBe(false);
    expect(looksLikePhone('100')).toBe(false);
  });
});

describe('formatPhoneAR', () => {
  it('muestra legible sin perder la identidad', () => {
    // Sin agrupar la parte nacional: la característica es de 2, 3 o 4 dígitos
    // y adivinarla muestra el número cortado en el lugar equivocado.
    expect(formatPhoneAR('5492364469135')).toBe('+54 9 2364469135');
    expect(formatPhoneAR('5491123456789')).toBe('+54 9 1123456789');
  });
  it('vacío y placeholder no explotan', () => {
    expect(formatPhoneAR(null)).toBe('');
    expect(formatPhoneAR('tg_99')).toBe('tg_99');
  });
});

// --- Paridad con el espejo SQL (requiere DB) --------------------------------

let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[phone.test] DB no disponible — paridad SQL salteada');
}

describe.skipIf(!dbAvailable)('canonical_phone_ar (espejo SQL) coincide con normalizePhone', () => {
  beforeAll(async () => {
    // Se aplica SOLO la función, no el DO block: el test no toca `users`.
    const sqlFile = path.resolve(__dirname, '../../migrations/122_users_phone_canonical.sql');
    const sql = readFileSync(sqlFile, 'utf8');
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION');
    const end = sql.indexOf('-- Normalización de las filas existentes');
    await pool.query(sql.slice(start, end));
  });

  afterAll(async () => { await pool.end?.().catch(() => {}); });

  for (const [raw, expected] of CASES) {
    it(`SQL ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, async () => {
      const { rows } = await pool.query('SELECT canonical_phone_ar($1) AS v', [raw]);
      expect(rows[0].v ?? null).toBe(expected);
    });
  }
});
