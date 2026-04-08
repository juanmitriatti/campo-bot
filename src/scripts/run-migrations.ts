/**
 * Migration runner.
 *
 * Reads SQL files from src/migrations/ and applies any that haven't been
 * recorded in the `schema_migrations` table yet. Each migration runs inside
 * a transaction so partial failures don't leave the schema in a bad state.
 *
 * Migrations are sorted alphabetically by filename — duplicate prefixes
 * (e.g. `032_a.sql` + `032_b.sql`) are handled deterministically by name.
 *
 * Usage:
 *   - Standalone:  `npx tsx src/scripts/run-migrations.ts`
 *   - On startup:  imported by `app.ts` and called before `app.listen`
 *
 * Disable on startup with env var: `RUN_MIGRATIONS_ON_START=false`
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`,
  );
  return new Set(rows.map((r) => r.filename));
}

async function listMigrationFiles(): Promise<string[]> {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

async function applyMigration(filename: string): Promise<void> {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = await readFile(fullPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)`,
      [filename],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<{ applied: number; skipped: number }> {
  console.log('[migrations] Starting migration check…');
  await ensureMigrationsTable();

  const [applied, files] = await Promise.all([
    getAppliedMigrations(),
    listMigrationFiles(),
  ]);

  const pending = files.filter((f) => !applied.has(f));

  if (pending.length === 0) {
    console.log(`[migrations] Up to date (${files.length} total, 0 pending)`);
    return { applied: 0, skipped: files.length };
  }

  console.log(`[migrations] Found ${pending.length} pending migration(s):`);
  for (const f of pending) console.log(`  - ${f}`);

  let count = 0;
  for (const filename of pending) {
    try {
      console.log(`[migrations] Applying ${filename}…`);
      await applyMigration(filename);
      count++;
      console.log(`[migrations] ✓ ${filename}`);
    } catch (err) {
      console.error(`[migrations] ✗ FAILED ${filename}:`, err);
      throw new Error(`Migration ${filename} failed — aborting startup`);
    }
  }

  console.log(`[migrations] Done — applied ${count} migration(s)`);
  return { applied: count, skipped: files.length - count };
}

// Run standalone if invoked directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runMigrations()
    .then(() => {
      console.log('[migrations] Standalone run complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrations] Standalone run failed:', err);
      process.exit(1);
    });
}
