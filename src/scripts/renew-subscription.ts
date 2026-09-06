#!/usr/bin/env npx tsx
/**
 * renew-subscription.ts — renueva la licencia de un usuario.
 *
 * POR QUÉ EXISTE: el acceso lo decide `getUserAccessMode`, que lee la fila MÁS
 * RECIENTE de `subscriptions`. No hay pantalla de admin para renovar: solo
 * existe el checkout de MercadoPago y el webhook. Cuando hay que extenderle la
 * licencia a alguien a mano —una prueba extendida, un pago fuera de la
 * plataforma, un usuario interno— esto es lo que hay.
 *
 * POR QUÉ NO ES SQL SUELTO: hay un índice único parcial que permite UNA sola
 * suscripción no-terminal por usuario. Un INSERT a mano sin cerrar la anterior
 * explota contra el índice; y un UPDATE sobre la fila equivocada deja al usuario
 * con dos filas vivas y un acceso que depende de cuál quedó más nueva.
 *
 * DRY-RUN POR DEFECTO. Toca facturación de un usuario real: primero se mira,
 * después se aplica.
 *
 * USO
 *   npx tsx src/scripts/renew-subscription.ts --email juan@x.com              # dry-run
 *   npx tsx src/scripts/renew-subscription.ts --email juan@x.com --apply
 *   npx tsx src/scripts/renew-subscription.ts --email juan@x.com --months 12 --apply
 *   npx tsx src/scripts/renew-subscription.ts --email juan@x.com --plan pro_plus --apply
 *
 * Contra producción, vía Railway (el servicio Postgres expone DATABASE_PUBLIC_URL;
 * la DATABASE_URL interna apunta a postgres.railway.internal y no resuelve desde acá):
 *
 *   railway run --service Postgres --environment production -- \
 *     npx tsx src/scripts/renew-subscription.ts --email … [--apply]
 *
 * El script prefiere DATABASE_PUBLIC_URL cuando está presente, así no hay que
 * armar la variable en el shell — `set X=%Y% && cmd` en cmd.exe arrastra el
 * espacio previo al `&&` DENTRO del valor, y Postgres termina buscando una base
 * llamada "railway " (con espacio). Se resuelve y se trimea acá, una sola vez.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Antes de importar el pool: `src/config/db.js` lo construye en tiempo de
// import leyendo process.env.DATABASE_URL, así que la elección va primero.
const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
if (publicUrl) process.env.DATABASE_URL = publicUrl;
else if (process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.DATABASE_URL.trim();

const { pool, withTransaction } = await import('../config/db.js');

interface SubRow {
  id: number;
  status: string;
  plan_id: number;
  plan_name: string | null;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  created_at: Date;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fmt = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : '—');

/**
 * Espejo de `getUserAccessMode` (access-gate.service.ts) para poder mostrar el
 * ANTES y el DESPUÉS sin levantar el servidor. Si aquella cambia, esto también.
 */
function accessMode(sub: SubRow | null, now = Date.now()): string {
  if (!sub) return 'full (sin fila — grandfathered)';
  switch (sub.status) {
    case 'active':
    case 'past_due':
      return 'full';
    case 'trial':
      return sub.trial_ends_at && sub.trial_ends_at.getTime() > now ? 'full' : 'trial_expired_readonly';
    case 'cancelled':
      if (sub.current_period_end && sub.current_period_end.getTime() > now) return 'full';
      if (sub.trial_ends_at && sub.trial_ends_at.getTime() > now) return 'full';
      return 'trial_expired_readonly';
    case 'expired':
      return 'trial_expired_readonly';
    default:
      return 'full (estado desconocido — falla abierta)';
  }
}

async function main(): Promise<void> {
  const email = arg('email');
  const apply = process.argv.includes('--apply');
  const months = Number(arg('months') ?? 12);
  const planName = arg('plan');

  if (!email) { console.error('Falta --email'); process.exit(1); }
  if (!Number.isFinite(months) || months <= 0 || months > 120) {
    console.error('--months tiene que ser un número entre 1 y 120'); process.exit(1);
  }

  const u = await pool.query(
    `SELECT u.id, u.email, u.name, u.plan_id, p.name AS plan_name
       FROM users u LEFT JOIN plans p ON p.id = u.plan_id
      WHERE LOWER(u.email) = LOWER($1) AND u.deleted_at IS NULL`,
    [email],
  );
  if (u.rows.length === 0) { console.error(`No hay usuario activo con email ${email}`); process.exit(1); }
  const user = u.rows[0];

  const subs = await pool.query(
    `SELECT s.id, s.status, s.plan_id, p.name AS plan_name, s.trial_ends_at,
            s.current_period_end, s.created_at
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
    [user.id],
  );
  const latest: SubRow | null = subs.rows[0] ?? null;

  // Plan destino: el que se pidió, el de la suscripción vigente, o el del usuario.
  let targetPlanId = latest?.plan_id ?? user.plan_id;
  let targetPlanName = latest?.plan_name ?? user.plan_name;
  if (planName) {
    const p = await pool.query(`SELECT id, name FROM plans WHERE name = $1`, [planName]);
    if (p.rows.length === 0) { console.error(`No existe el plan "${planName}"`); process.exit(1); }
    targetPlanId = p.rows[0].id;
    targetPlanName = p.rows[0].name;
  }

  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + months);

  console.log(`\n=== Renovación de licencia ${apply ? '(APLICANDO)' : '(DRY-RUN)'} ===`);
  console.log(`Usuario:  ${user.name ?? '—'} <${user.email}>  (id ${user.id})`);
  console.log(`Plan del usuario: ${user.plan_name ?? user.plan_id}\n`);

  console.log('Suscripciones existentes (más reciente primero):');
  if (subs.rows.length === 0) console.log('  (ninguna — el usuario está grandfathered)');
  for (const s of subs.rows as SubRow[]) {
    const marca = s.id === latest?.id ? '→' : ' ';
    console.log(`  ${marca} #${s.id}  ${s.status.padEnd(9)} plan=${s.plan_name ?? s.plan_id}` +
      `  trial_hasta=${fmt(s.trial_ends_at)}  periodo_hasta=${fmt(s.current_period_end)}`);
  }

  console.log(`\nAcceso AHORA:     ${accessMode(latest)}`);
  console.log(`Acceso DESPUÉS:   full (activa hasta ${fmt(periodEnd)})`);
  console.log(`Qué se va a hacer: cerrar la suscripción viva —si la hay— y crear una`);
  console.log(`                   'active' en ${targetPlanName} por ${months} mes(es).`);

  if (!apply) {
    console.log('\nDRY-RUN: no se modificó nada. Revisá lo de arriba y volvé a correr con --apply.\n');
    await pool.end();
    return;
  }

  await withTransaction(async () => {
    // Cerrar la viva primero: el índice único parcial permite UNA sola
    // suscripción no-terminal por usuario, así que insertar sin cerrar explota.
    await pool.query(
      `UPDATE subscriptions
          SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND status IN ('trial', 'active', 'past_due')`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, provider, status, billing_period, current_period_end)
       VALUES ($1, $2, 'manual', 'active', $3, $4)`,
      [user.id, targetPlanId, months >= 12 ? 'yearly' : 'monthly', periodEnd],
    );
    // El plan del usuario manda para el gate de features; se alinea con la
    // suscripción para que no queden diciendo cosas distintas.
    await pool.query(`UPDATE users SET plan_id = $1 WHERE id = $2`, [targetPlanId, user.id]);
  });

  const after = await pool.query(
    `SELECT s.id, s.status, s.plan_id, p.name AS plan_name, s.trial_ends_at,
            s.current_period_end, s.created_at
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [user.id],
  );
  const nueva = after.rows[0] as SubRow;
  console.log(`\n✅ Licencia renovada — suscripción #${nueva.id}, ${nueva.status}, ` +
    `${nueva.plan_name}, hasta ${fmt(nueva.current_period_end)}`);
  console.log(`   Acceso verificado: ${accessMode(nueva)}\n`);
  await pool.end();
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error('Falló la renovación:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

export { accessMode };
