# Dashboard UX polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs auto-explicativos (TabHeader con copy + ejemplos), tipografía legible, perfil editable en Mi cuenta (nombre/ciudad/email), export oculto, y el nombre del Navbar linkeando a Mi cuenta.

**Architecture:** Un componente `TabHeader` reutilizable aplicado a los 13 tabs con copy centralizado. Backend: un solo endpoint nuevo (`PATCH /api/auth/me`). El Navbar recibe un callback para saltar al tab account (patrón `onGoToAccount` ya existente en Dashboard).

**Tech Stack:** React + Tailwind (frontend/), Express + pg (backend), vitest (tests HTTP contra Docker).

## Global Constraints

- Texto de usuario en español argentino (voseo). Copy de los tabs: usar VERBATIM la tabla del spec (`docs/superpowers/specs/2026-07-18-dashboard-ux-polish-design.md` §A).
- `PATCH /api/auth/me`: solo `requireAuth`; email con unicidad case-insensitive → 409 "Ese email ya está en uso."; email inválido → 400; cambio de email → `email_verified_at = NULL`. El endpoint `GET /me/export` NO se toca.
- Export: solo se oculta la card del render — no borrar el endpoint backend.
- Tipografía: subir contenido principal (text-sm→text-base) y secundario (text-xs→text-sm) en los TABS de usuario; NO tocar chips/badges ni nada del admin.
- Tests HTTP: reusar el harness de `src/routes/__tests__/dashboard-prelaunch.routes.test.ts` (registerTestUser/api/cleanupUser); skips visibles sin Docker.
- Frontend check = `cd frontend && npm run build` limpio.

---

### Task 1: Backend PATCH /me + card Perfil + export oculto + Navbar→cuenta

**Files:**
- Modify: `src/routes/auth.routes.ts` (endpoint nuevo)
- Modify: `frontend/src/components/ChannelLinking.tsx` (card Perfil primera; quitar card Export)
- Modify: `frontend/src/components/Navbar.tsx` (+ su punto de render para pasar el callback — ver Step 4)
- Test: `src/routes/__tests__/dashboard-prelaunch.routes.test.ts` (describe nuevo)

**Interfaces:**
- Consumes: harness del archivo de test; `pool`, `requireAuth`, `handleError` de auth.routes.
- Produces: `PATCH /api/auth/me` body `{ name?, city?, email? }` → `{ user: { id, name, city, email } }`.

- [ ] **Step 1: Tests que fallan** — agregar al archivo de test:

```ts
describe('dashboard ux-polish — perfil (PATCH /me)', () => {
  beforeAll(async () => { appUp = await appReachable(); if (!appUp) console.warn('[routes-test] SKIP — app en :3000 no responde'); });

  it('edita nombre y ciudad', async () => {
    if (!appUp) return;
    const u = await registerTestUser('perfil');
    try {
      const r = await api(u.token)('/me', { method: 'PATCH', body: JSON.stringify({ name: 'Juan Test', city: 'Pergamino' }) });
      expect(r.status).toBe(200);
      const row = await pool.query(`SELECT name, city FROM users WHERE id = $1`, [u.userId]);
      expect(row.rows[0]).toMatchObject({ name: 'Juan Test', city: 'Pergamino' });
    } finally { await cleanupUser(u.email); }
  });

  it('email: duplicado 409, inválido 400, cambio resetea verificación', async () => {
    if (!appUp) return;
    const a = await registerTestUser('perfil-a');
    const b = await registerTestUser('perfil-b');
    try {
      const dup = await api(a.token)('/me', { method: 'PATCH', body: JSON.stringify({ email: b.email.toUpperCase() }) });
      expect(dup.status).toBe(409);
      const bad = await api(a.token)('/me', { method: 'PATCH', body: JSON.stringify({ email: 'no-es-un-mail' }) });
      expect(bad.status).toBe(400);
      // marcar verificado, cambiar email → vuelve a NULL
      await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [a.userId]);
      const nuevo = `nuevo-${Date.now()}@routes-test.local`;
      const ok = await api(a.token)('/me', { method: 'PATCH', body: JSON.stringify({ email: nuevo }) });
      expect(ok.status).toBe(200);
      const row = await pool.query(`SELECT email, email_verified_at FROM users WHERE id = $1`, [a.userId]);
      expect(row.rows[0].email).toBe(nuevo);
      expect(row.rows[0].email_verified_at).toBeNull();
      await pool.query(`UPDATE users SET email = $2 WHERE id = $1`, [a.userId, a.email]); // restaurar para cleanup
    } finally { await cleanupUser(a.email); await cleanupUser(b.email); }
  });
});
```

- [ ] **Step 2: Correr — fallan con 404.** `npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts -t "perfil"`

- [ ] **Step 3: Endpoint** — en `auth.routes.ts`, junto a `POST /me/password`:

```ts
// --- Perfil (Mi cuenta): nombre / ciudad / email ---
router.patch('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : undefined;
    const city = typeof req.body?.city === 'string' ? req.body.city.trim() : undefined;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : undefined;
    if (name === '') { res.status(400).json({ error: 'El nombre no puede quedar vacío.' }); return; }
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Ese email no parece válido.' }); return;
    }
    if (name === undefined && city === undefined && email === undefined) {
      res.status(400).json({ error: 'Nada para actualizar.' }); return;
    }
    let emailChanged = false;
    if (email !== undefined) {
      const cur = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.auth!.userId]);
      emailChanged = (cur.rows[0]?.email ?? '').toLowerCase() !== email;
      if (emailChanged) {
        const dup = await pool.query(`SELECT 1 FROM users WHERE LOWER(email) = $1 AND id <> $2`, [email, req.auth!.userId]);
        if (dup.rows.length > 0) { res.status(409).json({ error: 'Ese email ya está en uso.' }); return; }
      }
    }
    const sets: string[] = []; const vals: unknown[] = [];
    if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
    if (city !== undefined) { vals.push(city || null); sets.push(`city = $${vals.length}`); }
    if (email !== undefined && emailChanged) {
      vals.push(email); sets.push(`email = $${vals.length}`);
      sets.push(`email_verified_at = NULL`); // el banner de verificación se re-dispara
    }
    if (sets.length === 0) { res.json({ user: null, unchanged: true }); return; }
    vals.push(req.auth!.userId);
    const r = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} AND deleted_at IS NULL RETURNING id, name, city, email`,
      vals,
    );
    if (r.rows.length === 0) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
    console.log(`[account] perfil actualizado user=${req.auth!.userId}${emailChanged ? ' (email cambiado, verificación reseteada)' : ''}`);
    res.json({ user: r.rows[0] });
  } catch (err) { handleError(err, res); }
});
```

Correr tests → verdes (con `docker compose restart app && sleep 6`).

- [ ] **Step 4: Frontend Mi cuenta + Navbar.**
- **ChannelLinking.tsx**: (a) NUEVA card "Tu perfil" arriba de todo: muestra nombre/ciudad/email con lápiz → inputs → guardar via `PATCH /api/auth/me` (mismo fetch helper del archivo); al editar el email mostrar aviso amarillo "Si lo cambiás, vas a tener que verificarlo de nuevo."; errores 409/400 en rojo junto al input. Teléfono read-only + nota "→ se cambia desde la card de WhatsApp, más abajo". Tras guardar, refrescar el user del auth context si el contexto lo permite (mirar cómo se hidrata `useAuth` — si expone un refresh, llamarlo; si no, actualizar estado local y listo). (b) ELIMINAR la card "Exportar mis datos" del render (borrar también `downloadExport`/`exportBusy` si quedan muertos; el endpoint backend queda).
- **Navbar.tsx**: el `<span>` del nombre pasa a `<button>` con `hover:underline` → navega a Mi cuenta. Mirar DÓNDE se renderiza el Navbar (`grep -rn "<Navbar" frontend/src`): si lo renderiza Dashboard, pasarle prop `onUserClick={() => setView('account')}`; si vive en App/layout fuera del Dashboard, usar `navigate('/dashboard?view=account')` + en Dashboard leer el query param al montar (`useSearchParams`) y hacer `setView` — elegir según el árbol real y explicar en el reporte. En mobile agregar ícono de perfil (lucide `User`/`CircleUser`) visible cuando el nombre está oculto (`sm:hidden` inverso).

- [ ] **Step 5: Build + commit.** `cd frontend && npm run build` limpio. Commit: `feat(ux): perfil editable en Mi cuenta + export oculto + Navbar linkea a cuenta` (+ trailer Co-Authored-By Claude Opus 4.8).

---

### Task 2: TabHeader + copy en los 13 tabs + empty state de Observaciones + tipografía

**Files:**
- Create: `frontend/src/components/TabHeader.tsx`
- Modify: los 13 componentes de tab (FieldsTab, RemindersTab, CategoriesTab, ExpenseTable, IncomeTable, ActivityTable, ObservationTable, ScoutingTable, HarvestLoadsTable, StockTable, LivestockTab, DocumentsTable, ReportTable)
- Test: build del frontend (no hay framework de tests de UI)

**Interfaces:**
- Produces: `<TabHeader title description botHint? />` — botHint es el ejemplo SIN el prefijo (el componente agrega `💬 Pedile al bot:`).

- [ ] **Step 1: Componente.**

```tsx
/**
 * TabHeader — título + explicación de una línea + hint opcional con ejemplo
 * copiable. Patrón sistémico: TODO tab del dashboard de usuario arranca con
 * esto (feedback Jul 2026: "Campos no tiene ninguna explicación de qué es").
 */
export default function TabHeader({ title, description, botHint }: {
  title: string;
  description: string;
  botHint?: string;
}) {
  return (
    <div className="mb-4">
      <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      {botHint && (
        <p className="text-sm text-gray-600 dark:text-gray-300 mt-1.5">
          💬 Pedile al bot:{' '}
          <span className="font-mono text-campo-700 dark:text-campo-400">"{botHint}"</span>
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Aplicarlo a los 13 tabs** con el copy VERBATIM de la tabla del spec §A (títulos: Campos, Recordatorios, Categorías, Gastos, Ingresos, Actividades, Observaciones, Monitoreos, Cosechas, Stock, Hacienda, Documentos, Reportes). Insertarlo como PRIMER elemento del render de cada componente (arriba de filtros/botones). Si un tab ya tiene un título propio (mirar cada uno), reemplazarlo por TabHeader — no duplicar.

- [ ] **Step 3: Empty state de Observaciones** (ObservationTable ~línea 252) — formato Monitoreos:

```tsx
<div className="text-sm text-gray-500 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 rounded p-6 text-center border border-dashed border-gray-300 dark:border-gray-600">
  {hasFilters ? 'No hay observaciones con estos filtros.' : (
    <>No hay observaciones. Mandale al bot:<br />
    <span className="font-mono text-gray-700 dark:text-gray-200">"observación: apareció pulgón en la loma del 5"</span><br />
    <span className="text-xs">— o simplemente contale lo que ves en el campo.</span></>
  )}
</div>
```

- [ ] **Step 4: Tipografía** — pasada por los 13 tabs: contenido principal de tablas (`<td>`/texto de cards) text-sm→text-base; secundarios text-xs→text-sm. NO tocar: chips/badges, headers de tabla (uppercase text-xs está bien), admin, botones. Criterio conservador: si dudás, no lo toques — el objetivo es legibilidad de DATOS, no inflar todo.

- [ ] **Step 5: Build + commit.** `cd frontend && npm run build`. Commit: `feat(ux): TabHeader en los 13 tabs + ejemplos + tipografía legible` (+ trailer).

---

### Task 3: Verificación

- [ ] `npx vitest run src/routes/__tests__/dashboard-prelaunch.routes.test.ts` — todo verde (incl. describe perfil).
- [ ] `npx tsc --noEmit 2>&1 | grep -c "error TS"` — sin nuevos (~195).
- [ ] `cd frontend && npm run build` — limpio.
- [ ] `npm test` — baseline (11 env-dependent, 0 nuevos).

## Self-Review

Spec coverage: A→T2S1-S2, B→T2S3, C→T2S4, D→T1S3-S4, E→T1S4. Testing→T1S1+T3. Copy centralizado en el spec (tabla §A) referenciado verbatim — no re-copiado acá para evitar divergencia (el implementer lee el spec, instrucción explícita). Type consistency: `PATCH /me` shape consistente entre endpoint (Step 3) y tests (Step 1). Placeholders: los puntos "mirar el árbol real" (render del Navbar, refresh del auth context) son adaptaciones dirigidas con grep exacto.
