/**
 * Invitación a un campo compartido, contra la DB real.
 *
 * Lo que se prueba acá no se puede verificar a nivel unitario: que el código de
 * 6 caracteres deje de ser una LLAVE AL PORTADOR. Antes, cualquiera que viera
 * el código entraba al campo — y el dueño lo manda por WhatsApp, donde queda
 * reenviable para siempre.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let dbAvailable = true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;
try {
  const mod = await import('../../../config/db.js');
  pool = mod.pool;
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
  console.warn('[sharing.integration] DB no disponible — suite salteada');
}

const OWNER_PHONE = '5492364470001';
const GUEST_PHONE = '5492364470002';
const OTHER_PHONE = '5492364470003';
const PHONE_RE = '236447000[1-9]$';

describe.skipIf(!dbAvailable)('FieldSharingService — invitación atada a un teléfono', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let svc: any;
  let ownerId: number;
  let guestId: number;
  let otherId: number;
  let fieldId: number;

  async function wipe() {
    await pool.query(
      `DELETE FROM field_invites WHERE field_id IN (SELECT id FROM fields WHERE name = 'Campo Invite Test')`,
    ).catch(() => {});
    await pool.query(
      `DELETE FROM field_members WHERE field_id IN (SELECT id FROM fields WHERE name = 'Campo Invite Test')`,
    ).catch(() => {});
    await pool.query(`DELETE FROM fields WHERE name = 'Campo Invite Test'`).catch(() => {});
    await pool.query(
      `DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE phone_number ~ $1)`,
      [PHONE_RE],
    ).catch(() => {});
    await pool.query(`DELETE FROM users WHERE phone_number ~ $1`, [PHONE_RE]).catch(() => {});
  }

  async function mkUser(phone: string, name: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO users (phone_number, name, whatsapp_verified_at)
       VALUES ($1, $2, NOW()) RETURNING id`,
      [phone, name],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    const { FieldSharingService } = await import('../field-sharing.service.js');
    svc = new FieldSharingService();
    await wipe();
  });

  afterAll(wipe);

  beforeEach(async () => {
    await wipe();
    ownerId = await mkUser(OWNER_PHONE, 'Dueño');
    guestId = await mkUser(GUEST_PHONE, 'Invitado');
    otherId = await mkUser(OTHER_PHONE, 'Colado');
    const { rows } = await pool.query(
      `INSERT INTO fields (user_id, name) VALUES ($1, 'Campo Invite Test') RETURNING id`,
      [ownerId],
    );
    fieldId = rows[0].id;
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2)`,
      [fieldId, ownerId],
    );
  });

  it('el número invitado la redime', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    expect(inv.success).toBe(true);
    expect(inv.invitedPhone).toBe(GUEST_PHONE);

    const res = await svc.acceptInvite(guestId, inv.code);
    expect(res.success).toBe(true);
    expect(res.fieldName).toBe('Campo Invite Test');
  });

  it('OTRO número con el mismo código NO entra', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    const res = await svc.acceptInvite(otherId, inv.code);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/es para el número/i);

    const { rows } = await pool.query(
      `SELECT 1 FROM field_members WHERE field_id = $1 AND user_id = $2`,
      [fieldId, otherId],
    );
    expect(rows).toHaveLength(0);
  });

  it('el usuario acepta el número escrito de cualquier forma: se guarda canónico', async () => {
    // El dueño lo tipea como se lo dictaron.
    const inv = await svc.createInvite(ownerId, fieldId, { phone: '0236 15 4470002' });
    expect(inv.success).toBe(true);
    expect(inv.invitedPhone).toBe(GUEST_PHONE);
    const res = await svc.acceptInvite(guestId, inv.code);
    expect(res.success).toBe(true);
  });

  it('reenviar revoca la invitación anterior: no quedan dos códigos vivos', async () => {
    const first = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    const second = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    expect(second.success).toBe(true);
    expect(second.code).not.toBe(first.code);

    const stale = await svc.acceptInvite(guestId, first.code);
    expect(stale.success).toBe(false);
    expect(stale.message).toMatch(/cancelada/i);

    const ok = await svc.acceptInvite(guestId, second.code);
    expect(ok.success).toBe(true);
  });

  it('una invitación revocada no se redime', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    const { rows } = await pool.query(`SELECT id FROM field_invites WHERE code = $1`, [inv.code]);
    const revoked = await svc.revokeInvite(ownerId, rows[0].id);
    expect(revoked.success).toBe(true);

    const res = await svc.acceptInvite(guestId, inv.code);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/cancelada/i);
  });

  it('revocar dos veces no es un error — el resultado es el mismo', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    const { rows } = await pool.query(`SELECT id FROM field_invites WHERE code = $1`, [inv.code]);
    expect((await svc.revokeInvite(ownerId, rows[0].id)).success).toBe(true);
    expect((await svc.revokeInvite(ownerId, rows[0].id)).success).toBe(true);
  });

  it('una invitación vencida no se redime', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    await pool.query(
      `UPDATE field_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE code = $1`,
      [inv.code],
    );
    const res = await svc.acceptInvite(guestId, inv.code);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/expir/i);
  });

  it('un código ABIERTO (sin teléfono) lo sigue redimiendo cualquiera', async () => {
    // Comportamiento legacy: los invites viejos no tienen `invited_phone`.
    const inv = await svc.createInvite(ownerId, fieldId, {});
    expect(inv.invitedPhone).toBeNull();
    const res = await svc.acceptInvite(otherId, inv.code);
    expect(res.success).toBe(true);
  });

  it('un MIEMBRO no puede compartir el campo', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    await svc.acceptInvite(guestId, inv.code);
    const asMember = await svc.createInvite(guestId, fieldId, { phone: OTHER_PHONE });
    expect(asMember.success).toBe(false);
    expect(asMember.message).toMatch(/dueño/i);
  });

  it('no se invita a alguien que ya es miembro', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    await svc.acceptInvite(guestId, inv.code);
    const again = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    expect(again.success).toBe(false);
    expect(again.message).toMatch(/ya tiene acceso/i);
  });

  it('el dueño no se invita a sí mismo', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: OWNER_PHONE });
    expect(inv.success).toBe(false);
    expect(inv.message).toMatch(/tu propio número/i);
  });

  it('un número ilegible se rechaza con el motivo, no se guarda basura', async () => {
    const inv = await svc.createInvite(ownerId, fieldId, { phone: 'el de siempre' });
    expect(inv.success).toBe(false);
    expect(inv.message).toMatch(/no pude leer/i);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM field_invites WHERE field_id = $1`, [fieldId]);
    expect(rows[0].n).toBe(0);
  });

  it('el dueño de un campo SIN fila de membresía puede compartirlo igual', async () => {
    // La fila `owner` se crea como efecto colateral de `getOrCreateField`; el
    // permiso no puede depender de que ese insert haya corrido.
    await pool.query(`DELETE FROM field_members WHERE field_id = $1 AND user_id = $2`, [fieldId, ownerId]);
    const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
    expect(inv.success).toBe(true);
  });

  describe('listados del tab', () => {
    it('listSharedByMe trae miembros e invitaciones con su estado', async () => {
      const used = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
      await svc.acceptInvite(guestId, used.code);
      await svc.createInvite(ownerId, fieldId, { phone: OTHER_PHONE });

      const list = await svc.listSharedByMe(ownerId);
      const campo = list.find((f: { fieldName: string }) => f.fieldName === 'Campo Invite Test');
      expect(campo.members).toHaveLength(1);
      expect(campo.members[0].name).toBe('Invitado');
      const statuses = campo.invites.map((i: { status: string }) => i.status).sort();
      expect(statuses).toEqual(['pending', 'used']);
    });

    it('listSharedWithMe muestra el campo y de quién es', async () => {
      const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
      await svc.acceptInvite(guestId, inv.code);

      const mine = await svc.listSharedWithMe(guestId);
      expect(mine).toHaveLength(1);
      expect(mine[0].fieldName).toBe('Campo Invite Test');
      expect(mine[0].ownerName).toBe('Dueño');

      // El dueño no ve su propio campo como "compartido conmigo".
      expect(await svc.listSharedWithMe(ownerId)).toHaveLength(0);
    });

    it('el miembro puede salir; el dueño no', async () => {
      const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
      await svc.acceptInvite(guestId, inv.code);

      expect((await svc.leaveField(ownerId, fieldId)).success).toBe(false);
      expect((await svc.leaveField(guestId, fieldId)).success).toBe(true);
      expect(await svc.listSharedWithMe(guestId)).toHaveLength(0);
    });

    it('el dueño quita a un miembro por id', async () => {
      const inv = await svc.createInvite(ownerId, fieldId, { phone: GUEST_PHONE });
      await svc.acceptInvite(guestId, inv.code);

      // Un miembro no puede echar a otro.
      expect((await svc.removeMemberById(guestId, fieldId, ownerId)).success).toBe(false);
      expect((await svc.removeMemberById(ownerId, fieldId, guestId)).success).toBe(true);
      expect(await svc.listSharedWithMe(guestId)).toHaveLength(0);
    });
  });
});
