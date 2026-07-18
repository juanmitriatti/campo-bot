# Dashboard pre-lanzamiento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el dashboard listo para anunciar: chat de prueba solo-admin, `/samples` afuera, tab Campos (renombrar/hectáreas), eliminar en Gastos/Ingresos/Actividades, cambio de contraseña, tab Recordatorios.

**Architecture:** Endpoints nuevos inline en `auth.routes.ts` (patrón existente), reusando servicios (`reminder.service`, `token.repository`, `entity-matcher`). Frontend: 2 tabs nuevos (`FieldsTab`, `RemindersTab`) + botón eliminar en 3 tablas + card de contraseña en Mi cuenta, siguiendo los patrones de tabla/modal existentes. Tests de rutas: vitest vía HTTP contra el app de Docker (registro real → JWT), asserts de DB vía pool directo; se saltean si :3000 no responde.

**Tech Stack:** TypeScript ESM, Express, React (frontend/), vitest, PostgreSQL, bcrypt.

## Global Constraints

- ESM (`.js` en import paths backend), NO `require`. Texto de usuario en español argentino.
- Endpoints nuevos: user-scoped SIEMPRE (WHERE user_id / JOIN a fields.user_id). Gates: `requireFeature('fields')` para campos/lotes, `expenses`/`incomes`/`agronomy` para deletes, solo `requireAuth` para password y reminders.
- Soft-delete = `deleted_at = NOW()`; NUNCA DELETE físico. `domain_events` YA tiene `deleted_at` (sin migración).
- Renombrar campos/lotes valida unicidad con `sqlNormalizedName` de `src/utils/entity-matcher.ts` — NO escribir otra normalización inline (regla dura del proyecto).
- Chat gating: en prod (`IS_PROD_RUNTIME`) solo rol `admin`; en no-prod sin cambio (eval/CI intactos).
- Cambio de contraseña revoca TODOS los refresh tokens (`tokenRepository.revokeAllUserTokens`) — el frontend avisa y re-loguea.
- Frontend: sin framework de tests — verificación = `cd frontend && npm run build` sin errores.
- Tests de rutas requieren `docker compose up -d` (app en :3000 + DB en :5433); el archivo se saltea si el app no responde.

---

### Task 1: Seguridad y limpieza (A + B + C)

**Files:**
- Modify: `frontend/src/App.tsx` (~línea 49-55, ruta `/chat`)
- Modify: `src/controllers/test-bot.controller.ts` (gate admin en POST principal y /audio)
- Modify: `src/app.ts` (~línea 76, mount `/samples`)
- Delete: `src/public/samples/` (si existe)
- Test: `src/routes/__tests__/dashboard-prelaunch.routes.test.ts` (NUEVO — crear el harness HTTP acá; Tasks 2-3 le agregan describes)

**Interfaces:**
- Produces: harness de test HTTP en el mismo archivo de test: `registerTestUser(slug): Promise<{ token: string; userId: number }>` (POST `/api/auth/register` con email descartable → token JWT real; userId vía SELECT a la DB) + `api(path, opts): Promise<Response>` (fetch a `http://localhost:3000` con Authorization). Tasks 2-3 lo reusan.

- [ ] **Step 1: Crear el archivo de test con el harness + tests de este task**

Create `src/routes/__tests__/dashboard-prelaunch.routes.test.ts`:

```ts
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
  const token = body.token ?? body.accessToken;
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
```

- [ ] **Step 2: Correr los tests — deben fallar**

Run: `docker compose up -d && sleep 5 && npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts`
Expected: el test de `/samples` FALLA (hoy devuelve 200/403 del static, no 404). El de test-bot pasa ya (no-prod abierto) — es el guard de regresión del eval.

- [ ] **Step 3: Implementar A (chat admin-only)**

En `frontend/src/App.tsx`, la ruta `/chat`:

```tsx
          <Route
            path="/chat"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <Chat />
              </ProtectedRoute>
            }
          />
```

En `src/controllers/test-bot.controller.ts`: `IS_PROD_RUNTIME` ya existe (~línea 354). Agregar el check al inicio del handler principal (`POST /`) y del de audio (`POST /audio`), DESPUÉS de `requireAuth` (buscar dónde se lee `req.auth`):

```ts
  // Prod: el chat de prueba es solo-admin — un usuario final que descubra la
  // URL no debe poder escribir datos reales por acá. No-prod (docker/CI/eval)
  // sigue abierto: el eval usa este endpoint con usuarios de prueba.
  if (IS_PROD_RUNTIME && req.auth?.role !== 'admin') {
    console.warn(`[test-bot] blocked non-admin in prod: user=${req.auth?.userId}`);
    res.status(403).json({ error: 'Solo disponible para administradores.' });
    return;
  }
```

- [ ] **Step 4: Implementar B (/samples afuera)**

En `src/app.ts` eliminar la línea del mount (y su comentario):

```ts
// ELIMINAR estas líneas:
// Public sample PDFs (temporary share — remove after demo)
app.use('/samples', express.static(path.join(__dirname, 'public/samples')));
```

Borrar la carpeta si existe: `rm -rf src/public/samples` (verificar antes con `ls src/public/`).

- [ ] **Step 5: C (verificación) + correr tests**

Run: `npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts` — pero OJO: el app de Docker corre el código del CONTENEDOR; tras cambiar app.ts hay que `docker compose restart app && sleep 6` (tsx recarga desde el bind mount si existe; si el compose no monta src/, rebuild: `docker compose up -d --build app`).
Expected: 2/2 PASS.

Verificación C (solo constatar y anotar en el reporte): `railway variables 2>/dev/null | grep -i TEST_BOT_SECRET || echo "TEST_BOT_SECRET no seteado ✓"` — si el CLI no está logueado, anotar que quedó pendiente de verificación manual en el panel de Railway.

Frontend: `cd frontend && npm run build` — sin errores.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx src/controllers/test-bot.controller.ts src/app.ts src/routes/__tests__/dashboard-prelaunch.routes.test.ts
git rm -r --cached src/public/samples 2>/dev/null; git add -A src/public/ 2>/dev/null
git commit -m "feat(prelaunch): chat de prueba solo-admin + /samples afuera

/chat (frontend) y POST /api/test-bot[/audio] (backend) restringidos a rol
admin EN PROD (no-prod intacto — el eval sigue funcionando). Se elimina el
mount temporal /samples. Harness de tests HTTP de rutas nuevo.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Tab Campos + Eliminar registros (D + E)

**Files:**
- Modify: `src/routes/auth.routes.ts` (5 endpoints nuevos)
- Create: `frontend/src/components/FieldsTab.tsx`
- Modify: `frontend/src/components/ExpenseTable.tsx`, `IncomeTable.tsx`, `ActivityTable.tsx` (botón eliminar + modal confirm)
- Modify: `frontend/src/pages/Dashboard.tsx` (case 'fields'), `frontend/src/components/layout/Sidebar.tsx` + `BottomNav.tsx` (entrada "Campos")
- Test: `src/routes/__tests__/dashboard-prelaunch.routes.test.ts` (agregar describes)

**Interfaces:**
- Consumes de Task 1: `registerTestUser`, `api`, `cleanupUser` del archivo de test.
- Produces (Task 3 no depende, pero el patrón de endpoint inline + describe de test es el mismo).

- [ ] **Step 1: Tests que fallan (agregar al archivo de Task 1)**

```ts
describe('dashboard prelaunch — campos y lotes (Task 2)', () => {
  beforeAll(async () => { appUp = await appReachable(); });

  it('fields-tree: scoping + rename campo/lote + hectáreas', async () => {
    if (!appUp) return;
    const a = await registerTestUser('fields-a');
    const b = await registerTestUser('fields-b');
    try {
      const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Vieja') RETURNING id`, [a.userId]);
      const fieldId = f.rows[0].id;
      const p = await pool.query(`INSERT INTO plots (field_id, name, hectares) VALUES ($1, 'Norte', 50) RETURNING id`, [fieldId]);
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
      const row = await pool.query(`SELECT p.name, p.hectares, f.name AS fname FROM plots p JOIN fields f ON f.id = p.field_id WHERE p.id = $1`, [plotId]);
      expect(row.rows[0]).toMatchObject({ name: 'Norte Grande', fname: 'La Nueva' });
      expect(Number(row.rows[0].hectares)).toBe(62.5);

      // Colisión de nombre (case/acento-insensible) → 409
      await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Sur')`, [fieldId]);
      const dup = await api(a.token)(`/plots/${plotId}`, { method: 'PATCH', body: JSON.stringify({ name: 'sur' }) });
      expect(dup.status).toBe(409);

      // Hectáreas inválidas → 400
      const badHa = await api(a.token)(`/plots/${plotId}`, { method: 'PATCH', body: JSON.stringify({ hectares: -5 }) });
      expect(badHa.status).toBe(400);
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
```

Nota: ajustar los INSERT si las tablas exigen más columnas NOT NULL (mirar `\d expenses` / `\d incomes` / `\d domain_events` y completar con valores mínimos). La forma del JSON de respuesta de `GET /expenses` — mirar el endpoint real y ajustar `list.expenses ?? list.items`.

- [ ] **Step 2: Correr — fallan con 404 (endpoints no existen)**

`docker compose restart app && sleep 6 && npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts -t "Task 2"`

- [ ] **Step 3: Endpoints backend**

En `src/routes/auth.routes.ts`, sección "--- Edit routes ---" (~línea 598), agregar. Import arriba: `import { sqlNormalizedName } from '../utils/entity-matcher.js';`

```ts
// --- Campos y lotes (tab Campos del dashboard) ---

router.get('/fields-tree', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.city,
              COALESCE(json_agg(json_build_object(
                'id', p.id, 'name', p.name, 'hectares', p.hectares,
                'activeCrop', (SELECT pc.crop FROM plot_crops pc WHERE pc.plot_id = p.id AND pc.harvested_at IS NULL ORDER BY pc.id DESC LIMIT 1)
              ) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS plots
       FROM fields f
       LEFT JOIN plots p ON p.field_id = f.id AND p.deleted_at IS NULL
       WHERE f.user_id = $1 AND f.deleted_at IS NULL
       GROUP BY f.id ORDER BY f.name`,
      [req.auth!.userId],
    );
    res.json({ fields: rows });
  } catch (err) { handleError(err, res); }
});

router.patch('/fields/:id', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (isNaN(id) || !name) { res.status(400).json({ error: 'Nombre inválido' }); return; }
    // Unicidad case/acento-insensible dentro del usuario (entity-matcher)
    const dup = await pool.query(
      `SELECT 1 FROM fields WHERE user_id = $1 AND id <> $2 AND deleted_at IS NULL
       AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$3')}`,
      [req.auth!.userId, id, name],
    );
    if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya tenés un campo con ese nombre' }); return; }
    const r = await pool.query(
      `UPDATE fields SET name = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING id, name`,
      [name, id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Campo no encontrado' }); return; }
    res.json({ field: r.rows[0] });
  } catch (err) { handleError(err, res); }
});

router.patch('/plots/:id', requireAuth, requireFeature('fields'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const hectares = req.body?.hectares != null ? Number(req.body.hectares) : undefined;
    if (name === '') { res.status(400).json({ error: 'Nombre inválido' }); return; }
    if (hectares != null && (!isFinite(hectares) || hectares <= 0 || hectares > 100000)) {
      res.status(400).json({ error: 'Hectáreas inválidas (0 a 100.000)' }); return;
    }
    if (name === undefined && hectares === undefined) { res.status(400).json({ error: 'Nada para actualizar' }); return; }
    // Ownership via JOIN + field_id para la unicidad
    const own = await pool.query(
      `SELECT p.field_id FROM plots p JOIN fields f ON f.id = p.field_id
       WHERE p.id = $1 AND f.user_id = $2 AND p.deleted_at IS NULL`,
      [id, req.auth!.userId],
    );
    if (own.rows.length === 0) { res.status(404).json({ error: 'Lote no encontrado' }); return; }
    if (name !== undefined) {
      const dup = await pool.query(
        `SELECT 1 FROM plots WHERE field_id = $1 AND id <> $2 AND deleted_at IS NULL
         AND ${sqlNormalizedName('name')} = ${sqlNormalizedName('$3')}`,
        [own.rows[0].field_id, id, name],
      );
      if (dup.rows.length > 0) { res.status(409).json({ error: 'Ya hay un lote con ese nombre en ese campo' }); return; }
    }
    const sets: string[] = []; const vals: unknown[] = [];
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (hectares !== undefined) { vals.push(hectares); sets.push(`hectares = $${vals.length}`); }
    vals.push(id);
    const r = await pool.query(`UPDATE plots SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, name, hectares`, vals);
    res.json({ plot: r.rows[0] });
  } catch (err) { handleError(err, res); }
});

// --- Soft-delete de registros (paridad con "borrá el último gasto" del bot) ---

router.delete('/expenses/:id', requireAuth, requireFeature('expenses'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE expenses SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Gasto no encontrado' }); return; }
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
});

router.delete('/incomes/:id', requireAuth, requireFeature('incomes'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE incomes SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Ingreso no encontrado' }); return; }
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
});

router.delete('/activities/:id', requireAuth, requireFeature('agronomy'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: 'ID inválido' }); return; }
    const r = await pool.query(
      `UPDATE domain_events SET deleted_at = NOW() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id`,
      [id, req.auth!.userId],
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Actividad no encontrada' }); return; }
    res.json({ deleted: true });
  } catch (err) { handleError(err, res); }
});
```

**IMPORTANTE — lecturas de actividades:** verificar que `observationService.getUserActivities` (y cualquier query del dashboard sobre `domain_events`) filtre `deleted_at IS NULL`. Si no filtra, agregarlo — sin eso el delete "no hace nada" visualmente. Mismo check para los formatters del bot que listan actividades (`query_plot_history`): `grep -n "FROM domain_events" src/ -r` y confirmar filtro (el índice parcial `idx_domain_events_user_active` sugiere que el bot YA filtra; verificar el service del dashboard puntualmente).

**Nota `sqlNormalizedName`:** mirar su firma real en `src/utils/entity-matcher.ts` — si genera un fragmento SQL sobre una columna/param, usarlo como en `getPlotByName` (buscar un uso existente en `src/services/expenses.js` y copiar la forma exacta de invocación). Si no acepta `'$3'` como argumento, adaptar (p.ej. `sqlNormalizedName('name') = sqlNormalizedName('$3'::text)` o normalizar el candidato en JS con `normalizeEntityName` y comparar contra el fragmento SQL de la columna).

- [ ] **Step 4: Frontend — FieldsTab**

Create `frontend/src/components/FieldsTab.tsx` — seguir el patrón visual de `CategoriesTab.tsx` (lista + edición inline + estados loading/error/retry). Requisitos funcionales exactos:
- Carga `GET /api/auth/fields-tree` al montar (con el helper de fetch autenticado que usen las otras tablas — mirar cómo `CategoriesTab` hace fetch y copiar).
- Por campo: nombre (con lápiz → input inline → guardar llama `PATCH /api/auth/fields/:id`), localidad (read-only, "Sin ubicación" si null), total has (suma de lotes).
- Por lote (anidado bajo su campo): nombre (lápiz → `PATCH /api/auth/plots/:id` con `{name}`), hectáreas (lápiz → input numérico → `{hectares}`), cultivo activo (badge read-only, "—" si null).
- Errores del server (409 colisión, 400 inválido) se muestran junto al input (texto rojo con el `error` del JSON).
- Empty state: "Todavía no tenés campos. Creálos desde el chat: *tengo el campo La Esperanza en Pergamino*".
- Mobile: lista apilada (sin tabla ancha) — mismo enfoque responsive que CategoriesTab.

En `frontend/src/pages/Dashboard.tsx`: agregar `case 'fields': return <FieldsTab />;` (import arriba). En `Sidebar.tsx` y `BottomNav.tsx`: entrada "Campos" con el ícono que usen los demás (mirar cómo declaran los items; ubicarla después de "Resumen"). Sin feature-gate frontend.

- [ ] **Step 5: Frontend — botón eliminar en 3 tablas**

En `ExpenseTable.tsx`, `IncomeTable.tsx`, `ActivityTable.tsx` (y sus cards mobile `ExpenseCard/IncomeCard/ActivityCard` si renderizan acciones): junto al botón "Editar" existente, agregar botón "Eliminar" (ícono trash, `text-red-600`). Al click abre confirmación (usar el patrón de modal existente de los EditModal, versión mínima):

```tsx
// Estado en la tabla: const [deleting, setDeleting] = useState<RowType | null>(null);
// Modal (mismo overlay/estilos que el EditModal correspondiente):
//   Título: "¿Eliminar este registro?"
//   Cuerpo: fecha + descripción/categoría + monto (o tipo de actividad)
//   "Esta acción lo saca de tus listados y reportes."
//   Botones: [Cancelar] [Eliminar] (rojo)
// Confirmar:
const handleDelete = async (id: number) => {
  const res = await authFetch(`/api/auth/expenses/${id}`, { method: 'DELETE' }); // incomes/activities según tabla
  if (res.ok) { setDeleting(null); refetch(); } // refetch = el reload que ya usa la tabla tras editar
  else { const b = await res.json().catch(() => ({})); setDeleteError(b.error ?? 'No se pudo eliminar'); }
};
```

(`authFetch` = el helper de fetch autenticado que ya usan los EditModal de cada tabla — copiar el mismo mecanismo, no inventar otro.)

- [ ] **Step 6: Correr tests + builds**

`docker compose restart app && sleep 6 && npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts`
Expected: todos PASS (Task 1 + Task 2).
`cd frontend && npm run build` — sin errores.
`npx tsc --noEmit 2>&1 | grep -c "error TS"` — sin errores nuevos (~195 pre-existentes).

- [ ] **Step 7: Commit**

```bash
git add src/routes/auth.routes.ts frontend/src/components/FieldsTab.tsx frontend/src/components/ExpenseTable.tsx frontend/src/components/IncomeTable.tsx frontend/src/components/ActivityTable.tsx frontend/src/components/cards/ frontend/src/pages/Dashboard.tsx frontend/src/components/layout/ src/routes/__tests__/dashboard-prelaunch.routes.test.ts
git commit -m "feat(prelaunch): tab Campos (renombrar/hectáreas) + eliminar registros

GET /fields-tree + PATCH fields/plots (unicidad vía entity-matcher, user-
scoped) + DELETE soft de gastos/ingresos/actividades. FieldsTab nuevo en
el dashboard; botón eliminar con confirmación en las 3 tablas.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Cambio de contraseña + Tab Recordatorios (F + G)

**Files:**
- Modify: `src/routes/auth.routes.ts` (3 endpoints)
- Modify: `frontend/src/components/ChannelLinking.tsx` (card Contraseña)
- Create: `frontend/src/components/RemindersTab.tsx`
- Modify: `frontend/src/pages/Dashboard.tsx`, `Sidebar.tsx`, `BottomNav.tsx` (entrada "Recordatorios")
- Test: `src/routes/__tests__/dashboard-prelaunch.routes.test.ts` (describes nuevos)

**Interfaces:**
- Consumes: harness de Task 1; `completeReminder`/`listReminders` de `src/services/reminder.service.ts` (`completeReminder(userId, { id, cancel })`); `tokenRepository.revokeAllUserTokens(userId)` — ver cómo se instancia `TokenRepository` en `auth.routes.ts` (ya hay instancias de servicios arriba del archivo; si no está, instanciar `new TokenRepository()` igual que los demás).

- [ ] **Step 1: Tests que fallan**

```ts
describe('dashboard prelaunch — password y recordatorios (Task 3)', () => {
  beforeAll(async () => { appUp = await appReachable(); });

  it('cambio de contraseña: actual mala 403, corta 400, éxito revoca tokens', async () => {
    if (!appUp) return;
    const u = await registerTestUser('passwd');
    try {
      const bad = await api(u.token)('/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'incorrecta', newPassword: 'nuevapass123' }) });
      expect(bad.status).toBe(403);
      const short = await api(u.token)('/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'testpass123', newPassword: 'corta' }) });
      expect(short.status).toBe(400);
      const ok = await api(u.token)('/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'testpass123', newPassword: 'nuevapass123' }) });
      expect(ok.status).toBe(200);
      const tokens = await pool.query(`SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.userId]);
      expect(tokens.rows[0].n).toBe(0);
      // Login con la nueva funciona
      const relogin = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: 'nuevapass123' }) });
      expect(relogin.status).toBe(200);
    } finally { await cleanupUser(u.email); }
  });

  it('reminders: listar (open por default) + done + cancel + scoping', async () => {
    if (!appUp) return;
    const u = await registerTestUser('reminders');
    const other = await registerTestUser('reminders-b');
    try {
      const r1 = await pool.query(`INSERT INTO task_reminders (user_id, description, due_date, due_time) VALUES ($1, 'fumigar lote 5', '2099-01-05', '14:30') RETURNING id`, [u.userId]);
      const r2 = await pool.query(`INSERT INTO task_reminders (user_id, description, due_date, status) VALUES ($1, 'ya hecho', '2020-01-01', 'done') RETURNING id`, [u.userId]);

      const open = await (await api(u.token)('/reminders')).json();
      expect(open.reminders).toHaveLength(1);
      expect(open.reminders[0].due_time).toBe('14:30');
      const all = await (await api(u.token)('/reminders?status=all')).json();
      expect(all.reminders).toHaveLength(2);

      // Scoping: el otro usuario no puede tocarlo
      const forbidden = await api(other.token)(`/reminders/${r1.rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ action: 'done' }) });
      expect(forbidden.status).toBe(404);

      // done
      const done = await api(u.token)(`/reminders/${r1.rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ action: 'done' }) });
      expect(done.status).toBe(200);
      const st = await pool.query(`SELECT status FROM task_reminders WHERE id = $1`, [r1.rows[0].id]);
      expect(st.rows[0].status).toBe('done');
      void r2;
    } finally { await cleanupUser(u.email); await cleanupUser(other.email); }
  });
});
```

- [ ] **Step 2: Correr — fallan con 404**

`npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts -t "Task 3"`

- [ ] **Step 3: Endpoints backend**

En `auth.routes.ts` (imports arriba: `bcrypt` ya debería estar — verificar; `TokenRepository` de `../domain/auth/token.repository.js`; `listReminders`/`completeReminder` via import dinámico o estático de `../services/reminder.service.js`):

```ts
// --- Cambio de contraseña (Mi cuenta) ---
router.post('/me/password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres.' }); return;
    }
    const u = await pool.query(`SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`, [req.auth!.userId]);
    if (u.rows.length === 0 || !u.rows[0].password_hash) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    const okPass = await bcrypt.compare(currentPassword ?? '', u.rows[0].password_hash);
    if (!okPass) { res.status(403).json({ error: 'La contraseña actual no es correcta.' }); return; }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, req.auth!.userId]);
    await tokenRepository.revokeAllUserTokens(req.auth!.userId);
    console.log(`[account] password changed user=${req.auth!.userId} (tokens revocados)`);
    res.json({ ok: true, message: 'Contraseña actualizada. Volvé a iniciar sesión.' });
  } catch (err) { handleError(err, res); }
});

// --- Recordatorios (tab del dashboard) ---
router.get('/reminders', requireAuth, async (req: Request, res: Response) => {
  try {
    const showAll = req.query.status === 'all';
    const { rows } = await pool.query(
      `SELECT r.id, r.description, r.due_date::text, to_char(r.due_time, 'HH24:MI') AS due_time,
              r.status, r.sent_at, p.name AS plot_name, f.name AS field_name
       FROM task_reminders r
       LEFT JOIN plots p ON p.id = r.plot_id
       LEFT JOIN fields f ON f.id = r.field_id
       WHERE r.user_id = $1 ${showAll ? '' : `AND r.status IN ('pending','sent')`}
       ORDER BY CASE WHEN r.status IN ('pending','sent') THEN 0 ELSE 1 END, r.due_date, r.due_time NULLS LAST, r.id`,
      [req.auth!.userId],
    );
    res.json({ reminders: rows });
  } catch (err) { handleError(err, res); }
});

router.patch('/reminders/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    const action = req.body?.action as string;
    if (isNaN(id) || !['done', 'cancel'].includes(action)) { res.status(400).json({ error: 'Acción inválida' }); return; }
    const { completeReminder } = await import('../services/reminder.service.js');
    const r = await completeReminder(req.auth!.userId, { id, cancel: action === 'cancel' });
    if (!r) { res.status(404).json({ error: 'Recordatorio no encontrado' }); return; }
    res.json({ reminder: r });
  } catch (err) { handleError(err, res); }
});
```

(`bcrypt`: verificar el import existente en el archivo o en `auth.service` — si `auth.routes.ts` no importa bcrypt, agregar `import bcrypt from 'bcrypt';`. `tokenRepository`: buscar si ya hay una instancia; si no, `const tokenRepository = new TokenRepository();` junto a los otros services del archivo. Rounds: buscar `BCRYPT_ROUNDS` en el codebase y usar la misma constante si existe.)

- [ ] **Step 4: Frontend — card Contraseña en Mi cuenta**

En `ChannelLinking.tsx`, agregar una card "Contraseña" (mismo estilo de las cards existentes — Apariencia/WhatsApp/etc.): 3 inputs password (actual, nueva, repetir nueva), validación client-side (nueva ≥ 8, repetir coincide), submit → `POST /api/auth/me/password`. En éxito: mostrar "✅ Contraseña actualizada. Vas a tener que iniciar sesión de nuevo." y tras 2s ejecutar el logout que use el resto del app (buscar cómo hace logout el Sidebar/Navbar y llamar lo mismo). En error mostrar el `error` del JSON en rojo.

- [ ] **Step 5: Frontend — RemindersTab**

Create `frontend/src/components/RemindersTab.tsx`:
- `GET /api/auth/reminders?status=all` al montar. Split en "Pendientes" (`pending`/`sent`, arriba) y "Historial" (`done`/`cancelled`, colapsable con contador).
- Por recordatorio: descripción, fecha formateada (dd/mm) + hora si `due_time` (`a las 14:30`), badge de lote/campo si hay, badge de estado (`pendiente` ámbar / `avisado` azul / `hecho` verde / `cancelado` gris).
- Vencidos (`due_date < hoy` y status pending/sent): marcar "⚠️ vencido".
- Acciones en pendientes: botón "✓ Hecho" y "✕ Cancelar" (cancelar pide confirmación inline "¿Seguro?"). Ambos → `PATCH /api/auth/reminders/:id` + refetch.
- Empty state: "No tenés recordatorios. Pedímelos por chat: *acordame el sábado a las 9 de fumigar el lote 5*".
- Wiring: `case 'reminders'` en Dashboard.tsx + entrada "Recordatorios" en Sidebar/BottomNav (ícono reloj/campana según el set de íconos que usen).

- [ ] **Step 6: Correr todo + builds**

`docker compose restart app && sleep 6 && npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts`
Expected: TODOS los describes PASS (Tasks 1+2+3).
`cd frontend && npm run build` — sin errores.
`npx tsc --noEmit 2>&1 | grep -c "error TS"` — sin nuevos.
`npm test 2>&1 | grep -E "Tests "` — baseline sin fails nuevos.

- [ ] **Step 7: Commit**

```bash
git add src/routes/auth.routes.ts frontend/src/components/ChannelLinking.tsx frontend/src/components/RemindersTab.tsx frontend/src/pages/Dashboard.tsx frontend/src/components/layout/ src/routes/__tests__/dashboard-prelaunch.routes.test.ts
git commit -m "feat(prelaunch): cambio de contraseña + tab Recordatorios

POST /me/password (verifica actual, revoca refresh tokens, re-login) +
GET/PATCH /reminders (reusa completeReminder). Card Contraseña en Mi
cuenta; RemindersTab con hora (due_time), hecho/cancelar y historial.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** A→T1S3, B→T1S4, C→T1S5, D→T2S3-S4, E→T2S3+S5 (incl. verificación de filtros deleted_at en lecturas), F→T3S3-S4, G→T3S3+S5. Testing del spec: scoping/rename/colisión/hectáreas/soft-delete/password/reminders → describes de T1-T3. Regresión bot del rename: cubierta conceptualmente por entity-matcher (los lookups normalizan); el test de pipeline con FakeAgent es opcional y NO se incluyó (el rename por web usa la misma columna `name` que el bot lee — riesgo bajo; anotado como deuda consciente).

**Placeholder scan:** los puntos "mirar el archivo real y copiar el patrón" (authFetch, logout, íconos, firma de sqlNormalizedName, columnas NOT NULL de los INSERT de test) son instrucciones deliberadas de adaptación al código vivo con referencia exacta de dónde mirar — no TBDs.

**Type consistency:** harness `registerTestUser/api/cleanupUser` definido T1S1, consumido T2S1/T3S1 (mismo archivo). `completeReminder(userId, {id, cancel})` coincide con la firma real del service. `sqlNormalizedName` — el plan instruye verificar la firma real antes de usar (riesgo conocido, mitigado con instrucción explícita).

**Riesgo señalado:** los tests HTTP corren contra el contenedor — CADA cambio de backend requiere `docker compose restart app` antes de re-correr (los steps lo incluyen). Si el compose no bind-mountea `src/`, usar `docker compose up -d --build app`.
