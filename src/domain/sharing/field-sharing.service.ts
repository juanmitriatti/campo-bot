import crypto from 'crypto';
import { pool } from '../../config/db.js';
import { PlanRepository } from '../billing/plan.repository.js';
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
      `SELECT field_id FROM field_members WHERE user_id = $1`,
      [userId]
    );
    return rows.map((r: { field_id: number }) => r.field_id);
  }

  /**
   * Quick membership check.
   */
  async isFieldAccessible(userId: UserId, fieldId: number): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT 1 FROM field_members WHERE user_id = $1 AND field_id = $2 LIMIT 1`,
      [userId, fieldId]
    );
    return rows.length > 0;
  }

  /**
   * Returns the user's role on a field, or null if no access.
   */
  async getFieldRole(userId: UserId, fieldId: number): Promise<'owner' | 'member' | null> {
    const { rows } = await pool.query(
      `SELECT role FROM field_members WHERE user_id = $1 AND field_id = $2`,
      [userId, fieldId]
    );
    if (rows.length === 0) return null;
    return rows[0].role;
  }

  /**
   * Invite a member to a field. Validates:
   * - Caller is owner
   * - Caller has enterprise plan
   * - Target user exists
   * - Target is not already a member
   */
  async inviteMember(
    ownerUserId: UserId,
    fieldId: number,
    targetPhone: string
  ): Promise<{ success: boolean; message: string; memberName?: string }> {
    // Check owner role
    const role = await this.getFieldRole(ownerUserId, fieldId);
    if (role !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede compartirlo.' };
    }

    // Check enterprise plan
    const plan = await this.planRepo.getUserPlan(ownerUserId);
    if (!plan || plan.name !== 'enterprise') {
      return { success: false, message: 'La función de campos compartidos está disponible solo en el plan Enterprise.' };
    }

    // Find target user
    const { rows: targetRows } = await pool.query(
      `SELECT id, name, phone_number FROM users WHERE phone_number = $1`,
      [targetPhone]
    );
    if (targetRows.length === 0) {
      return { success: false, message: `No encontré un usuario con el número ${targetPhone}. El usuario debe estar registrado en el bot.` };
    }
    const target = targetRows[0];

    // Check if already a member
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM field_members WHERE field_id = $1 AND user_id = $2`,
      [fieldId, target.id]
    );
    if (existing.length > 0) {
      return { success: false, message: `${target.name || targetPhone} ya tiene acceso a este campo.` };
    }

    // Insert membership
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'member', $3)`,
      [fieldId, target.id, ownerUserId]
    );

    return {
      success: true,
      message: `${target.name || targetPhone} ahora tiene acceso al campo.`,
      memberName: target.name || targetPhone,
    };
  }

  /**
   * Remove a member from a field. Only the owner can do this.
   * Cannot remove the owner themselves.
   */
  async removeMember(
    ownerUserId: UserId,
    fieldId: number,
    targetPhone: string
  ): Promise<{ success: boolean; message: string }> {
    // Check owner role
    const role = await this.getFieldRole(ownerUserId, fieldId);
    if (role !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede quitar miembros.' };
    }

    // Find target user
    const { rows: targetRows } = await pool.query(
      `SELECT id, name, phone_number FROM users WHERE phone_number = $1`,
      [targetPhone]
    );
    if (targetRows.length === 0) {
      return { success: false, message: `No encontré un usuario con el número ${targetPhone}.` };
    }
    const target = targetRows[0];

    // Cannot remove self (owner)
    if (target.id === ownerUserId) {
      return { success: false, message: 'No podés quitarte a vos mismo como dueño del campo.' };
    }

    // Check membership exists
    const { rowCount } = await pool.query(
      `DELETE FROM field_members WHERE field_id = $1 AND user_id = $2 AND role = 'member'`,
      [fieldId, target.id]
    );
    if (rowCount === 0) {
      return { success: false, message: `${target.name || targetPhone} no es miembro de este campo.` };
    }

    return { success: true, message: `${target.name || targetPhone} ya no tiene acceso al campo.` };
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
   * Ensure the owner has a field_members row after field creation.
   */
  async ensureOwnerMembership(userId: UserId, fieldId: number): Promise<void> {
    await pool.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by)
       VALUES ($1, $2, 'owner', $2)
       ON CONFLICT (field_id, user_id) DO NOTHING`,
      [fieldId, userId]
    );
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
    fieldId: number
  ): Promise<{ success: boolean; message: string; code?: string }> {
    const role = await this.getFieldRole(ownerUserId, fieldId);
    if (role !== 'owner') {
      return { success: false, message: 'Solo el dueño del campo puede compartirlo.' };
    }

    // Generate code with collision retry (up to 5 attempts)
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.generateCode();
      try {
        await pool.query(
          `INSERT INTO field_invites (field_id, code, created_by, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
          [fieldId, code, ownerUserId]
        );
        return { success: true, message: '', code };
      } catch (err: any) {
        // unique violation on code → retry
        if (err.code === '23505' && err.constraint?.includes('code')) continue;
        throw err;
      }
    }
    return { success: false, message: 'No se pudo generar el código. Intentá de nuevo.' };
  }

  /**
   * Accept an invite code. Validates code, expiry, usage, self-invite, existing membership.
   */
  async acceptInvite(
    userId: UserId,
    code: string
  ): Promise<{ success: boolean; message: string; fieldName?: string }> {
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

    if (new Date(invite.expires_at) < new Date()) {
      return { success: false, message: 'Este código de invitación expiró. Pedile al dueño que genere uno nuevo.' };
    }

    if (invite.created_by === userId) {
      return { success: false, message: 'No podés usar tu propio código de invitación.' };
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
        `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'member', $3)`,
        [invite.field_id, userId, invite.created_by]
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
    if (!target) {
      const { rows: phoneRows } = await pool.query(
        `SELECT id, name, phone_number FROM users WHERE phone_number = $1`,
        [trimmed]
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
}
