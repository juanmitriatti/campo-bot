import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../config/db.js';
import { createPipelineHarness, type PipelineHarness } from '../../../testing/integration/pipeline-harness.js';
import { AnimalService, DuplicateIdentifierError } from '../animal.service.js';
import { AnimalRepository } from '../animal.repository.js';

/**
 * Tests de INTEGRIDAD DE DATOS de la capa individual (spec §30).
 *
 * Corren contra la base real porque lo que se está probando son constraints,
 * transacciones y consistencia entre tablas — nada de eso se puede verificar con
 * mocks. Se auto-saltean si no hay DB, igual que el resto de la suite.
 *
 * El caso más importante de todos es el último: un grupo SIN animales
 * individualizados tiene que comportarse exactamente como antes de que existiera
 * esta capa. Esa es la garantía que hace segura toda la migración.
 */

let dbAvailable = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)('AnimalService — integridad de datos', () => {
  let h: PipelineHarness;
  let service: AnimalService;
  let repo: AnimalRepository;
  let fieldId: number;
  let plotNorteId: number;
  let plotSurId: number;
  let groupId: string;

  beforeAll(async () => {
    h = await createPipelineHarness('animal-service');
    service = new AnimalService();
    repo = new AnimalRepository();

    const f = await h.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'La Individual') RETURNING id`, [h.userId]);
    fieldId = f[0].id as number;
    const p1 = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Norte') RETURNING id`, [fieldId]);
    plotNorteId = p1[0].id as number;
    const p2 = await h.q(`INSERT INTO plots (field_id, name) VALUES ($1, 'Sur') RETURNING id`, [fieldId]);
    plotSurId = p2[0].id as number;

    const g = await h.q(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
       VALUES ($1, $2, $3, 'vaca', 'Angus', 100) RETURNING id`,
      [h.userId, fieldId, plotNorteId],
    );
    groupId = g[0].id as string;
  });

  afterAll(async () => { await h?.cleanup(); });

  const uid = () => Number(h.userId);

  describe('alta e identificación', () => {
    it('da de alta un animal con RFID y lo encuentra por su caravana', async () => {
      const { animal, identifications } = await service.registerAnimal({
        userId: uid(),
        category: 'vaca',
        rfid: '032 01 0000000001',
        breed: 'angus',
        fieldId, plotId: plotNorteId, groupId,
      });

      expect(animal.sex).toBe('H');            // derivado de la categoría
      expect(animal.breed_id).not.toBeNull();  // raza normalizada contra el catálogo
      expect(identifications).toHaveLength(1);

      // Las tres grafías del mismo número resuelven al mismo animal.
      for (const form of ['032010000000001', '032-01-0000000001', '032 01 0000000001']) {
        const found = await service.findByIdentifier(uid(), form);
        expect(found?.id, `falló la forma ${form}`).toBe(animal.id);
      }
    });

    it('encuentra el animal por el NII de 10 dígitos suelto (caravana cinta en machos)', async () => {
      const { animal } = await service.registerAnimal({
        userId: uid(), category: 'novillo', rfid: '032010000000002', fieldId, plotId: plotNorteId,
      });
      const found = await service.findByIdentifier(uid(), '0000000002');
      expect(found?.id).toBe(animal.id);
    });

    it('RECHAZA un RFID duplicado y NO deja el animal a medio crear', async () => {
      await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000003', fieldId });

      const before = await service.count(uid(), {});
      await expect(
        service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000003', fieldId }),
      ).rejects.toBeInstanceOf(DuplicateIdentifierError);

      // La transacción revirtió: no quedó un animal huérfano sin caravana.
      expect(await service.count(uid(), {})).toBe(before);
    });

    it('acepta un identificador con formato raro pero lo advierte — registra, no bloquea', async () => {
      const { animal, warnings } = await service.registerAnimal({
        userId: uid(), category: 'toro', rfid: 'A-77', fieldId,
      });
      expect(animal.id).toBeTruthy();
      expect(warnings.join(' ')).toMatch(/no numérico|caravana visual/i);
      expect(await service.findByIdentifier(uid(), 'A77')).not.toBeNull();
    });
  });

  describe('re-identificación (Res. 841/2025 Art. 11)', () => {
    it('conserva el historial y encadena la nueva con la anterior', async () => {
      const { animal } = await service.registerAnimal({
        userId: uid(), category: 'vaca', rfid: '032010000000010', fieldId,
      });

      const { retired, created } = await service.replaceIdentification({
        userId: uid(), animalId: animal.id, newValue: '032010000000011', reason: 'perdida',
      });

      expect(retired?.value_normalized).toBe('032010000000010');
      expect(created.replaces_identification_id).toBe(retired!.id);

      const history = await service.getIdentificationHistory(uid(), animal.id);
      expect(history).toHaveLength(2);
      expect(history.filter((i) => i.is_current)).toHaveLength(1);

      // La vieja ya no resuelve; la nueva sí. El historial queda, el lookup no.
      expect(await service.findByIdentifier(uid(), '032010000000010')).toBeNull();
      expect((await service.findByIdentifier(uid(), '032010000000011'))?.id).toBe(animal.id);

      const timeline = await service.getTimeline(uid(), animal.id);
      expect(timeline.some((e) => e.event_type === 'reidentificacion')).toBe(true);
    });

    it('libera el número viejo: se puede reasignar a OTRO animal', async () => {
      const otro = await service.registerAnimal({ userId: uid(), category: 'ternero', fieldId });
      // '032010000000010' quedó retirado en el test anterior.
      const { created } = await service.replaceIdentification({
        userId: uid(), animalId: otro.animal.id, newValue: '032010000000010',
      });
      expect(created.is_current).toBe(true);
      expect((await service.findByIdentifier(uid(), '032010000000010'))?.id).toBe(otro.animal.id);
    });

    it('RECHAZA reasignar un número que está VIGENTE en otro animal', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000020', fieldId });
      const b = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000021', fieldId });
      await expect(
        service.replaceIdentification({ userId: uid(), animalId: b.animal.id, newValue: '032010000000020' }),
      ).rejects.toBeInstanceOf(DuplicateIdentifierError);
      expect((await service.findByIdentifier(uid(), '032010000000020'))?.id).toBe(a.animal.id);
    });
  });

  describe('movimientos individuales', () => {
    it('mueve animales y deja la traza con origen y destino', async () => {
      const a = await service.registerAnimal({
        userId: uid(), category: 'vaca', rfid: '032010000000030', fieldId, plotId: plotNorteId, groupId,
      });

      const { moved, skipped } = await service.moveAnimals({
        userId: uid(), animalIds: [a.animal.id],
        destFieldId: fieldId, destPlotId: plotSurId, destLabel: 'Sur',
      });

      expect(moved).toBe(1);
      expect(skipped).toEqual([]);
      expect((await service.getById(uid(), a.animal.id))?.plot_id).toBe(plotSurId);

      const mov = (await service.getTimeline(uid(), a.animal.id)).find((e) => e.event_type === 'movimiento');
      expect(mov?.from_ref).toBe('Norte');
      expect(mov?.to_ref).toBe('Sur');
    });

    it('NO mueve un animal muerto, pero SÍ mueve al resto del lote', async () => {
      const vivo = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000040', fieldId, plotId: plotNorteId });
      const muerto = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000041', fieldId, plotId: plotNorteId });

      await service.setStatus({ userId: uid(), animalIds: [muerto.animal.id], status: 'muerto' });

      const { moved, skipped } = await service.moveAnimals({
        userId: uid(), animalIds: [vivo.animal.id, muerto.animal.id],
        destFieldId: fieldId, destPlotId: plotSurId, destLabel: 'Sur',
      });

      // Que 1 de 2 esté muerto no puede impedir mover el otro.
      expect(moved).toBe(1);
      expect(skipped).toEqual([{ animalId: muerto.animal.id, reason: 'está muerto' }]);
      expect((await service.getById(uid(), muerto.animal.id))?.plot_id).toBe(plotNorteId);
    });

    it('un animal vendido tampoco se mueve', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'novillo', rfid: '032010000000050', fieldId, plotId: plotNorteId });
      await service.setStatus({ userId: uid(), animalIds: [a.animal.id], status: 'vendido' });

      const { moved, skipped } = await service.moveAnimals({
        userId: uid(), animalIds: [a.animal.id], destPlotId: plotSurId, destLabel: 'Sur',
      });
      expect(moved).toBe(0);
      expect(skipped[0].reason).toBe('está vendido');
    });

    it('la recategorización deja su propio evento, distinto del movimiento', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'ternero', rfid: '032010000000060', fieldId, plotId: plotNorteId });

      await service.moveAnimals({
        userId: uid(), animalIds: [a.animal.id],
        destFieldId: fieldId, destPlotId: plotNorteId, destLabel: 'Norte', destCategory: 'novillito',
      });

      const timeline = await service.getTimeline(uid(), a.animal.id);
      const cambio = timeline.find((e) => e.event_type === 'cambio_categoria');
      expect(cambio?.from_ref).toBe('Ternero');
      expect(cambio?.to_ref).toBe('Novillito');
      expect((await service.getById(uid(), a.animal.id))?.category).toBe('novillito');
    });
  });

  describe('modelo híbrido — consistencia grupo ↔ individuales', () => {
    it('individualized_count sigue a las altas, bajas y movimientos', async () => {
      const g = await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
         VALUES ($1, $2, $3, 'vaquillona', 'Hereford', 10) RETURNING id`,
        [h.userId, fieldId, plotSurId],
      );
      const gid = g[0].id as string;

      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(await service.registerAnimal({
          userId: uid(), category: 'vaquillona', rfid: `03201000000010${i}`, fieldId, plotId: plotSurId, groupId: gid,
        }));
      }
      const readCount = async () =>
        Number((await h.q(`SELECT individualized_count FROM livestock_groups WHERE id = $1`, [gid]))[0].individualized_count);

      expect(await readCount()).toBe(3);

      // Una baja descuenta…
      await service.setStatus({ userId: uid(), animalIds: [created[0].animal.id], status: 'muerto' });
      expect(await readCount()).toBe(2);

      // …y sacar uno del grupo también.
      await service.moveAnimals({
        userId: uid(), animalIds: [created[1].animal.id],
        destFieldId: fieldId, destPlotId: plotNorteId, destGroupId: null, destLabel: 'Norte',
      });
      expect(await readCount()).toBe(1);

      // El count AGREGADO nunca fue tocado por esta capa.
      const agg = await h.q(`SELECT count FROM livestock_groups WHERE id = $1`, [gid]);
      expect(Number(agg[0].count)).toBe(10);
    });

    it('reporta el EXCESO de individuales sobre el count declarado', async () => {
      const g = await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
         VALUES ($1, $2, $3, 'torito', 'Angus', 1) RETURNING id`,
        [h.userId, fieldId, plotSurId],
      );
      const gid = g[0].id as string;

      for (let i = 0; i < 3; i++) {
        await service.registerAnimal({
          userId: uid(), category: 'torito', rfid: `03201000000020${i}`, fieldId, plotId: plotSurId, groupId: gid,
        });
      }

      const issues = await service.findInconsistencies(uid());
      const excess = issues.find((i) => i.kind === 'grupo_vs_individuales' && i.message.includes('torito'));
      expect(excess?.message).toMatch(/declara 1 animales, pero hay 3/);
    });

    it('la individualización PARCIAL no se reporta como inconsistencia', async () => {
      // `groupId` declara 100 cabezas y tiene apenas un puñado individualizado.
      // Eso es exactamente el modelo híbrido funcionando, no un error.
      const issues = await service.findInconsistencies(uid());
      expect(issues.some((i) => i.message.includes('declara 100'))).toBe(false);
    });

    it('la reconciliación detecta y corrige un contador desviado a mano', async () => {
      await h.q(`UPDATE livestock_groups SET individualized_count = 999 WHERE id = $1`, [groupId]);
      const fixed = await service.reconcile(uid());
      expect(fixed).toBeGreaterThan(0);

      const real = await h.q(
        `SELECT (SELECT COUNT(*) FROM animals a WHERE a.group_id = lg.id AND a.deleted_at IS NULL AND a.status='activo') AS n,
                individualized_count FROM livestock_groups lg WHERE lg.id = $1`,
        [groupId],
      );
      expect(Number(real[0].individualized_count)).toBe(Number(real[0].n));
    });
  });

  describe('resolución masiva de lecturas', () => {
    it('clasifica en encontrados / desconocidos / repetidos / ilegibles y las 4 suman el total', async () => {
      const a1 = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000300', fieldId, plotId: plotNorteId });
      await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000301', fieldId, plotId: plotSurId });

      const lectura = [
        '032010000000300',
        '032010000000301',
        '032010000000300',   // repetido en la misma lectura
        '032010000000999',   // no está en el rodeo
        'x',                 // ilegible
      ];
      const res = await service.resolveBatch(uid(), lectura);

      expect(res.rawCount).toBe(5);
      expect(res.matched).toHaveLength(2);
      expect(res.duplicates).toEqual(['032010000000300']);
      expect(res.unknown).toEqual(['032010000000999']);
      expect(res.invalid).toHaveLength(1);
      // Las cuatro categorías son disjuntas y cierran contra el total leído.
      expect(res.matched.length + res.unknown.length + res.duplicates.length + res.invalid.length).toBe(res.rawCount);
      expect(res.matched.some((m) => m.animal.id === a1.animal.id)).toBe(true);
    });

    it('el resumen desglosa por ubicación', async () => {
      const res = await service.resolveBatch(uid(), ['032010000000300', '032010000000301']);
      const text = service.summarizeResolution(res);
      expect(text).toMatch(/encontré 2 animales/i);
      expect(text).toMatch(/Lote Norte/);
      expect(text).toMatch(/Lote Sur/);
    });

    it('resuelve 200 lecturas sin degradarse (una sola query, no N)', async () => {
      const values = Array.from({ length: 200 }, (_, i) => `0320100000${String(i).padStart(5, '0')}`);
      const t0 = Date.now();
      const res = await service.resolveBatch(uid(), values);
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(res.rawCount).toBe(200);
    });
  });

  describe('ganancia diaria de peso', () => {
    it('calcula GDP por tramo sin asumir periodicidad uniforme', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'novillo', rfid: '032010000000400', fieldId });

      // Tramos deliberadamente desparejos: 30 y 31 días.
      await repo.insertEvents([
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-06-01', numericValue: 410, unit: 'kg' },
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-07-01', numericValue: 438, unit: 'kg' },
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-08-01', numericValue: 465, unit: 'kg' },
      ]);

      const { weighings, segments, overallGdpKgDay } = await service.getWeightGain(uid(), a.animal.id);

      expect(weighings.map((w) => w.weightKg)).toEqual([410, 438, 465]);   // orden ascendente
      expect(segments).toHaveLength(2);
      expect(segments[0].days).toBe(30);
      expect(segments[0].gainKg).toBe(28);
      expect(segments[0].gdpKgDay).toBeCloseTo(28 / 30, 5);
      expect(segments[1].days).toBe(31);
      expect(overallGdpKgDay).toBeCloseTo(55 / 61, 5);
    });

    it('con un solo pesaje no inventa una ganancia', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'novillo', rfid: '032010000000401', fieldId });
      await repo.insertEvents([
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-06-01', numericValue: 400, unit: 'kg' },
      ]);
      const { segments, overallGdpKgDay } = await service.getWeightGain(uid(), a.animal.id);
      expect(segments).toEqual([]);
      expect(overallGdpKgDay).toBeNull();
    });

    it('dos pesajes el MISMO día no producen una división por cero', async () => {
      const a = await service.registerAnimal({ userId: uid(), category: 'novillo', rfid: '032010000000402', fieldId });
      await repo.insertEvents([
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-06-01', numericValue: 400, unit: 'kg' },
        { userId: uid(), animalId: a.animal.id, eventType: 'pesaje', eventDate: '2026-06-01', numericValue: 402, unit: 'kg' },
      ]);
      const { segments, overallGdpKgDay } = await service.getWeightGain(uid(), a.animal.id);
      expect(segments).toEqual([]);
      expect(overallGdpKgDay).toBeNull();
      expect(Number.isNaN(overallGdpKgDay as unknown as number)).toBe(false);
    });
  });

  describe('aislamiento entre usuarios', () => {
    it('no resuelve una caravana de OTRO usuario', async () => {
      const other = await createPipelineHarness('animal-service-other');
      try {
        const otherService = new AnimalService();
        const of = await other.q(`INSERT INTO fields (user_id, name) VALUES ($1, 'Ajeno') RETURNING id`, [other.userId]);
        await otherService.registerAnimal({
          userId: Number(other.userId), category: 'vaca', rfid: '032010000000500', fieldId: of[0].id as number,
        });

        // Existe, pero no para este usuario.
        expect(await otherService.findByIdentifier(Number(other.userId), '032010000000500')).not.toBeNull();
        expect(await service.findByIdentifier(uid(), '032010000000500')).toBeNull();

        // Y el mismo número puede convivir en ambos padrones: un animal cambia
        // de dueño legítimamente. La unicidad es POR usuario, no global.
        const mine = await service.registerAnimal({ userId: uid(), category: 'vaca', rfid: '032010000000500', fieldId });
        expect(mine.animal.id).toBeTruthy();
      } finally {
        await other.cleanup();
      }
    });
  });

  describe('compatibilidad hacia atrás', () => {
    it('un grupo SIN animales individualizados queda intacto: count, individualized_count 0, cero eventos', async () => {
      const g = await h.q(
        `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
         VALUES ($1, $2, $3, 'buey', 'Criollo', 42) RETURNING id`,
        [h.userId, fieldId, plotNorteId],
      );
      const gid = g[0].id as string;

      const row = (await h.q(`SELECT count, individualized_count FROM livestock_groups WHERE id = $1`, [gid]))[0];
      expect(Number(row.count)).toBe(42);
      expect(Number(row.individualized_count)).toBe(0);

      expect(await service.count(uid(), { groupId: gid })).toBe(0);
      // Y no aparece en ninguna inconsistencia: 42 declaradas y 0 individualizadas
      // es el estado normal de quien no individualiza.
      const issues = await service.findInconsistencies(uid());
      expect(issues.some((i) => i.message.includes('buey'))).toBe(false);
    });
  });
});
