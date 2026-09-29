/**
 * Regresión del bug de identidad por teléfono (prod, Sep 2026).
 *
 * El OTP de la web guardaba `+549...` (y a veces sin el 9 de celular) mientras
 * el webhook de WhatsApp busca con lo que manda Meta (`549...`). Como
 * `findVerifiedByPhone` comparaba con `=`, la persona que vinculaba su WhatsApp
 * desde el dashboard no volvía a ser encontrada nunca: al escribirle al bot
 * recibía "creá tu cuenta" para siempre.
 *
 * Requiere DB (la migración 122 crea `canonical_phone_ar`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[phone-lookup.integration] DB no disponible — suite salteada');
}

/** Rango de números reservado para esta suite. */
const PHONE_RE = '2364469(19[5-9])$';

describe.skipIf(!dbAvailable)('findVerifiedByPhone — identidad por teléfono', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let repo: any;

  // Se limpia por TELÉFONO, no por los ids sembrados: si el código bajo prueba
  // crea una cuenta de más (que es justamente el bug), esa fila no está entre
  // los ids sembrados y quedaría viva tapando la corrida siguiente. Pasó.
  async function wipe() {
    await pool.query(
      `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE phone_number ~ $1)`,
      [PHONE_RE],
    ).catch(() => {});
    await pool.query(`DELETE FROM users WHERE phone_number ~ $1`, [PHONE_RE]).catch(() => {});
  }

  beforeAll(async () => {
    const { UserRepository } = await import('../user.repository.js');
    repo = new UserRepository();
    await wipe();
  });

  afterAll(wipe);

  async function seedUser(stored: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO users (phone_number, name, whatsapp_verified_at)
       VALUES ($1, 'Phone Test', NOW()) RETURNING id`,
      [stored],
    );
    return rows[0].id;
  }

  it('encuentra al usuario guardado en formato LEGACY con lo que manda Meta', async () => {
    // Formato exacto que dejaba el OTP viejo: con `+` y sin el 9.
    const id = await seedUser('+542364469199');
    const found = await repo.findVerifiedByPhone('5492364469199');
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
  });

  it('encuentra al usuario ya canónico (el camino normal)', async () => {
    const id = await seedUser('5492364469198');
    const found = await repo.findVerifiedByPhone('5492364469198');
    expect(found?.id).toBe(id);
  });

  it('un número de OTRA persona no lo encuentra', async () => {
    await seedUser('5492364469197');
    const found = await repo.findVerifiedByPhone('5492364469196');
    expect(found).toBeNull();
  });

  it('getOrCreateUser NO crea una segunda cuenta para el mismo número en otro formato', async () => {
    const id = await seedUser('+542364469195');
    const { getOrCreateUser } = await import('../../../services/expenses.js');
    const row = await getOrCreateUser('5492364469195');
    expect(row.id).toBe(id);

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE phone_number ~ '2364469195$'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
