/**
 * Pone email + contraseña a un usuario EXISTENTE (típicamente uno que llegó
 * por WhatsApp/Telegram y nunca se registró en la web) para poder entrar al
 * dashboard con su cuenta. No toca role, plan, ni verificación de canal.
 *
 * Usage:
 *   npx tsx src/scripts/set-user-credentials.ts --user-id 374 --email tomas@x.com --password "secret"
 *
 * Contra prod (inyecta DATABASE_PUBLIC_URL como DATABASE_URL):
 *   railway run --service Postgres --environment production -- cmd /c "set DATABASE_URL=%DATABASE_PUBLIC_URL%&& npx tsx src\scripts\set-user-credentials.ts --user-id 374 --email ... --password ..."
 */
import bcrypt from 'bcrypt';
import { pool } from '../config/db.js';

const BCRYPT_ROUNDS = 12;

function parseArgs(): { userId: number; email: string; password: string } {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value) map.set(key, value);
  }
  const userId = Number(map.get('user-id'));
  const email = map.get('email');
  const password = map.get('password');
  if (!Number.isInteger(userId) || !email || !password) {
    console.error('Usage: npx tsx src/scripts/set-user-credentials.ts --user-id <id> --email <email> --password <password>');
    process.exit(1);
  }
  return { userId, email, password };
}

async function main() {
  const { userId, email, password } = parseArgs();
  if (password.length < 8) {
    console.error('Error: la contraseña debe tener al menos 8 caracteres');
    process.exit(1);
  }

  const { rows: target } = await pool.query(
    `SELECT id, name, phone_number, email, deleted_at FROM users WHERE id = $1`,
    [userId],
  );
  if (target.length === 0) {
    console.error(`Error: no existe el usuario id=${userId}`);
    process.exit(1);
  }
  if (target[0].deleted_at) {
    console.error(`Error: el usuario id=${userId} está borrado (deleted_at=${target[0].deleted_at})`);
    process.exit(1);
  }
  const { rows: clash } = await pool.query(
    `SELECT id FROM users WHERE email = $1 AND id <> $2`,
    [email, userId],
  );
  if (clash.length > 0) {
    console.error(`Error: el email ${email} ya lo usa el usuario id=${clash[0].id}`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(
    `UPDATE users SET email = $1, password_hash = $2 WHERE id = $3`,
    [email, passwordHash, userId],
  );
  console.log(`Usuario id=${userId} (${target[0].name ?? 'sin nombre'}, ${target[0].phone_number ?? 'sin teléfono'}): login web habilitado con ${email}`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
