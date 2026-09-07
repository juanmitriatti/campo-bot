#!/usr/bin/env tsx
/**
 * Bootstrap an admin user.
 *
 * Usage:
 *   npx tsx src/scripts/create-admin.ts --email admin@campo.com --name "Admin" --password "secret"
 *
 * If the email already exists, upgrades the user to admin role.
 * Requires DATABASE_URL env var (or .env file).
 */

import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';

dotenv.config();

const BCRYPT_ROUNDS = 12;

function parseArgs(): { email: string; name: string; password: string; plan: string } {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key && val) map.set(key, val);
  }

  const email = map.get('email');
  const name = map.get('name');
  const password = map.get('password');
  // --plan: un admin de QA que va a usar el test-bot en prod necesita las
  // features (agronomy/livestock son pro+) — con 'free' el FeatureGate corta.
  const plan = map.get('plan') ?? 'free';

  if (!email || !name || !password) {
    console.error('Usage: npx tsx src/scripts/create-admin.ts --email <email> --name <name> --password <password> [--plan enterprise]');
    process.exit(1);
  }

  return { email, name, password, plan };
}

async function main() {
  const { email, name, password, plan } = parseArgs();

  if (password.length < 8) {
    console.error('Error: La contraseña debe tener al menos 8 caracteres');
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // Check if user with this email exists
  const { rows: existing } = await pool.query(
    `SELECT id, name, role FROM users WHERE email = $1`,
    [email]
  );

  if (existing.length > 0) {
    // Upgrade to admin
    await pool.query(
      `UPDATE users SET role = 'admin', password_hash = $1, name = $2 WHERE email = $3`,
      [passwordHash, name, email]
    );
    if (plan !== 'free') {
      const planR = await pool.query(`SELECT id FROM plans WHERE name = $1 LIMIT 1`, [plan]);
      if (planR.rows.length === 0) { console.error(`Error: plan desconocido "${plan}"`); process.exit(1); }
      await pool.query(`UPDATE users SET plan_id = $1 WHERE email = $2`, [planR.rows[0].id, email]);
    }
    console.log(`Usuario existente (id=${existing[0].id}) actualizado a admin: ${email} (plan ${plan})`);
  } else {
    // Create new admin user
    const planRow = await pool.query(`SELECT id FROM plans WHERE name = $1 LIMIT 1`, [plan]);
    if (planRow.rows.length === 0) { console.error(`Error: plan desconocido "${plan}"`); process.exit(1); }
    const planId = planRow.rows[0].id;

    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, plan_id)
       VALUES ($1, $2, $3, 'admin', $4)
       RETURNING id`,
      [name, email, passwordHash, planId]
    );
    console.log(`Admin creado (id=${rows[0].id}): ${email}`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
