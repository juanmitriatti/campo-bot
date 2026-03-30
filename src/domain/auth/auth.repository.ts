import { pool } from '../../config/db.js';
import type { AuthUser, UserRole } from './auth.types.js';

interface UserWithPassword extends AuthUser {
  password_hash: string | null;
}

const PROFILE_FIELDS_WHITELIST = ['name', 'email', 'city'] as const;

export class AuthRepository {
  async findByEmail(email: string): Promise<UserWithPassword | null> {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, city, province, plan_id, password_hash
       FROM users WHERE email = $1`,
      [email]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async getUserById(userId: number): Promise<AuthUser | null> {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, city, province, plan_id
       FROM users WHERE id = $1`,
      [userId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async createUser({ name, email, passwordHash, planId }: {
    name: string;
    email: string;
    passwordHash: string;
    planId: number;
  }): Promise<AuthUser> {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, plan_id)
       VALUES ($1, $2, $3, 'end_user', $4)
       RETURNING id, name, email, role, city, province, plan_id`,
      [name, email, passwordHash, planId]
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
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${idx}
       RETURNING id, name, email, role, city, province, plan_id`,
      values
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async findByPhone(phone: string): Promise<AuthUser | null> {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, city, province, plan_id
       FROM users WHERE phone_number = $1`,
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
