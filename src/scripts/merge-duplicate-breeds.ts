/**
 * merge-duplicate-breeds.ts — unifica la grafía de razas y FUSIONA los grupos de
 * hacienda que hoy están partidos solo por cómo se escribió la raza.
 *
 * EL PROBLEMA QUE ARREGLA
 * `livestock_groups.breed` es texto libre y forma parte del índice único
 * `(plot_id, category, breed)`. Un usuario que cargó 20 vacas "Angus" y después
 * 10 "angus" en el mismo lote tiene DOS grupos, y `list_livestock` le contesta
 * "20 y 10" en vez de "30". Los datos ya están así en producción.
 *
 * POR QUÉ ES UN SCRIPT Y NO UNA MIGRACIÓN
 * Fusionar cambia `count` (existencias reales) y repunta el ledger de
 * movimientos. Una migración corre sola al arrancar el proceso; eso no puede
 * pasar sin que un humano haya mirado antes qué se va a tocar. La migración 111
 * solo crea el catálogo y enlaza `breed_id` sin mover nada.
 *
 * QUÉ HACE, EXACTAMENTE
 *   1. Agrupa los grupos vivos por (user_id, ubicación, categoría, raza canónica).
 *   2. En cada colisión elige sobreviviente = el `created_at` más antiguo.
 *   3. Suma los `count` de los perdedores al sobreviviente.
 *   4. REPUNTA `livestock_movements.source_group_id`/`dest_group_id` de los
 *      perdedores al sobreviviente. El ledger histórico NO se borra ni se
 *      reescribe en su contenido: sigue contando la misma historia, apuntando al
 *      grupo que ahora existe.
 *   5. Soft-delete de los perdedores dejando la traza en `notes`.
 *   6. Normaliza `breed` al nombre canónico y setea `breed_id` en todo grupo vivo.
 *
 * NO emite un movimiento de `ajuste`: no hubo cambio de existencias reales, solo
 * dejaron de estar partidas en dos filas. Inventar un ajuste ensuciaría el
 * historial con un movimiento que nunca ocurrió en el campo.
 *
 * USO
 *   npx tsx src/scripts/merge-duplicate-breeds.ts             # DRY-RUN (default)
 *   npx tsx src/scripts/merge-duplicate-breeds.ts --apply     # aplica de verdad
 *   npx tsx src/scripts/merge-duplicate-breeds.ts --user 42   # acota a un usuario
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool, withTransaction } from '../config/db.js';
import { canonicalBreedName, normalizeBreed } from '../utils/livestock-breeds.js';

export interface GroupRow {
  id: string;
  user_id: number;
  plot_id: number | null;
  corral_id: number | null;
  category: string;
  breed: string | null;
  count: number;
  created_at: Date;
  field_name: string | null;
  plot_name: string | null;
  corral_name: string | null;
}

export interface MergePlan {
  key: string;
  label: string;
  canonicalBreed: string | null;
  survivor: GroupRow;
  losers: GroupRow[];
  totalCount: number;
}

/** Clave de colisión: misma ubicación física, misma categoría, misma raza canónica. */
export function collisionKey(g: GroupRow): string {
  const canonical = canonicalBreedName(g.breed);
  // La comparación es case/acento-insensitive; `canonicalBreedName` ya devuelve la
  // forma del catálogo cuando matchea, y el texto limpio cuando no.
  const breedKeyPart = canonical ? canonical.toLowerCase() : '∅';
  return [g.user_id, g.plot_id ?? 'p∅', g.corral_id ?? 'c∅', g.category, breedKeyPart].join('|');
}

function describe(g: GroupRow): string {
  const loc = g.plot_name ? `lote ${g.plot_name}` : g.corral_name ? `corral ${g.corral_name}` : 'sin ubicación';
  return `${g.field_name ?? '?'} / ${loc} / ${g.category} / "${g.breed ?? 'sin raza'}" (${g.count})`;
}

async function loadGroups(userId?: number): Promise<GroupRow[]> {
  const params: number[] = [];
  let where = 'lg.deleted_at IS NULL';
  if (userId != null) {
    params.push(userId);
    where += ` AND lg.user_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT lg.id, lg.user_id, lg.plot_id, lg.corral_id, lg.category, lg.breed,
            lg.count, lg.created_at,
            f.name AS field_name, p.name AS plot_name, c.name AS corral_name
       FROM livestock_groups lg
       LEFT JOIN fields f ON lg.field_id = f.id
       LEFT JOIN plots  p ON lg.plot_id  = p.id
       LEFT JOIN corrals c ON lg.corral_id = c.id
      WHERE ${where}
      ORDER BY lg.created_at ASC, lg.id ASC`,
    params,
  );
  return rows as GroupRow[];
}

export function buildPlans(groups: GroupRow[]): MergePlan[] {
  const byKey = new Map<string, GroupRow[]>();
  for (const g of groups) {
    const k = collisionKey(g);
    const bucket = byKey.get(k);
    if (bucket) bucket.push(g);
    else byKey.set(k, [g]);
  }

  const plans: MergePlan[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.length < 2) continue;
    // `loadGroups` ya viene ordenado por created_at ASC → el primero es el más viejo.
    const [survivor, ...losers] = bucket;
    plans.push({
      key,
      label: describe(survivor),
      canonicalBreed: canonicalBreedName(survivor.breed),
      survivor,
      losers,
      totalCount: bucket.reduce((s, g) => s + Number(g.count), 0),
    });
  }
  return plans;
}

async function applyPlans(plans: MergePlan[]): Promise<void> {
  for (const plan of plans) {
    // Una transacción por fusión: si una falla, las anteriores quedan hechas y
    // el script se puede volver a correr (es idempotente — la fusión ya aplicada
    // deja de aparecer como colisión).
    await withTransaction(async () => {
      const loserIds = plan.losers.map((l) => l.id);

      await pool.query(
        `UPDATE livestock_movements SET source_group_id = $1 WHERE source_group_id = ANY($2::uuid[])`,
        [plan.survivor.id, loserIds],
      );
      await pool.query(
        `UPDATE livestock_movements SET dest_group_id = $1 WHERE dest_group_id = ANY($2::uuid[])`,
        [plan.survivor.id, loserIds],
      );

      // Los perdedores se retiran ANTES de reescribir la raza del sobreviviente.
      // Al revés explota: si el sobreviviente es "angus" y un perdedor ya es
      // "Angus", pasar el sobreviviente a la grafía canónica lo hace chocar
      // contra el perdedor todavía vivo en `uq_livestock_groups_plot`.
      await pool.query(
        `UPDATE livestock_groups
            SET deleted_at = NOW(),
                count = 0,
                notes = COALESCE(notes || E'\\n', '') || $1,
                updated_at = NOW()
          WHERE id = ANY($2::uuid[])`,
        [`Fusionado en el grupo ${plan.survivor.id} por unificación de raza (script merge-duplicate-breeds).`, loserIds],
      );

      await pool.query(
        `UPDATE livestock_groups
            SET count = $1,
                breed = $2,
                breed_id = (SELECT id FROM livestock_breeds WHERE code = $3),
                updated_at = NOW()
          WHERE id = $4`,
        [
          plan.totalCount,
          plan.canonicalBreed,
          normalizeBreed(plan.survivor.breed)?.code ?? null,
          plan.survivor.id,
        ],
      );
    });
  }
}

/** Normaliza `breed`/`breed_id` en los grupos que NO colisionan con nadie. */
async function normalizeRemaining(userId?: number): Promise<number> {
  const groups = await loadGroups(userId);
  let touched = 0;
  for (const g of groups) {
    const canonical = canonicalBreedName(g.breed);
    const def = normalizeBreed(g.breed);
    if (canonical === g.breed && def === null) continue;
    await pool.query(
      `UPDATE livestock_groups
          SET breed = $1,
              breed_id = COALESCE((SELECT id FROM livestock_breeds WHERE code = $2), breed_id),
              updated_at = NOW()
        WHERE id = $3 AND (breed IS DISTINCT FROM $1 OR breed_id IS NULL)`,
      [canonical, def?.code ?? null, g.id],
    );
    touched++;
  }
  return touched;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const userArgIdx = args.indexOf('--user');
  const userId = userArgIdx >= 0 ? Number(args[userArgIdx + 1]) : undefined;

  if (userId != null && Number.isNaN(userId)) {
    console.error('--user necesita un id numérico');
    process.exit(1);
  }

  const groups = await loadGroups(userId);
  const plans = buildPlans(groups);

  console.log(`\n=== Fusión de razas duplicadas ${apply ? '(APLICANDO)' : '(DRY-RUN)'} ===`);
  console.log(`Grupos vivos analizados: ${groups.length}${userId != null ? ` (user ${userId})` : ''}`);
  console.log(`Colisiones detectadas:   ${plans.length}\n`);

  if (plans.length === 0) {
    console.log('No hay grupos partidos por grafía de raza. Nada para fusionar.');
  }

  for (const plan of plans) {
    console.log(`• ${plan.label}`);
    console.log(`  raza canónica: ${plan.canonicalBreed ?? '(sin raza)'}`);
    console.log(`  sobrevive: ${plan.survivor.id}  count ${plan.survivor.count} → ${plan.totalCount}`);
    for (const l of plan.losers) {
      console.log(`  se fusiona: ${l.id}  "${l.breed ?? 'sin raza'}" (${l.count})`);
    }
    console.log('');
  }

  if (!apply) {
    console.log('DRY-RUN: no se modificó nada. Revisá el detalle de arriba y volvé a correr con --apply.\n');
    await pool.end();
    return;
  }

  await applyPlans(plans);
  const touched = await normalizeRemaining(userId);
  console.log(`Fusiones aplicadas: ${plans.length}`);
  console.log(`Grupos con raza normalizada: ${touched}\n`);
  await pool.end();
}

// Solo corre cuando se invoca el script directamente. Sin esta guarda, importar
// `buildPlans` desde un test dispararía la fusión contra la base.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error('Falló la fusión:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
