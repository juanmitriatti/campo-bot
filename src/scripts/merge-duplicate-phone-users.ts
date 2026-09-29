/**
 * merge-duplicate-phone-users.ts — resuelve las cuentas que quedaron PARTIDAS
 * porque el mismo teléfono se guardó en dos formatos distintos.
 *
 * EL PROBLEMA QUE ARREGLA
 * `users.phone_number` es UNIQUE, pero tres caminos lo escribían distinto: el
 * webhook de WhatsApp (`549...`), el OTP de la web (`+549...`, y encima a veces
 * sin el 9 de celular) y el alta manual del admin. La misma persona podía
 * terminar con DOS filas de usuario, cada una con sus campos, gastos e
 * historial. La migración 122 canoniza la columna, pero SALTEA justamente estos
 * casos: normalizar una de las dos filas violaría el UNIQUE.
 *
 * POR QUÉ ES UN SCRIPT Y NO LA MIGRACIÓN
 * Fusionar dos cuentas mueve datos de negocio entre usuarios. Una migración
 * corre sola al arrancar el proceso; eso no puede pasar sin que un humano haya
 * mirado antes qué se va a tocar. Mismo criterio que `merge-duplicate-breeds.ts`.
 *
 * QUÉ HACE, EXACTAMENTE
 *   1. Agrupa los usuarios vivos por teléfono CANÓNICO y se queda con los
 *      grupos de 2 o más.
 *   2. Elige sobreviviente: el que tiene cuenta web (email) y, entre esos, el
 *      verificado más antiguo. Una cuenta con email y contraseña es con la que
 *      la persona entra al dashboard; perderla es lo más caro.
 *   3. REPUNTA al sobreviviente todo lo que cuelga del perdedor (campos,
 *      gastos, ingresos, eventos, hacienda, stock, recordatorios, membresías…).
 *      Nada se borra: los datos siguen contando la misma historia, apuntando a
 *      la cuenta que queda.
 *   4. Soft-deletea al perdedor (`deleted_at`) y le libera el teléfono, para que
 *      el UNIQUE deje pasar la canonización del sobreviviente.
 *   5. Deja el teléfono canónico en el sobreviviente.
 *
 * NO fusiona si los dos lados tienen email REAL y distinto: son dos personas (o
 * dos cuentas deliberadas) y elegir por nosotros destruiría una. Esos casos se
 * listan para resolver a mano.
 *
 * USO
 *   npx tsx src/scripts/merge-duplicate-phone-users.ts            # DRY-RUN (default)
 *   npx tsx src/scripts/merge-duplicate-phone-users.ts --apply    # aplica de verdad
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool, withTransaction } from '../config/db.js';
import { normalizePhone, isTelegramPlaceholder } from '../utils/phone.js';

export interface UserRow {
  id: number;
  phone_number: string;
  email: string | null;
  name: string | null;
  whatsapp_verified_at: Date | null;
}

export interface MergePlan {
  canonical: string;
  survivor: UserRow;
  losers: UserRow[];
  /** Cuando no se puede decidir solo: emails reales distintos. */
  blocked: boolean;
  reason?: string;
}

/**
 * Tablas que apuntan a `users(id)` y hay que repuntar al sobreviviente.
 * `field_members` se trata aparte porque tiene UNIQUE(field_id, user_id).
 */
const OWNED_TABLES: { table: string; column: string }[] = [
  { table: 'fields', column: 'user_id' },
  { table: 'expenses', column: 'user_id' },
  { table: 'incomes', column: 'user_id' },
  { table: 'domain_events', column: 'user_id' },
  { table: 'agro_observations', column: 'user_id' },
  { table: 'crop_scoutings', column: 'user_id' },
  { table: 'rainfall', column: 'user_id' },
  { table: 'livestock_groups', column: 'user_id' },
  { table: 'livestock_movements', column: 'user_id' },
  { table: 'stock_items', column: 'user_id' },
  { table: 'stock_movements', column: 'user_id' },
  { table: 'documents', column: 'user_id' },
  { table: 'task_reminders', column: 'user_id' },
  { table: 'budgets', column: 'user_id' },
];

/** Elige sobreviviente: cuenta web primero, después la verificada más antigua. */
export function pickSurvivor(rows: UserRow[]): UserRow {
  const withEmail = rows.filter((r) => r.email);
  const candidates = withEmail.length > 0 ? withEmail : rows;
  return [...candidates].sort((a, b) => {
    const av = a.whatsapp_verified_at ? new Date(a.whatsapp_verified_at).getTime() : Infinity;
    const bv = b.whatsapp_verified_at ? new Date(b.whatsapp_verified_at).getTime() : Infinity;
    if (av !== bv) return av - bv;
    return a.id - b.id;
  })[0];
}

export function buildPlans(rows: UserRow[]): MergePlan[] {
  const byCanonical = new Map<string, UserRow[]>();
  for (const r of rows) {
    if (!r.phone_number || isTelegramPlaceholder(r.phone_number)) continue;
    const c = normalizePhone(r.phone_number);
    if (!c) continue;
    const list = byCanonical.get(c) ?? [];
    list.push(r);
    byCanonical.set(c, list);
  }

  const plans: MergePlan[] = [];
  for (const [canonical, group] of byCanonical) {
    if (group.length < 2) continue;
    const survivor = pickSurvivor(group);
    const losers = group.filter((r) => r.id !== survivor.id);

    // Dos emails reales y distintos = dos personas. No se decide por ellas.
    const emails = new Set(group.map((r) => r.email).filter(Boolean) as string[]);
    const blocked = emails.size > 1;

    plans.push({
      canonical,
      survivor,
      losers,
      blocked,
      reason: blocked ? `emails distintos: ${[...emails].join(', ')}` : undefined,
    });
  }
  return plans;
}

async function loadUsers(): Promise<UserRow[]> {
  const { rows } = await pool.query(
    `SELECT id, phone_number, email, name, whatsapp_verified_at
       FROM users
      WHERE phone_number IS NOT NULL
        AND phone_number !~ '^tg_'
        AND deleted_at IS NULL
      ORDER BY id`,
  );
  return rows;
}

async function applyPlan(plan: MergePlan): Promise<void> {
  await withTransaction(async () => {
    for (const loser of plan.losers) {
      for (const { table, column } of OWNED_TABLES) {
        await pool.query(
          `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2`,
          [plan.survivor.id, loser.id],
        );
      }

      // Membresías: el sobreviviente puede YA tener la fila de ese campo, y el
      // UNIQUE(field_id, user_id) rechazaría el UPDATE. Se mueve lo que no
      // choca y se descarta el resto (es la misma membresía, duplicada).
      await pool.query(
        `UPDATE field_members fm SET user_id = $1
          WHERE fm.user_id = $2
            AND NOT EXISTS (
              SELECT 1 FROM field_members x WHERE x.field_id = fm.field_id AND x.user_id = $1
            )`,
        [plan.survivor.id, loser.id],
      );
      await pool.query(`DELETE FROM field_members WHERE user_id = $1`, [loser.id]);

      // Se libera el teléfono ANTES de canonizar al sobreviviente: si no, el
      // UNIQUE rechaza el UPDATE de abajo.
      await pool.query(
        `UPDATE users
            SET deleted_at = NOW(),
                phone_number = NULL,
                whatsapp_verified_at = NULL
          WHERE id = $1`,
        [loser.id],
      );
    }

    await pool.query(`UPDATE users SET phone_number = $1 WHERE id = $2`, [
      plan.canonical,
      plan.survivor.id,
    ]);
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const rows = await loadUsers();
  const plans = buildPlans(rows);

  const actionable = plans.filter((p) => !p.blocked);
  const blocked = plans.filter((p) => p.blocked);

  console.log(`\nCuentas partidas por formato de teléfono: ${plans.length}\n`);

  for (const p of actionable) {
    console.log(`• ${p.canonical}`);
    console.log(
      `  sobrevive:  #${p.survivor.id} ${p.survivor.email ?? '(sin email)'} "${p.survivor.name ?? ''}" [${p.survivor.phone_number}]`,
    );
    for (const l of p.losers) {
      console.log(
        `  se fusiona: #${l.id} ${l.email ?? '(sin email)'} "${l.name ?? ''}" [${l.phone_number}]`,
      );
    }
    console.log('');
  }

  for (const p of blocked) {
    console.log(`⚠️  ${p.canonical} — NO se toca: ${p.reason}`);
    for (const r of [p.survivor, ...p.losers]) {
      console.log(`    #${r.id} ${r.email ?? '(sin email)'} [${r.phone_number}]`);
    }
    console.log('');
  }

  if (plans.length === 0) {
    console.log('Nada para fusionar.\n');
    await pool.end();
    return;
  }

  if (!apply) {
    console.log('DRY-RUN: no se modificó nada. Revisá el detalle de arriba y volvé a correr con --apply.\n');
    await pool.end();
    return;
  }

  for (const p of actionable) await applyPlan(p);
  console.log(`Fusiones aplicadas: ${actionable.length}`);
  if (blocked.length > 0) console.log(`Pendientes de resolver a mano: ${blocked.length}`);
  console.log('');
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
