/**
 * Planificador de fusión de cuentas partidas por formato de teléfono.
 * Sin DB: solo la decisión de QUÉ se fusionaría y con qué sobreviviente.
 */
import { describe, it, expect } from 'vitest';
import { buildPlans, pickSurvivor, type UserRow } from '../merge-duplicate-phone-users.js';

function u(partial: Partial<UserRow> & { id: number; phone_number: string }): UserRow {
  return {
    email: null,
    name: null,
    whatsapp_verified_at: null,
    ...partial,
  };
}

describe('buildPlans', () => {
  it('agrupa el MISMO número escrito en dos formatos', () => {
    const plans = buildPlans([
      u({ id: 1, phone_number: '+542364469135' }),
      u({ id: 2, phone_number: '5492364469135' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].canonical).toBe('5492364469135');
    expect(plans[0].losers).toHaveLength(1);
  });

  it('no agrupa números distintos', () => {
    const plans = buildPlans([
      u({ id: 1, phone_number: '5492364469135' }),
      u({ id: 2, phone_number: '5492364469136' }),
    ]);
    expect(plans).toHaveLength(0);
  });

  it('ignora los placeholders de Telegram — no son teléfonos', () => {
    const plans = buildPlans([
      u({ id: 1, phone_number: 'tg_111' }),
      u({ id: 2, phone_number: 'tg_222' }),
    ]);
    expect(plans).toHaveLength(0);
  });

  it('BLOQUEA cuando los dos lados tienen email real distinto: son dos personas', () => {
    const plans = buildPlans([
      u({ id: 1, phone_number: '+542364469135', email: 'juan@x.com' }),
      u({ id: 2, phone_number: '5492364469135', email: 'pedro@x.com' }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].blocked).toBe(true);
    expect(plans[0].reason).toContain('emails distintos');
  });

  it('no bloquea cuando solo UNO tiene email (el caso típico: web + bot)', () => {
    const plans = buildPlans([
      u({ id: 1, phone_number: '+542364469135', email: 'juan@x.com' }),
      u({ id: 2, phone_number: '5492364469135' }),
    ]);
    expect(plans[0].blocked).toBe(false);
  });
});

describe('pickSurvivor', () => {
  it('gana la cuenta CON email: es con la que la persona entra al dashboard', () => {
    const s = pickSurvivor([
      u({ id: 9, phone_number: '5492364469135' }),
      u({ id: 3, phone_number: '+542364469135', email: 'juan@x.com' }),
    ]);
    expect(s.id).toBe(3);
  });

  it('entre dos con email gana la verificada más antigua', () => {
    const s = pickSurvivor([
      u({ id: 1, phone_number: 'a', email: 'a@x.com', whatsapp_verified_at: new Date('2026-05-01') }),
      u({ id: 2, phone_number: 'b', email: 'b@x.com', whatsapp_verified_at: new Date('2026-01-01') }),
    ]);
    expect(s.id).toBe(2);
  });

  it('sin email ni verificación, gana el id más bajo (la cuenta original)', () => {
    const s = pickSurvivor([
      u({ id: 7, phone_number: 'a' }),
      u({ id: 4, phone_number: 'b' }),
    ]);
    expect(s.id).toBe(4);
  });
});
