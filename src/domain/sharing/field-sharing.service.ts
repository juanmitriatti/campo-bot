import crypto from 'crypto';
import { pool, withTransaction } from '../../config/db.js';
import { PlanRepository } from '../billing/plan.repository.js';
import { ensureOwnerMembership, canAccessField } from '../shared/field-access.js';
import { accessibleFieldsSql } from '../shared/accessible-fields.js';
import { normalizePhone, formatPhoneAR, isTelegramPlaceholder } from '../../utils/phone.js';
import { invalidateUserContext } from '../../ai/user-context.service.js';
import type { UserId } from '../../types/index.js';

export interface FieldMember {
  id: number;
  field_id: number;
  user_id: number;
  role: 'owner' | 'member';
  invited_by: number | null;
  created_at: Date;
  user_name: string | null;
  phone_number: string;
}

export class FieldSharingService {
  private planRepo: PlanRepository;

  constructor(planRepo?: PlanRepository) {
    this.planRepo = planRepo ?? new PlanRepository();
  }

  /**
   * Foundation query: returns all field IDs accessible to a user
   * (owned + shared via field_members).
   */
  async getAccessibleFieldIds(userId: UserId): Promise<number[]> {
    const { rows } = await pool.query(
      `SELECT id FROM (${accessibleFieldsSql(1)}) AS acc(id)`,
      [userId]
    );
    return rows.map((r: { id: number }) => r.id);
  }

  /**
   * Quick membership check.
   */
  async isFieldAccessible(userId: UserId, fieldId: number): Promise<boolean> {
    // Miraba SOLO `field_members`. El dueño aparece ahí únicamente porque
    // `getOrCreateField` le inserta la fila owner, o sea que el acceso a los
    // propios datos dependía de un efecto colateral.
    return canAccessField(Number(userId), fieldId);
  }

  /**
   * Returns the user's role on a field, or null if no access.
   */
  async getFieldRole(userId: UserId, fieldId: number): Promise<'owner' | 'member' | null> {
    // El dueño por `fields.user_id` cuenta como owner aunque le falte la fila
    // de membresía: si no, un campo creado por un camino que no la inserta deja
    // a su dueño sin poder compartirlo ni borrarlo.
    const { rows } = await pool.query(
      `SELECT CASE
                WHEN f.user_id = $1 THEN 'owner'
                ELSE fm.role
              END AS role
         FROM fields f
         LEFT JOIN field_members fm ON fm.field_id = f.id AND fm.user_id = $1
        WHERE f.id = $2 AND f.deleted_at IS NULL
          AND (f.user_id = $1 OR fm.user_id IS NOT NULL)`,
      [userId, fieldId]
    );
    if (rows.length === 0) return null;
    return rows[0].role;
  }

  /**
   * List all members of a field.
   */
  async listMembers(userId: UserId, fieldId: number): Promise<FieldMember[]> {
    // Verify caller has access
    const hasAccess = await this.isFieldAccessible(userId, fieldId);
    if (!hasAccess) return [];

    const { rows } = await pool.query(
      `SELECT fm.*, u.name as user_name, u.phone_number
       FROM field_members fm
       JOIN users u ON fm.user_id = u.id
       WHERE fm.field_id = $1
       ORDER BY fm.role DESC, fm.created_at ASC`,
      [fieldId]
    );
    return rows;
  }

  /**
   * Fila `owner` de un campo recién creado. Delega en la fuente única
   * (`domain/shared/field-access.ts`) — el INSERT estaba duplicado acá y
   * dentro de `getOrCreateField`, y esta copia no la llamaba nadie.
   */
  async ensureOwnerMembership(userId: UserId, fieldId: number): Promise<void> {
    await ensureOwnerMembership(Number(userId), fieldId);
  }

  /**
   * Check if the user is the owner of a field (for destructive ops).
   */
  async isOwner(userId: UserId, fieldId: number): Promise<boolean> {
    const role = await this.getFieldRole(userId, fieldId);
    return role === 'owner';
  }

  // --- Invite code flow ---

  /** 6-char uppercase alphanumeric, excluding ambiguous chars (0,O,1,I,L) */
  private generateCode(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(6);
    return Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');
  }

  /**
   * Create a shareable invite code for a field.
   * Validates owner role + enterprise plan.
   */
  async createInvite(
    ownerUserId: UserId,
    fieldId: number,
    opts: { phone?: string | null; channel?: string | null } = {}
  ): Promise<{
    success: boolean;
    message: string;
    code?: string;
    invitedPhone?: string | null;
    invitedUserId?: number | null;
    expiresAt?: Date;
  }> {
    const role = await this.getFieldRole(ownerUserId, fieldId);
    if (role !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede compartirlo.' };
    }

    // Teléfono CANÓNICO o nada. Guardar lo que tipeó el usuario haría que la
    // validación al redimir no matchee nunca (ver src/utils/phone.ts).
    let invitedPhone: string | null = null;
    if (opts.phone != null && String(opts.phone).trim() !== '') {
      invitedPhone = normalizePhone(opts.phone);
      if (!invitedPhone) {
        return {
          success: false,
          message: `No pude leer el número *${opts.phone}*. Mandámelo con característica, por ejemplo 11 2345 6789.`,
        };
      }

      // El dueño invitándose a sí mismo.
      const { rows: self } = await pool.query(
        `SELECT 1 FROM users
          WHERE id = $1 AND (phone_number = $2 OR canonical_phone_ar(phone_number) = $2)`,
        [ownerUserId, invitedPhone]
      );
      if (self.length > 0) {
        return { success: false, message: 'Ese es tu propio número — ya tenés acceso al campo.' };
      }

      // Ya es miembro: no tiene sentido emitir una invitación.
      const { rows: already } = await pool.query(
        `SELECT u.name FROM field_members fm
           JOIN users u ON u.id = fm.user_id
          WHERE fm.field_id = $1
            AND (u.phone_number = $2 OR canonical_phone_ar(u.phone_number) = $2)`,
        [fieldId, invitedPhone]
      );
      if (already.length > 0) {
        return {
          success: false,
          message: `${already[0].name || formatPhoneAR(invitedPhone)} ya tiene acceso a este campo.`,
        };
      }
    }

    // Si el invitado YA tiene cuenta, se deja resuelto: al redimir se compara
    // por id y no depende de que el teléfono siga escrito igual.
    let invitedUserId: number | null = null;
    if (invitedPhone) {
      const { rows } = await pool.query(
        `SELECT id FROM users
          WHERE (phone_number = $1 OR canonical_phone_ar(phone_number) = $1)
            AND deleted_at IS NULL
          LIMIT 1`,
        [invitedPhone]
      );
      invitedUserId = rows[0]?.id ?? null;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.generateCode();
      try {
        // Revocar la invitación viva anterior para el mismo (campo, teléfono)
        // ANTES de insertar: el índice único parcial la rechazaría, y además
        // es lo que hace que "reenviar" no deje dos códigos válidos sueltos.
        const { rows } = await withTransaction(async () => {
          if (invitedPhone) {
            await pool.query(
              `UPDATE field_invites
                  SET revoked_at = NOW(), revoked_by = $1
                WHERE field_id = $2 AND invited_phone = $3
                  AND used_by IS NULL AND revoked_at IS NULL`,
              [ownerUserId, fieldId, invitedPhone]
            );
          }
          const res = await pool.query(
            `INSERT INTO field_invites
               (field_id, code, created_by, expires_at, invited_phone, invited_user_id, role, channel)
             VALUES ($1, $2, $3, NOW() + INTERVAL '7 days', $4, $5, 'member', $6)
             RETURNING expires_at`,
            [fieldId, code, ownerUserId, invitedPhone, invitedUserId, opts.channel ?? 'wa_link']
          );
          return res;
        });

        return {
          success: true,
          message: '',
          code,
          invitedPhone,
          invitedUserId,
          expiresAt: rows[0]?.expires_at,
        };
      } catch (err: unknown) {
        const e = err as { code?: string; constraint?: string };
        // Colisión del código de 6 caracteres → otro intento.
        if (e.code === '23505' && e.constraint?.includes('code')) continue;
        throw err;
      }
    }
    return { success: false, message: 'No se pudo generar el código. Intentá de nuevo.' };
  }

  /** Revoca una invitación viva. Solo el dueño del campo. */
  async revokeInvite(
    ownerUserId: UserId,
    inviteId: number
  ): Promise<{ success: boolean; message: string }> {
    const { rows } = await pool.query(
      `SELECT field_id, used_by, revoked_at FROM field_invites WHERE id = $1`,
      [inviteId]
    );
    if (rows.length === 0) {
      return { success: false, message: 'No encontré esa invitación.' };
    }
    const invite = rows[0];
    if ((await this.getFieldRole(ownerUserId, invite.field_id)) !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede revocar invitaciones.' };
    }
    if (invite.used_by != null) {
      return {
        success: false,
        message: 'Esa invitación ya fue usada. Para sacarle el acceso, quitá a la persona del campo.',
      };
    }
    // Revocar dos veces no es un error: el resultado es el mismo.
    if (invite.revoked_at != null) {
      return { success: true, message: 'La invitación ya estaba revocada.' };
    }
    await pool.query(
      `UPDATE field_invites SET revoked_at = NOW(), revoked_by = $1 WHERE id = $2`,
      [ownerUserId, inviteId]
    );
    return { success: true, message: 'Invitación revocada.' };
  }

  /**
   * Accept an invite code. Validates code, expiry, usage, self-invite, existing membership.
   */
  async acceptInvite(
    userId: UserId,
    code: string
  ): Promise<{ success: boolean; message: string; fieldName?: string; reason?: 'needs_phone' }> {
    const upperCode = code.toUpperCase().trim();

    const { rows } = await pool.query(
      `SELECT fi.*, f.name as field_name
       FROM field_invites fi
       JOIN fields f ON fi.field_id = f.id
       WHERE fi.code = $1`,
      [upperCode]
    );

    if (rows.length === 0) {
      return { success: false, message: `No encontré la invitación con código *${upperCode}*. Verificá que esté bien escrito.` };
    }

    const invite = rows[0];

    if (invite.used_by != null) {
      return { success: false, message: 'Este código ya fue utilizado.' };
    }

    if (invite.revoked_at != null) {
      return { success: false, message: 'Esta invitación fue cancelada. Pedile al dueño que te mande una nueva.' };
    }

    if (new Date(invite.expires_at) < new Date()) {
      return { success: false, message: 'Este código de invitación expiró. Pedile al dueño que genere uno nuevo.' };
    }

    if (invite.created_by === userId) {
      return { success: false, message: 'No podés usar tu propio código de invitación.' };
    }

    // Invitación ATADA a un número: solo esa persona la puede usar. Sin esto el
    // código de 6 caracteres es una llave al portador — reenviado por error o
    // leído por encima del hombro, entra cualquiera.
    // `invited_phone` NULL = código abierto (comportamiento legacy).
    if (invite.invited_phone != null) {
      const { rows: me } = await pool.query(
        `SELECT phone_number FROM users WHERE id = $1`,
        [userId]
      );
      const rawPhone: string | null = me[0]?.phone_number ?? null;
      const myPhone = rawPhone && !isTelegramPlaceholder(rawPhone) ? normalizePhone(rawPhone) : null;
      const matchesPhone = myPhone != null && myPhone === invite.invited_phone;
      const matchesUser = invite.invited_user_id != null && Number(invite.invited_user_id) === Number(userId);
      // Cuenta sin WhatsApp (creada por la web, o solo Telegram): no es "otro
      // número", todavía no hay número con qué comparar. Decirle "esta invitación
      // es para +54 9 …" a la persona correcta la mandaba a pedir otra.
      if (myPhone == null && !matchesUser) {
        console.log(`[SHARING] invite ${invite.code} en espera: user=${userId} sin WhatsApp vinculado`);
        return {
          success: false,
          reason: 'needs_phone',
          message: 'Para entrar al campo primero vinculá tu WhatsApp (Mi cuenta → Vincular WhatsApp). Apenas lo vincules, la invitación se acepta sola.',
        };
      }
      if (!matchesPhone && !matchesUser) {
        console.log(
          `[SHARING] invite ${invite.code} rechazada: destinada a ${invite.invited_phone}, la usó user=${userId} (${myPhone ?? 'sin teléfono'})`,
        );
        return {
          success: false,
          message: `Esta invitación es para el número *${formatPhoneAR(invite.invited_phone)}*. Pedile al dueño que te mande una a tu número.`,
        };
      }
    }

    // Check if already a member
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM field_members WHERE field_id = $1 AND user_id = $2`,
      [invite.field_id, userId]
    );
    if (existing.length > 0) {
      return { success: false, message: `Ya tenés acceso al campo *${invite.field_name}*.` };
    }

    // Transaction: add member + mark code used
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)`,
        [invite.field_id, userId, invite.role ?? 'member', invite.created_by]
      );
      await client.query(
        `UPDATE field_invites SET used_by = $1, used_at = NOW() WHERE id = $2`,
        [userId, invite.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // El contexto del agente cachea 60 s las listas de campos y lotes. Sin
    // invalidarlo, durante el primer minuto el bot no reconoce el campo recién
    // compartido y el validador anti-alucinación STRIPEA el lote que el usuario
    // nombra — la actividad se pierde en silencio.
    invalidateUserContext(Number(userId));

    return {
      success: true,
      message: `Ahora tenés acceso al campo *${invite.field_name}*.`,
      fieldName: invite.field_name,
    };
  }

  /**
   * Remove a member by name or phone. Tries phone lookup first, then name within field members.
   */
  async removeMemberByIdentifier(
    ownerUserId: UserId,
    fieldId: number,
    identifier: string
  ): Promise<{ success: boolean; message: string }> {
    const role = await this.getFieldRole(ownerUserId, fieldId);
    if (role !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede quitar miembros.' };
    }

    // Try phone, email, or name lookup
    let target: { id: number; name: string | null; phone_number: string } | null = null;
    const trimmed = identifier.trim();
    const looksLikeEmail = /@/.test(trimmed);
    if (looksLikeEmail) {
      const { rows: emailRows } = await pool.query(
        `SELECT id, name, phone_number FROM users WHERE LOWER(email) = LOWER($1)`,
        [trimmed]
      );
      if (emailRows.length > 0) target = emailRows[0];
    }
    // Teléfono en forma canónica (utils/phone.ts ↔ canonical_phone_ar) y solo
    // entre los miembros de ESTE campo. Comparar el texto tal cual hacía que
    // "quitar a 11 2345 6789" no encontrara nunca a nadie (en la DB es 549…).
    const canonicalPhone = looksLikeEmail ? null : normalizePhone(trimmed);
    if (!target && canonicalPhone) {
      const { rows: phoneRows } = await pool.query(
        `SELECT u.id, u.name, u.phone_number
         FROM field_members fm
         JOIN users u ON fm.user_id = u.id
         WHERE fm.field_id = $1 AND canonical_phone_ar(u.phone_number) = $2`,
        [fieldId, canonicalPhone]
      );
      if (phoneRows.length > 0) target = phoneRows[0];
    }
    if (!target) {
      // Try name lookup within field members
      const { rows: nameRows } = await pool.query(
        `SELECT u.id, u.name, u.phone_number
         FROM field_members fm
         JOIN users u ON fm.user_id = u.id
         WHERE fm.field_id = $1 AND LOWER(u.name) = LOWER($2) AND fm.role = 'member'`,
        [fieldId, trimmed]
      );
      if (nameRows.length > 0) target = nameRows[0];
    }

    if (!target) {
      return { success: false, message: `No encontré un miembro con "${identifier}" en este campo.` };
    }

    if (target.id === ownerUserId) {
      return { success: false, message: 'No podés quitarte a vos mismo como dueño del campo.' };
    }

    const { rowCount } = await pool.query(
      `DELETE FROM field_members WHERE field_id = $1 AND user_id = $2 AND role = 'member'`,
      [fieldId, target.id]
    );
    if (rowCount === 0) {
      return { success: false, message: `${target.name || identifier} no es miembro de este campo.` };
    }

    return { success: true, message: `${target.name || identifier} ya no tiene acceso al campo.` };
  }

  // --- Listados para el tab "Compartir" del dashboard ---

  /**
   * El estado de una invitación es DERIVADO, y se deriva en UN solo lugar.
   * Una columna `status` habría que mantenerla sincronizada con `used_by`,
   * `revoked_at` y el reloj — tres fuentes para el mismo hecho.
   */
  private static readonly STATUS_SQL = `
    CASE
      WHEN fi.used_by IS NOT NULL  THEN 'used'
      WHEN fi.revoked_at IS NOT NULL THEN 'revoked'
      WHEN fi.expires_at < NOW()   THEN 'expired'
      ELSE 'pending'
    END`;

  /** Campos que YO comparto, con sus miembros y sus invitaciones. */
  async listSharedByMe(userId: UserId): Promise<Array<{
    fieldId: number;
    fieldName: string;
    members: Array<{ userId: number; name: string | null; phone: string | null; role: string; since: Date }>;
    invites: Array<{ id: number; code: string; phone: string | null; status: string; expiresAt: Date; createdAt: Date }>;
  }>> {
    const { rows: fields } = await pool.query(
      `SELECT f.id, f.name
         FROM fields f
        WHERE f.user_id = $1 AND f.deleted_at IS NULL
        ORDER BY f.name`,
      [userId]
    );
    if (fields.length === 0) return [];
    const ids = fields.map((f: { id: number }) => f.id);

    const { rows: members } = await pool.query(
      `SELECT fm.field_id, fm.user_id, fm.role, fm.created_at,
              u.name, u.phone_number
         FROM field_members fm
         JOIN users u ON u.id = fm.user_id
        WHERE fm.field_id = ANY($1::int[]) AND fm.user_id <> $2
        ORDER BY fm.created_at`,
      [ids, userId]
    );

    const { rows: invites } = await pool.query(
      `SELECT fi.id, fi.field_id, fi.code, fi.invited_phone, fi.expires_at, fi.created_at,
              ${FieldSharingService.STATUS_SQL} AS status
         FROM field_invites fi
        WHERE fi.field_id = ANY($1::int[])
        ORDER BY fi.created_at DESC`,
      [ids]
    );

    return fields.map((f: { id: number; name: string }) => ({
      fieldId: f.id,
      fieldName: f.name,
      members: members
        .filter((m: { field_id: number }) => m.field_id === f.id)
        .map((m: Record<string, unknown>) => ({
          userId: Number(m.user_id),
          name: (m.name as string) ?? null,
          phone: (m.phone_number as string) ?? null,
          role: String(m.role),
          since: m.created_at as Date,
        })),
      invites: invites
        .filter((i: { field_id: number }) => i.field_id === f.id)
        .map((i: Record<string, unknown>) => ({
          id: Number(i.id),
          code: String(i.code),
          phone: (i.invited_phone as string) ?? null,
          status: String(i.status),
          expiresAt: i.expires_at as Date,
          createdAt: i.created_at as Date,
        })),
    }));
  }

  /** Campos que OTROS comparten conmigo. */
  async listSharedWithMe(userId: UserId): Promise<Array<{
    fieldId: number;
    fieldName: string;
    role: string;
    since: Date;
    ownerName: string | null;
    ownerPhone: string | null;
  }>> {
    const { rows } = await pool.query(
      `SELECT f.id AS field_id, f.name AS field_name, fm.role, fm.created_at,
              owner.name AS owner_name, owner.phone_number AS owner_phone
         FROM field_members fm
         JOIN fields f ON f.id = fm.field_id
         LEFT JOIN users owner ON owner.id = f.user_id
        WHERE fm.user_id = $1
          AND f.user_id <> $1
          AND f.deleted_at IS NULL
        ORDER BY f.name`,
      [userId]
    );
    return rows.map((r: Record<string, unknown>) => ({
      fieldId: Number(r.field_id),
      fieldName: String(r.field_name),
      role: String(r.role),
      since: r.created_at as Date,
      ownerName: (r.owner_name as string) ?? null,
      ownerPhone: (r.owner_phone as string) ?? null,
    }));
  }

  /** Salir de un campo compartido por decisión propia. El dueño no puede. */
  async leaveField(userId: UserId, fieldId: number): Promise<{ success: boolean; message: string }> {
    const { rows } = await pool.query(
      `SELECT user_id FROM fields WHERE id = $1 AND deleted_at IS NULL`,
      [fieldId]
    );
    if (rows.length === 0) return { success: false, message: 'Campo no encontrado.' };
    if (Number(rows[0].user_id) === Number(userId)) {
      return { success: false, message: 'Es tu campo: no podés salir de él. Podés borrarlo o quitar a los miembros.' };
    }
    const { rowCount } = await pool.query(
      `DELETE FROM field_members WHERE field_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [fieldId, userId]
    );
    if (rowCount === 0) return { success: false, message: 'No sos miembro de ese campo.' };
    invalidateUserContext(Number(userId));
    return { success: true, message: 'Saliste del campo.' };
  }

  /** Quitar a un miembro por su user id (el camino del dashboard). */
  async removeMemberById(
    ownerUserId: UserId,
    fieldId: number,
    memberUserId: number
  ): Promise<{ success: boolean; message: string }> {
    if ((await this.getFieldRole(ownerUserId, fieldId)) !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede quitar miembros.' };
    }
    if (Number(memberUserId) === Number(ownerUserId)) {
      return { success: false, message: 'No podés quitarte a vos mismo como dueño del campo.' };
    }
    const { rowCount } = await pool.query(
      `DELETE FROM field_members WHERE field_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [fieldId, memberUserId]
    );
    if (rowCount === 0) return { success: false, message: 'Esa persona no es miembro del campo.' };
    // El que pierde el acceso también tiene el contexto cacheado 60 s.
    invalidateUserContext(Number(memberUserId));
    return { success: true, message: 'Listo, ya no tiene acceso al campo.' };
  }
}
