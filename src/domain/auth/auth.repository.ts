import { pool } from '../../config/db.js';
import type { AuthUser, UserRole } from './auth.types.js';

interface UserWithPassword extends AuthUser {
  password_hash: string | null;
}

// Cuentas soft-deleted quedan fuera de TODO lookup: el borrado nulea email y
// password, pero un token viejo (reset/refresh) todavía traía el user_id.
const NOT_DELETED = 'deleted_at IS NULL';

const PROFILE_FIELDS_WHITELIST = ['name', 'last_name', 'email', 'city'] as const;

export class AuthRepository {
  /**
   * Case-insensitive: las cuentas viejas quedaron con el email tal cual lo
   * tipearon ("Juan@Gmail.com") y el login/reset con minúsculas no las
   * encontraba. Índice funcional en migración 119.
   */
  async findByEmail(email: string): Promise<UserWithPassword | null> {
    const { rows } = await pool.query(
      `SELECT id, name, last_name, email, role, city, province, plan_id, status, password_hash
       FROM users WHERE LOWER(email) = LOWER($1) AND ${NOT_DELETED}
       ORDER BY (email = $1) DESC, id ASC
       LIMIT 1`,
      [email]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async getUserById(userId: number): Promise<AuthUser | null> {
    const { rows } = await pool.query(
      `SELECT id, name, last_name, email, role, city, province, plan_id, status
       FROM users WHERE id = $1 AND ${NOT_DELETED}`,
      [userId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async createUser({ name, lastName, email, passwordHash, planId }: {
    name: string;
    lastName?: string;
    email: string;
    passwordHash: string;
    planId: number;
  }): Promise<AuthUser> {
    const { rows } = await pool.query(
      `INSERT INTO users (name, last_name, email, password_hash, role, plan_id)
       VALUES ($1, $2, $3, $4, 'end_user', $5)
       RETURNING id, name, last_name, email, role, city, province, plan_id, status`,
      [name, lastName || null, email, passwordHash, planId]
    );
    return rows[0];
  }

  async updateProfile(userId: number, fields: Record<string, unknown>): Promise<AuthUser | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    for (const key of PROFILE_FIELDS_WHITELIST) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = $${idx++}`);
        values.push(fields[key]);
      }
    }

    if (sets.length === 0) return null;

    values.push(userId);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx} AND ${NOT_DELETED}
       RETURNING id, name, last_name, email, role, city, province, plan_id, status`,
      values
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async findByPhone(phone: string): Promise<AuthUser | null> {
    const { rows } = await pool.query(
      `SELECT id, name, last_name, email, role, city, province, plan_id, status
       FROM users WHERE phone_number = $1 AND ${NOT_DELETED}`,
      [phone]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async setRole(userId: number, role: UserRole): Promise<void> {
    await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, userId]);
  }

  async setPasswordHash(userId: number, passwordHash: string): Promise<void> {
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
  }
}
