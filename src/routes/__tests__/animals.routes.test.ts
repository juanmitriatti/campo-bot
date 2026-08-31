/**
 * Tests HTTP de la API de animales individuales.
 *
 * Corren contra el app real (localhost:3000) con usuarios descartables, igual
 * que el resto de los tests de rutas. Se saltean enteros si el app no responde.
 *
 * Lo que importa acá y no se puede verificar a nivel servicio: el feature gate,
 * el scoping entre usuarios sobre ids que vienen del cliente, y que aplicar dos
 * veces el mismo lote devuelva 409 en vez de mover de nuevo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../config/db.js';
// Los helpers viven en un módulo aparte, NO en otro `*.test.ts`: importarlos
// desde un archivo de test hacía que Vitest re-ejecutara SUS describe, corriendo
// esa suite dos veces y chocando en el segundo registro (409).
import { appReachable, registerTestUser, api } from './routes-helpers.js';

let appUp = false;

beforeAll(async () => { appUp = await appReachable(); });

/** Sube al usuario a un plan con `livestock` y le crea campo + lotes. */
async function setupLivestockUser(slug: string) {
  const u = await registerTestUser(slug);
  await pool.query(`UPDATE users SET plan_id = 4 WHERE id = $1`, [u.userId]);
  const f = await pool.query(`INSERT INTO fields (user_id, name) VALUES ($1, $2) RETURNING id`, [u.userId, `Campo ${slug}`]);
  const fieldId = f.rows[0].id as number;
  const p1 = await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte') RETURNING id`, [fieldId]);
  const p2 = await pool.query(`INSERT INTO plots (field_id, name) VALUES ($1, 'Sur') RETURNING id`, [fieldId]);
  return { ...u, fieldId, norteId: p1.rows[0].id as number, surId: p2.rows[0].id as number, call: api(u.token) };
}

async function cleanup(userId: number) {
  for (let pass = 0; pass < 3; pass++) {
    await pool.query(`DELETE FROM animal_events WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM animal_identifications WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM animals WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM animal_id_batches WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM plots WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM field_members WHERE user_id = $1`, [userId]).catch(() => {});
    await pool.query(`DELETE FROM fields WHERE user_id = $1`, [userId]).catch(() => {});
  }
  await pool.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [userId]).catch(() => {});
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]).catch(() => {});
}

describe('API de animales individuales', () => {
  let ctx: Awaited<ReturnType<typeof setupLivestockUser>>;

  beforeAll(async () => {
    if (!appUp) return;
    ctx = await setupLivestockUser('animals');
  });

  afterAll(async () => {
    if (!appUp || !ctx) return;
    await cleanup(ctx.userId);
  });

  it('alta, listado y ficha', async () => {
    if (!appUp) return;

    const created = await ctx.call('/animals', {
      method: 'POST',
      body: JSON.stringify({
        category: 'vaca', rfid: '032010000700001', breed: 'angus',
        field_id: ctx.fieldId, plot_id: ctx.norteId,
      }),
    });
    expect(created.status).toBe(201);
    const { animal } = await created.json();
    expect(animal.sex).toBe('H');              // derivado de la categoría
    expect(animal.breed_name).toBe('Angus');   // raza normalizada

    const list = await (await ctx.call('/animals')).json();
    expect(list.total).toBe(1);
    expect(list.items[0].current_rfid).toBe('032010000700001');

    const detail = await (await ctx.call(`/animals/${animal.id}`)).json();
    expect(detail.identifications).toHaveLength(1);
    expect(detail.weights.overallGdpKgDay).toBeNull();   // sin pesajes, no inventa GDP

    const timeline = await (await ctx.call(`/animals/${animal.id}/timeline`)).json();
    expect(timeline.events.some((e: { event_type: string }) => e.event_type === 'identificacion')).toBe(true);
  });

  it('caravana duplicada → 409, no 500', async () => {
    if (!appUp) return;
    const r = await ctx.call('/animals', {
      method: 'POST',
      body: JSON.stringify({ category: 'vaca', rfid: '032010000700001', field_id: ctx.fieldId }),
    });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch(/ya está asignad/i);
  });

  it('lookup por caravana resuelve las tres grafías y 404 si no existe', async () => {
    if (!appUp) return;
    for (const form of ['032010000700001', '032 01 0000700001', '032-01-0000700001']) {
      const r = await ctx.call(`/animals/lookup?ref=${encodeURIComponent(form)}`);
      expect(r.status, `falló la forma ${form}`).toBe(200);
    }
    expect((await ctx.call('/animals/lookup?ref=032010000999999')).status).toBe(404);
  });

  it('reemplazo de caravana conserva el historial', async () => {
    if (!appUp) return;
    const { items } = await (await ctx.call('/animals')).json();
    const id = items[0].id;

    const r = await ctx.call(`/animals/${id}/identifications`, {
      method: 'POST',
      body: JSON.stringify({ value: '032010000700002', reason: 'perdida' }),
    });
    expect(r.status).toBe(201);

    const detail = await (await ctx.call(`/animals/${id}`)).json();
    expect(detail.identifications).toHaveLength(2);
    expect(detail.identifications.filter((i: { is_current: boolean }) => i.is_current)).toHaveLength(1);
    // La vieja ya no resuelve, la nueva sí.
    expect((await ctx.call('/animals/lookup?ref=032010000700001')).status).toBe(404);
    expect((await ctx.call('/animals/lookup?ref=032010000700002')).status).toBe(200);
  });

  describe('import de lecturas', () => {
    it('el preview NO mueve nada y cuadra los números', async () => {
      if (!appUp) return;
      const r = await ctx.call('/animals/import', {
        method: 'POST',
        body: JSON.stringify({ text: '032010000700002\n032010000700002\n032010000999998\nxx' }),
      });
      expect(r.status).toBe(200);
      const preview = await r.json();

      expect(preview.summary.raw).toBe(4);
      expect(preview.summary.matched).toBe(1);
      expect(preview.summary.duplicates).toBe(1);
      expect(preview.summary.unknown).toBe(1);
      expect(preview.summary.invalid).toBe(1);
      // Las cuatro categorías cierran contra el total leído.
      const s = preview.summary;
      expect(s.matched + s.duplicates + s.unknown + s.invalid).toBe(s.raw);

      // Nada se movió: el animal sigue en Norte.
      const { items } = await (await ctx.call('/animals')).json();
      expect(items[0].plot_name).toBe('Norte');
    });

    it('aplicar mueve; aplicar de nuevo devuelve 409 sin volver a mover', async () => {
      if (!appUp) return;
      const preview = await (await ctx.call('/animals/import', {
        method: 'POST',
        body: JSON.stringify({ text: '032010000700002' }),
      })).json();

      const first = await ctx.call(`/animals/batches/${preview.batchId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ plot_id: ctx.surId }),
      });
      expect(first.status).toBe(200);
      expect((await first.json()).moved).toBe(1);

      const second = await ctx.call(`/animals/batches/${preview.batchId}/apply`, {
        method: 'POST',
        body: JSON.stringify({ plot_id: ctx.norteId }),
      });
      expect(second.status).toBe(409);
      expect((await second.json()).alreadyApplied).toBe(true);

      // Quedó en Sur: el segundo intento no lo trajo de vuelta.
      const { items } = await (await ctx.call('/animals')).json();
      expect(items[0].plot_name).toBe('Sur');
    });

    it('sin destino → 400', async () => {
      if (!appUp) return;
      const preview = await (await ctx.call('/animals/import', {
        method: 'POST', body: JSON.stringify({ text: '032010000700002' }),
      })).json();
      const r = await ctx.call(`/animals/batches/${preview.batchId}/apply`, {
        method: 'POST', body: JSON.stringify({}),
      });
      expect(r.status).toBe(400);
    });
  });

  describe('seguridad', () => {
    it('un usuario NO ve ni toca los animales de otro', async () => {
      if (!appUp) return;
      const otro = await setupLivestockUser('animals-otro');
      try {
        const { items } = await (await ctx.call('/animals')).json();
        const ajenoId = items[0].id;

        // Ids que vienen del cliente: se re-scopean en el WHERE.
        expect((await otro.call(`/animals/${ajenoId}`)).status).toBe(404);
        expect((await otro.call(`/animals/${ajenoId}/timeline`)).status).toBe(404);
        expect((await otro.call('/animals/lookup?ref=032010000700002')).status).toBe(404);
        expect((await otro.call(`/animals/${ajenoId}/identifications`, {
          method: 'POST', body: JSON.stringify({ value: '032010000800001' }),
        })).status).toBe(404);

        expect((await (await otro.call('/animals')).json()).total).toBe(0);
      } finally {
        await cleanup(otro.userId);
      }
    });

    it('sin el feature livestock en el plan → 403', async () => {
      if (!appUp) return;
      const free = await registerTestUser('animals-free');
      try {
        // `registerTestUser` deja al usuario en el plan por defecto (sin hacienda).
        await pool.query(`UPDATE users SET plan_id = 1 WHERE id = $1`, [free.userId]);
        const call = api(free.token);
        expect((await call('/animals')).status).toBe(403);
        expect((await call('/animals/import', {
          method: 'POST', body: JSON.stringify({ text: '032010000700002' }),
        })).status).toBe(403);
      } finally {
        await cleanup(free.userId);
      }
    });
  });
});
