/**
 * Tests HTTP de los endpoints del paquete dashboard pre-lanzamiento.
 * Corren contra el app REAL de Docker (localhost:3000) con registro de
 * usuario descartable → JWT real. Asserts de DB vía pool directo (:5433).
 * Se saltean enteros si el app no responde (CI sin docker).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';

const BASE = 'http://localhost:3000';
let appUp = false;

async function appReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

export async function registerTestUser(slug: string): Promise<{ token: string; userId: number; email: string }> {
  const email = `rt-${slug}-${Date.now()}@routes-test.local`;
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `RT ${slug}`, email, password: 'testpass123' }),
  });
  if (!r.ok) throw new Error(`register failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  // register returns { user, tokens: { accessToken, refreshToken } }
  const token = body.tokens?.accessToken ?? body.token ?? body.accessToken;
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  return { token, userId: u.rows[0].id as number, email };
}

export function api(token: string) {
  return (path: string, opts: RequestInit = {}) =>
    fetch(`${BASE}/api/auth${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
    });
}

async function cleanupUser(email: string): Promise<void> {
  const u = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (u.rows.length === 0) return;
  const uid = u.rows[0].id;
  for (let pass = 0; pass < 3; pass++) {
    await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [uid]).catch(() => {});
    const tablesR = await pool.query(
      `SELECT DISTINCT table_name FROM information_schema.columns
       WHERE column_name = 'user_id' AND table_schema = 'public' AND table_name <> 'users'`,
    );
    for (const t of tablesR.rows) await pool.query(`DELETE FROM "${t.table_name}" WHERE user_id = $1`, [uid]).catch(() => {});
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [uid]).catch(() => {});
}

describe('dashboard prelaunch — seguridad (Task 1)', () => {
  beforeAll(async () => { appUp = await appReachable(); });

  it('POST /api/test-bot en no-prod sigue abierto para usuarios comunes', async () => {
    if (!appUp) return; // skip sin docker
    const { token, email } = await registerTestUser('chat-noprod');
    try {
      const r = await fetch(`${BASE}/api/test-bot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'hola' }),
      });
      // Docker local NO es prod (sin RAILWAY_*) → el gate deja pasar
      expect(r.status).toBe(200);
    } finally { await cleanupUser(email); }
  });

  it('GET /samples/* ya no existe', async () => {
    if (!appUp) return;
    const r = await fetch(`${BASE}/samples/whatever.pdf`);
    expect(r.status).toBe(404);
  });
});

describe('dashboard prelaunch — campos y lotes (Task 2)', () => {
  beforeAll(async () => { appUp = await appReachable(); });

  it('fields-tree: scoping + rename campo/lote + hectáreas', async () => {
    if (!appUp) return;
    const a = await registerTestUser('fields-a');
    const b = await registerTestUser('fields-b');
    try {
      const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Vieja') RETURNING id`, [a.userId]);
      const fieldId = f.rows[0].id;
      const p = await pool.query(`INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, 'Norte', 50) RETURNING id`, [fieldId]);
      const plotId = p.rows[0].id;

      // GET árbol
      const tree = await (await api(a.token)('/fields-tree')).json();
      expect(tree.fields).toHaveLength(1);
      expect(tree.fields[0].plots[0].name).toBe('Norte');

      // El usuario B no ve nada, y no puede editar lo de A
      const treeB = await (await api(b.token)('/fields-tree')).json();
      expect(treeB.fields).toHaveLength(0);
      const forbidden = await api(b.token)(`/fields/${fieldId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Robado' }) });
      expect(forbidden.status).toBe(404);

      // Rename campo + lote + hectáreas
      const r1 = await api(a.token)(`/fields/${fieldId}`, { method: 'PATCH', body: JSON.stringify({ name: 'La Nueva' }) });
      expect(r1.status).toBe(200);
      const r2 = await api(a.token)(`/plots/${plotId}`, { method: 'PATCH', body: JSON.stringify({ name: 'Norte Grande', hectares: 62.5 }) });
      expect(r2.status).toBe(200);
      const row = await pool.query(`SELECT p.name, p.area_hectares, f.name AS fname FROM plots p JOIN fields f ON f.id = p.field_id WHERE p.id = $1`, [plotId]);
      expect(row.rows[0]).toMatchObject({ name: 'Norte Grande', fname: 'La Nueva' });
      expect(Number(row.rows[0].area_hectares)).toBe(62.5);

      // Colisión de nombre (case/acento-insensible) → 409
      await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Sur')`, [fieldId]);
      const dup = await api(a.token)(`/plots/${plotId}`, { method: 'PATCH', body: JSON.stringify({ name: 'sur' }) });
      expect(dup.status).toBe(409);

      // Hectáreas inválidas → 400
      const badHa = await api(a.token)(`/plots/${plotId}`, { method: 'PATCH', body: JSON.stringify({ hectares: -5 }) });
      expect(badHa.status).toBe(400);

      // FIX 2: cosechado-pero-no-cerrado (harvested_at SET, end_date NULL) debe aparecer como activeCrop
      // La consulta CORRECTA usa end_date IS NULL (ciclo de vida real de la campaña)
      await pool.query(
        `INSERT INTO plot_crops (plot_id, crop, season_year, start_date, harvested_at, end_date)
         VALUES ($1, 'soja', 2024, CURRENT_DATE, CURRENT_DATE, NULL)`,
        [plotId],
      );
      const treeAfterHarvest = await (await api(a.token)('/fields-tree')).json();
      // El cultivo cosechado pero NO cerrado debe seguir siendo visible como activo
      expect(treeAfterHarvest.fields[0].plots.find((p: { id: number }) => p.id === plotId)?.activeCrop).toBe('soja');
    } finally { await cleanupUser(a.email); await cleanupUser(b.email); }
  });

  it('soft-delete de gasto/ingreso/actividad + desaparecen del listado', async () => {
    if (!appUp) return;
    const u = await registerTestUser('deletes');
    try {
      const e = await pool.query(`INSERT INTO expenses (user_id, amount, category, description) VALUES ($1, 5000, 'Combustible', 'gasoil') RETURNING id`, [u.userId]);
      const i = await pool.query(`INSERT INTO incomes (user_id, amount, category, description) VALUES ($1, 90000, 'Granos', 'venta soja') RETURNING id`, [u.userId]);
      const d = await pool.query(`INSERT INTO domain_events (user_id, event_type, event_date) VALUES ($1, 'spraying', CURRENT_DATE) RETURNING id`, [u.userId]);

      for (const [path, id] of [[`/expenses/${e.rows[0].id}`, e.rows[0].id], [`/incomes/${i.rows[0].id}`, i.rows[0].id], [`/activities/${d.rows[0].id}`, d.rows[0].id]] as const) {
        const r = await api(u.token)(String(path), { method: 'DELETE' });
        expect(r.status).toBe(200);
      }
      const gone = await pool.query(
        `SELECT (SELECT deleted_at FROM expenses WHERE id = $1) AS e,
                (SELECT deleted_at FROM incomes WHERE id = $2) AS i,
                (SELECT deleted_at FROM domain_events WHERE id = $3) AS d`,
        [e.rows[0].id, i.rows[0].id, d.rows[0].id],
      );
      expect(gone.rows[0].e).not.toBeNull();
      expect(gone.rows[0].i).not.toBeNull();
      expect(gone.rows[0].d).not.toBeNull();

      // El listado ya no los devuelve
      const list = await (await api(u.token)('/expenses?page=1&limit=10')).json();
      const ids = (list.expenses ?? list.items ?? []).map((x: { id: number }) => x.id);
      expect(ids).not.toContain(e.rows[0].id);

      // Cross-user → 404
      const other = await registerTestUser('deletes-b');
      const r404 = await api(other.token)(`/expenses/${e.rows[0].id}`, { method: 'DELETE' });
      expect(r404.status).toBe(404);
      await cleanupUser(other.email);
    } finally { await cleanupUser(u.email); }
  });
});
