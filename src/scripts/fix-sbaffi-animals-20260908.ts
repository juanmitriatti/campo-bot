/**
 * fix-sbaffi-animals-20260908.ts — repara en PROD lo que quedó mal en la
 * cuenta de un usuario real (WhatsApp, 8 sep 2026) por tres bugs ya
 * corregidos en código (ver CLAUDE.md § "Animal individual + RFID"):
 *
 *   1. "la 10 es macho, cambialo" entró como caravana nueva → la 0000010 quedó
 *      reemplazada por LA10ESMACHOCAMBIALO.  → se retira la frase y vuelve a
 *      estar vigente la 0000010 (con evento de re-identificación, no se borra nada).
 *   2. "se murió de sobredosis la vaca 10" descontó el grupo pero el animal
 *      siguió "activo".  → status muerto + egreso_muerte enlazado al movimiento
 *      de muerte de ese día.
 *   3. Las 10 altas quedaron "sin ubicación" al lado del grupo de vacas en
 *      La tapera.  → field/plot/group del grupo + recount de individualized_count.
 *   4. "vacuné 3 vacas con x29" + "la 1, la 2 y la 3 son las que vacuné" quedó
 *      en respond_text (nada registrado); "vacuné la 0000010 con paracetamol"
 *      quedó a nivel grupo.  → se enlazan esos dos eventos a los animales.
 *   5. "la 10 es macho" → sex='M' en el animal (la categoría no se toca).
 *
 * Es UN caso: no generaliza, no corre solo. Dry-run por default.
 *
 *   railway run --service campo-bot --environment production -- npx tsx src/scripts/fix-sbaffi-animals-20260908.ts
 *   ... --apply    # aplica de verdad (todo en una transacción)
 *   ... --phone 549XXXXXXXXXX   # otro teléfono (default: el del caso)
 */

import { pool, withTransaction } from '../config/db.js';

const APPLY = process.argv.includes('--apply');
const phoneArgIdx = process.argv.indexOf('--phone');
const PHONE = phoneArgIdx > 0 ? process.argv[phoneArgIdx + 1] : '5492364311397';
const DAY = '2026-09-08';
const BOGUS = 'LA10ESMACHOCAMBIALO';

type Row = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await pool.query(sql, params)).rows as Row[];
const log = (m: string) => console.log(`${APPLY ? '[APPLY]' : '[DRY]'} ${m}`);

async function main(): Promise<void> {
  const users = await q(`SELECT id, name FROM users WHERE phone_number = $1 AND deleted_at IS NULL`, [PHONE]);
  if (users.length !== 1) throw new Error(`Esperaba 1 usuario con teléfono ${PHONE}, hay ${users.length}`);
  const userId = Number(users[0].id);
  log(`usuario ${userId} (${String(users[0].name)})`);

  // --- Grupo de vacas en La tapera -----------------------------------------
  const groups = await q(
    `SELECT lg.id, lg.count, lg.individualized_count, lg.plot_id, lg.field_id, p.name AS plot
       FROM livestock_groups lg JOIN plots p ON p.id = lg.plot_id
      WHERE lg.user_id = $1 AND lg.category = 'vaca' AND lg.deleted_at IS NULL AND lower(p.name) = 'la tapera'`,
    [userId],
  );
  if (groups.length !== 1) throw new Error(`Esperaba 1 grupo de vacas en La tapera, hay ${groups.length}`);
  const g = groups[0];
  log(`grupo vaca @ ${String(g.plot)}: count=${String(g.count)} individualized=${String(g.individualized_count)}`);

  // --- Animales del usuario (los 10 con caravana 0000001..0000010) -----------
  const animals = await q(
    `SELECT a.id, a.status, a.sex, a.plot_id, a.group_id,
            (SELECT ai.value_normalized FROM animal_identifications ai
              WHERE ai.animal_id = a.id AND ai.is_current ORDER BY ai.assigned_date DESC LIMIT 1) AS tag
       FROM animals a WHERE a.user_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
    [userId],
  );
  log(`animales: ${animals.map((a) => `${String(a.tag)}[${String(a.status)}${a.plot_id ? '' : ',sin lote'}]`).join(' ')}`);

  const bogus = animals.find((a) => a.tag === BOGUS);
  const byTag = (t: string) => animals.find((a) => a.tag === t);
  const a10 = bogus ?? byTag('0000010');
  if (!a10) throw new Error('No encontré al animal 10 (ni por 0000010 ni por la frase)');

  // --- Eventos sanitarios a enlazar -----------------------------------------
  const x29 = await q(
    `SELECT id, animals_affected FROM domain_events
      WHERE user_id = $1 AND event_type = 'health_event' AND lower(product) = 'x29' AND deleted_at IS NULL AND event_date = $2`,
    [userId, DAY],
  );
  const paracetamol = await q(
    `SELECT id FROM domain_events
      WHERE user_id = $1 AND event_type = 'health_event' AND lower(product) = 'paracetamol' AND deleted_at IS NULL AND event_date = $2`,
    [userId, DAY],
  );
  log(`evento x29: ${x29.map((e) => String(e.id)).join(',') || 'ninguno'} · paracetamol: ${paracetamol.map((e) => String(e.id)).join(',') || 'ninguno'}`);

  // --- Movimiento de muerte del día ------------------------------------------
  const death = await q(
    `SELECT id FROM livestock_movements
      WHERE user_id = $1 AND movement_type = 'muerte' AND source_group_id = $2 AND count = 1 AND movement_date = $3
      ORDER BY created_at DESC LIMIT 1`,
    [userId, g.id, DAY],
  );
  log(`movimiento de muerte: ${death[0]?.id ? String(death[0].id) : 'ninguno (el egreso quedará sin movimiento enlazado)'}`);

  if (!APPLY) { log('dry-run: nada escrito. Repetí con --apply.'); return; }

  await withTransaction(async () => {
    // 1. Caravana: retirar la frase, reponer la 0000010.
    if (bogus) {
      const idents = await q(
        `SELECT id, value_normalized, is_current FROM animal_identifications WHERE animal_id = $1 ORDER BY assigned_date, created_at`,
        [bogus.id],
      );
      const bad = idents.find((i) => i.value_normalized === BOGUS);
      const good = idents.find((i) => i.value_normalized === '0000010');
      if (!bad || !good) throw new Error('No encontré el par de identificaciones (frase + 0000010)');
      await q(`UPDATE animal_identifications SET is_current = false, removed_date = CURRENT_DATE, removal_reason = 'error_carga',
                      notes = COALESCE(notes, '') || ' [fix 2026-09-08: una frase entró como caravana]' WHERE id = $1`, [bad.id]);
      await q(`UPDATE animal_identifications SET is_current = true, removed_date = NULL, removal_reason = NULL WHERE id = $1`, [good.id]);
      await q(
        `INSERT INTO animal_events (user_id, animal_id, event_type, event_date, from_ref, to_ref, text_value, source)
         VALUES ($1, $2, 'reidentificacion', CURRENT_DATE, $3, '0000010', 'corrección: la caravana anterior era una frase', 'manual')`,
        [userId, bogus.id, BOGUS],
      );
      log('1. caravana 0000010 vigente de nuevo');
    }

    // 3. Ubicación + grupo de todos los animales activos sin lote.
    const noLoc = animals.filter((a) => !a.plot_id);
    if (noLoc.length > 0) {
      await q(
        `UPDATE animals SET field_id = $2, plot_id = $3, group_id = $4, updated_at = NOW()
          WHERE id = ANY($1::uuid[]) AND user_id = $5`,
        [noLoc.map((a) => a.id), g.field_id, g.plot_id, g.id, userId],
      );
      log(`3. ${noLoc.length} animales ubicados en La tapera y colgados del grupo`);
    }

    // 2. Muerte del animal 10 (si todavía figura activo).
    if (a10.status === 'activo') {
      await q(`UPDATE animals SET status = 'muerto', exit_date = $2, updated_at = NOW() WHERE id = $1`, [a10.id, DAY]);
      await q(
        `INSERT INTO animal_events (user_id, animal_id, event_type, event_date, livestock_movement_id, to_ref, text_value, source)
         VALUES ($1, $2, 'egreso_muerte', $3, $4, 'muerto', 'sobredosis', 'manual')`,
        [userId, a10.id, DAY, death[0]?.id ?? null],
      );
      log('2. animal 0000010 → muerto (egreso_muerte enlazado)');
    }

    // 5. Sexo del 10, como lo pidió el usuario.
    await q(`UPDATE animals SET sex = 'M', updated_at = NOW() WHERE id = $1 AND sex <> 'M'`, [a10.id]);
    log('5. animal 0000010 sex=M');

    // 4. Enlaces sanitarios.
    const link = async (eventId: unknown, tags: string[], product: string) => {
      for (const t of tags) {
        const a = byTag(t);
        if (!a) { log(`   ⚠️ sin animal ${t}, salto`); continue; }
        const dup = await q(`SELECT 1 FROM animal_events WHERE animal_id = $1 AND domain_event_id = $2`, [a.id, eventId]);
        if (dup.length > 0) continue;
        await q(
          `INSERT INTO animal_events (user_id, animal_id, event_type, event_date, domain_event_id, text_value, source)
           VALUES ($1, $2, 'vacunacion', $3, $4, $5, 'manual')`,
          [userId, a.id, DAY, eventId, product],
        );
      }
    };
    if (x29[0]) { await link(x29[0].id, ['0000001', '0000002', '0000003'], 'x29'); log('4. x29 → 0000001, 0000002, 0000003'); }
    if (paracetamol[0]) { await link(paracetamol[0].id, [String(a10.tag)], 'paracetamol'); log('4. paracetamol → 0000010'); }

    // Recount del grupo desde la verdad (solo activos).
    await q(
      `UPDATE livestock_groups lg SET individualized_count = (
         SELECT COUNT(*) FROM animals a WHERE a.group_id = lg.id AND a.deleted_at IS NULL AND a.status = 'activo'),
         updated_at = NOW() WHERE lg.id = $1`,
      [g.id],
    );
    const after = await q(`SELECT count, individualized_count FROM livestock_groups WHERE id = $1`, [g.id]);
    log(`grupo después: count=${String(after[0].count)} individualized=${String(after[0].individualized_count)}`);
  });
  log('listo.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await pool.end().catch(() => {}); });
