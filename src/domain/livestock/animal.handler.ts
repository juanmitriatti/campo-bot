/**
 * animal.handler.ts — comandos conversacionales de la capa individual.
 *
 * Vive aparte de `livestock.handler.ts` (que ya tiene 2200+ líneas) pero se
 * despacha desde el MISMO `LIVESTOCK_COMMANDS`: para el router y el gate de
 * features esto es hacienda, no un dominio nuevo.
 *
 * REGLA QUE PROTEGE AL MODELO POR GRUPOS:
 * estos comandos son SOLO para operaciones donde el usuario nombró animales
 * concretos (una caravana, una lista de lecturas). "Mové 50 vacas del Norte al
 * Sur" NO entra acá — sigue siendo `transfer_livestock` sobre el grupo. Si el
 * agente empieza a rutear operaciones grupales por acá, se pierde la
 * simplicidad que es la ventaja del producto.
 */

import { AnimalService, DuplicateIdentifierError } from './animal.service.js';
import { AnimalRepository } from './animal.repository.js';
import { LivestockService } from './livestock.service.js';
import { LivestockRepository } from './livestock.repository.js';
import { AnimalBatchService } from './animal-batch.service.js';
import { callbackPayloadStore } from '../../middleware/callback-payload-store.js';
import { LIVESTOCK_CATEGORY_LABEL, type LivestockCategory } from './livestock.types.js';
import { ANIMAL_EVENT_LABEL, ANIMAL_STATUS_LABEL, type AnimalRow, type AnimalStatus } from './animal.types.js';
import { parseAnimalId, extractIdList, formatCii } from '../../utils/animal-id.js';
import { formatDateAR } from '../../utils/date.js';
import type { ParsedCommand, HandlerResponse, UserId } from '../../types/index.js';

/** Etiqueta corta de un animal para listados: caravana si tiene, categoría si no. */
function animalLabel(a: AnimalRow): string {
  const tag = a.current_rfid ?? a.current_visual_tag;
  const cat = LIVESTOCK_CATEGORY_LABEL[a.category] ?? a.category;
  return tag ? `${cat} ${formatCii(tag)}` : `${cat} sin caravana`;
}

function locationLabel(a: AnimalRow): string {
  if (a.plot_name) return `Lote ${a.plot_name}`;
  if (a.corral_name) return `Corral ${a.corral_name}`;
  if (a.field_name) return a.field_name;
  return 'sin ubicación';
}

export class AnimalHandler {
  private service: AnimalService;
  private repo: AnimalRepository;
  private livestock: LivestockService;
  private livestockRepo: LivestockRepository;
  private batches: AnimalBatchService;

  constructor(
    service?: AnimalService,
    repo?: AnimalRepository,
    livestock?: LivestockService,
    livestockRepo?: LivestockRepository,
    batches?: AnimalBatchService,
  ) {
    this.repo = repo ?? new AnimalRepository();
    this.service = service ?? new AnimalService(this.repo);
    this.livestock = livestock ?? new LivestockService();
    this.livestockRepo = livestockRepo ?? new LivestockRepository();
    this.batches = batches ?? new AnimalBatchService(this.service);
  }

  async handleCommand(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    try {
      switch (cmd.command) {
        case 'register_animal': return await this.registerAnimal(cmd, userId);
        case 'identify_animal': return await this.identifyAnimal(cmd, userId);
        case 'query_animal': return await this.queryAnimal(cmd, userId);
        case 'list_animals': return await this.listAnimals(cmd, userId);
        case 'move_animals': return await this.moveAnimals(cmd, userId);
        case 'revert_livestock_movement': return await this.revertMovement(cmd, userId);
        case 'animal_batch_preview': return await this.batchPreview(cmd, userId);
        case 'animal_batch_move': return await this.batchMove(cmd, userId);
        case 'animal_batch_cancel': return await this.batchCancel(cmd, userId);
        default:
          return { messages: ['Comando de animal individual no reconocido.'] };
      }
    } catch (err: unknown) {
      if (err instanceof DuplicateIdentifierError) {
        return { messages: [`❌ La caravana ${formatCii(err.value)} ya está asignada a otro animal tuyo. Si le pusiste una nueva, decime «reemplazá la caravana X por la Y».`] };
      }
      const msg = err instanceof Error ? err.message : 'Error en operación de animal';
      return { messages: [`❌ ${msg}`] };
    }
  }

  // ========================
  // ALTA
  // ========================

  private async registerAnimal(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = LivestockService.normalizeCategory(cmd.category as string);
    if (!category) {
      // Pending machine-readable, nunca pregunta suelta (invariante 5).
      const ask = '🐄 ¿Qué categoría es? (vaca, novillo, ternero, toro…)';
      return {
        messages: [ask],
        sideEffects: {
          setPendingActivity: {
            command: 'register_animal', data: { ...cmd }, missing: ['category'], askPrompt: ask,
          },
        },
      };
    }

    const rfid = (cmd.rfid as string) ?? null;
    const visualTag = (cmd.visualTag as string) ?? null;
    if (!rfid && !visualTag) {
      const ask = '🏷️ ¿Cuál es la caravana? Pasame el número electrónico (15 dígitos) o el visual.';
      return {
        messages: [ask],
        sideEffects: {
          setPendingActivity: {
            command: 'register_animal', data: { ...cmd, category }, missing: ['rfid'], askPrompt: ask,
          },
        },
      };
    }

    const loc = await this.resolveLocation(cmd, userId);

    const { animal, warnings } = await this.service.registerAnimal({
      userId: Number(userId),
      category,
      sex: (cmd.sex as 'M' | 'H') ?? null,
      rfid,
      visualTag,
      breed: cmd.breed as string,
      birthDate: cmd.birthDate as string,
      fieldId: loc.fieldId,
      plotId: loc.plotId,
      corralId: loc.corralId,
      groupId: loc.groupId,
      origin: (cmd.origin as string) ?? 'alta_manual',
      entryDate: cmd.eventDate as string,
      source: 'whatsapp',
    });

    const body =
      `🏷️ *Animal registrado*\n\n` +
      `  ${animalLabel(animal)}\n` +
      (animal.breed_name ? `  🧬 ${animal.breed_name}\n` : '') +
      (animal.birth_date ? `  🎂 ${formatDateAR(animal.birth_date)}\n` : '') +
      `  📍 ${locationLabel(animal)}` +
      (warnings.length > 0 ? `\n\n⚠️ ${warnings.join(' ')}` : '');

    return { messages: [body] };
  }

  // ========================
  // IDENTIFICACIÓN / RE-IDENTIFICACIÓN
  // ========================

  private async identifyAnimal(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const ref = (cmd.animalRef as string) ?? null;
    const newValue = (cmd.newRfid as string) ?? (cmd.newVisualTag as string) ?? null;

    if (!ref) return { messages: ['Decime de qué animal. Ej: «reemplazá la caravana 0001234567 por la 0007654321».'] };
    if (!newValue) {
      const ask = '🏷️ ¿Cuál es la caravana nueva?';
      return {
        messages: [ask],
        sideEffects: {
          setPendingActivity: {
            command: 'identify_animal', data: { ...cmd }, missing: ['newRfid'], askPrompt: ask,
          },
        },
      };
    }

    const animal = await this.service.findByIdentifier(Number(userId), ref);
    if (!animal) return { messages: [`❌ No encontré ningún animal con la caravana ${formatCii(ref)}.`] };

    const { retired, created, warnings } = await this.service.replaceIdentification({
      userId: Number(userId),
      animalId: animal.id,
      newValue,
      reason: (cmd.reason as string) ?? 'reemplazo',
      source: 'whatsapp',
    });

    const body =
      `🔁 *Caravana reemplazada*\n\n` +
      `  ${LIVESTOCK_CATEGORY_LABEL[animal.category]}\n` +
      (retired ? `  Anterior: ${formatCii(retired.value)}\n` : '') +
      `  Nueva: *${formatCii(created.value)}*\n` +
      `  📍 ${locationLabel(animal)}\n\n` +
      `_La anterior queda en el historial del animal._` +
      (warnings.length > 0 ? `\n\n⚠️ ${warnings.join(' ')}` : '');

    return { messages: [body] };
  }

  // ========================
  // CONSULTA DE UN ANIMAL
  // ========================

  private async queryAnimal(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const ref = (cmd.animalRef as string) ?? null;
    if (!ref) return { messages: ['Decime qué caravana querés consultar. Ej: «qué pasó con la 0001234567».'] };

    const animal = await this.service.findByIdentifier(Number(userId), ref);
    if (!animal) {
      const parsed = parseAnimalId(ref);
      return {
        messages: [
          `❌ No tengo ningún animal con la caravana ${formatCii(ref)}.` +
          (parsed.warning ? `\n\n_${parsed.warning}_` : '') +
          `\n\nSi lo querés dar de alta: «dar de alta una vaca con caravana ${parsed.normalized}».`,
        ],
      };
    }

    const view = (cmd.view as string) ?? 'ficha';
    if (view === 'pesos') return this.renderWeights(animal, userId);

    const timeline = await this.service.getTimeline(Number(userId), animal.id, { limit: 15 });
    const status = ANIMAL_STATUS_LABEL[animal.status];

    const header =
      `${status.emoji} *${animalLabel(animal)}*\n\n` +
      `  Estado: ${status.label}\n` +
      (animal.sex ? `  Sexo: ${animal.sex === 'H' ? 'Hembra' : 'Macho'}\n` : '') +
      (animal.breed_name ? `  🧬 ${animal.breed_name}\n` : '') +
      (animal.birth_date ? `  🎂 ${formatDateAR(animal.birth_date)}\n` : '') +
      `  📍 ${locationLabel(animal)}`;

    if (timeline.length === 0) {
      return { messages: [`${header}\n\n_Todavía no tiene eventos registrados._`] };
    }

    const lines = timeline.map((e) => {
      const label = ANIMAL_EVENT_LABEL[e.event_type] ?? { emoji: '•', label: e.event_type };
      const detail = this.eventDetail(e.numeric_value, e.unit, e.text_value, e.from_ref, e.to_ref);
      return `  ${formatDateAR(e.event_date)} ${label.emoji} ${label.label}${detail}`;
    });

    return { messages: [`${header}\n\n📜 *Historial*\n${lines.join('\n')}`] };
  }

  private eventDetail(
    numeric: string | number | null, unit: string | null,
    text: string | null, from: string | null, to: string | null,
  ): string {
    if (numeric != null) return ` — ${Number(numeric)}${unit ? ` ${unit}` : ''}`;
    if (from && to) return ` — ${from} → ${to}`;
    if (to) return ` — ${to}`;
    if (text) return ` — ${text}`;
    return '';
  }

  private async renderWeights(animal: AnimalRow, userId: UserId): Promise<HandlerResponse> {
    const { weighings, segments, overallGdpKgDay } = await this.service.getWeightGain(Number(userId), animal.id);
    if (weighings.length === 0) {
      return { messages: [`⚖️ ${animalLabel(animal)} todavía no tiene pesajes registrados.`] };
    }

    const rows = weighings.map((w) => `  ${formatDateAR(w.date)} — *${w.weightKg} kg*`);
    const gdpLine = overallGdpKgDay != null
      ? `\n\n📈 GDP promedio: *${overallGdpKgDay.toFixed(3)} kg/día*`
      // Con un solo pesaje no se inventa una ganancia.
      : '\n\n_Con un solo pesaje todavía no puedo calcular la ganancia diaria._';
    const lastSegment = segments.length > 0
      ? `\n   Último tramo: ${segments[segments.length - 1].gainKg.toFixed(1)} kg en ${segments[segments.length - 1].days} días`
      : '';

    return { messages: [`⚖️ *${animalLabel(animal)}*\n\n${rows.join('\n')}${gdpLine}${lastSegment}`] };
  }

  // ========================
  // LISTADO
  // ========================

  private async listAnimals(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = LivestockService.normalizeCategory(cmd.category as string) ?? undefined;
    const loc = await this.resolveLocation(cmd, userId, { optional: true });

    const filters = {
      status: ((cmd.status as AnimalStatus) ?? 'activo') as AnimalStatus,
      category: category as LivestockCategory | undefined,
      sex: cmd.sex as 'M' | 'H' | undefined,
      fieldId: loc.fieldId ?? undefined,
      plotId: loc.plotId ?? undefined,
      corralId: loc.corralId ?? undefined,
      identified: cmd.identified as boolean | undefined,
      limit: Math.min(Number(cmd.topN) || 25, 50),
    };

    const [animals, total] = await Promise.all([
      this.service.list(Number(userId), filters),
      this.service.count(Number(userId), { ...filters, limit: undefined }),
    ]);

    if (total === 0) {
      return {
        messages: [
          '🐄 No tengo animales individualizados que cumplan eso.\n\n' +
          '_El inventario por grupos sigue disponible: preguntame «cuántas vacas tengo»._',
        ],
      };
    }

    const lines = animals.map((a) => `  • ${animalLabel(a)} — ${locationLabel(a)}`);
    const more = total > animals.length ? `\n\n_Muestro ${animals.length} de ${total}._` : '';

    return { messages: [`🐄 *${total} animal${total === 1 ? '' : 'es'}*\n\n${lines.join('\n')}${more}`] };
  }

  // ========================
  // MOVIMIENTO POR CARAVANA
  // ========================

  private async moveAnimals(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Las referencias pueden venir como array (del agente) o como texto pegado.
    const raw = cmd.animalRefs;
    const refs: string[] = Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === 'string'
        ? extractIdList(raw).values
        : [];

    if (refs.length === 0) {
      return { messages: ['Decime qué animales mover. Pasame las caravanas o pegá la lista del lector.'] };
    }

    const resolution = await this.service.resolveBatch(Number(userId), refs);
    if (resolution.matched.length === 0) {
      return {
        messages: [
          `${this.service.summarizeResolution(resolution)}\n\n` +
          '❌ Ninguna de esas caravanas está en tu rodeo, así que no moví nada.',
        ],
      };
    }

    const loc = await this.resolveLocation(cmd, userId, { dest: true });
    if (!loc.plotId && !loc.corralId) {
      const ask = '📍 ¿A qué lote o corral los muevo?';
      return {
        messages: [`${this.service.summarizeResolution(resolution)}\n\n${ask}`],
        sideEffects: {
          setPendingActivity: {
            command: 'move_animals',
            data: { ...cmd, animalRefs: resolution.matched.map((m) => m.value) },
            missing: ['plot'],
            askPrompt: ask,
          },
        },
      };
    }

    const { moved, skipped } = await this.service.moveAnimals({
      userId: Number(userId),
      animalIds: resolution.matched.map((m) => m.animal.id),
      destFieldId: loc.fieldId,
      destPlotId: loc.plotId,
      destCorralId: loc.corralId,
      destLabel: loc.label ?? undefined,
      eventDate: cmd.eventDate as string,
      source: 'whatsapp',
    });

    const skippedLine = skipped.length > 0
      ? `\n\n⚠️ ${skipped.length} no se movieron (${[...new Set(skipped.map((s) => s.reason))].join(', ')}).`
      : '';
    const unknownLine = resolution.unknown.length > 0
      ? `\n_${resolution.unknown.length} caravana(s) no están en tu rodeo._`
      : '';

    return {
      messages: [
        `🔄 *${moved} animal${moved === 1 ? '' : 'es'} movido${moved === 1 ? '' : 's'}*\n\n` +
        `  📍 Hacia ${loc.label ?? 'destino'}` +
        skippedLine + unknownLine,
      ],
    };
  }

  // ========================
  // LOTE DE LECTURAS (lista pegada / CSV / lector)
  // ========================

  /**
   * Preview de una lectura masiva. Llega desde el interceptor determinístico
   * del pipeline, NUNCA desde el agente: 87 números en un prompt queman tokens
   * y el modelo los mangla.
   *
   * Responde con el desglose y BOTONES (invariante 5: nunca una pregunta
   * suelta). No mueve nada — eso lo decide el usuario en el paso siguiente.
   */
  private async batchPreview(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const rawText = (cmd.rawText as string) ?? '';
    const { batch, resolution } = await this.batches.createFromText(Number(userId), rawText, {
      source: 'whatsapp',
      intendedAction: 'movimiento',
    });

    const summary = this.service.summarizeResolution(resolution);

    if (resolution.matched.length === 0) {
      return {
        messages: [
          `${summary}\n\n` +
          'Ninguna de esas caravanas está registrada en tu rodeo todavía. ' +
          'Si querés darlas de alta, decime la categoría — por ejemplo «son vaquillonas del lote Norte».',
        ],
      };
    }

    // El token va en el payload del botón: `callback_data` de Telegram tiene
    // 64 bytes y un UUID + prefijo no siempre entra cómodo.
    const token = callbackPayloadStore.set(batch.id);

    return {
      messages: [],
      interactive: {
        type: 'buttons' as const,
        body: `${summary}\n\n¿Qué querés hacer con estos ${resolution.matched.length}?`,
        buttons: [
          { id: `animal_batch_move_${token}`, title: '🔄 Moverlos' },
          { id: `animal_batch_cancel_${token}`, title: '✖️ Descartar' },
        ],
      },
    };
  }

  /**
   * Tap de "Moverlos". Si todavía no hay destino, pregunta con un pending que
   * recuerda el batch; con destino, aplica.
   */
  private async batchMove(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const batchId = (cmd.batchId as string) ?? null;
    const batch = batchId
      ? await this.batches.findById(Number(userId), batchId)
      : await this.batches.findLatestOpen(Number(userId));

    if (!batch) return { messages: ['Esa lectura ya no está disponible. Volvé a pegar la lista de caravanas.'] };
    if (batch.status === 'applied') {
      return { messages: ['✅ Esa lectura ya se aplicó — no la volví a mover.'] };
    }
    if (batch.status === 'discarded') {
      return { messages: ['Esa lectura la habías descartado. Volvé a pegar la lista si querés retomarla.'] };
    }

    const loc = await this.resolveLocation(cmd, userId, { dest: true });
    if (!loc.plotId && !loc.corralId) {
      const ask = `📍 ¿A qué lote o corral muevo los ${batch.matched_count}?`;
      return {
        messages: [ask],
        sideEffects: {
          setPendingActivity: {
            command: 'animal_batch_move',
            data: { batchId: batch.id },
            missing: ['plot'],
            askPrompt: ask,
          },
        },
      };
    }

    const { applied, moved, skipped, alreadyApplied } = await this.batches.applyAsMove(
      Number(userId), batch.id,
      { fieldId: loc.fieldId, plotId: loc.plotId, corralId: loc.corralId, label: loc.label ?? undefined },
    );

    if (!applied) {
      return {
        messages: [alreadyApplied
          ? '✅ Esa lectura ya se aplicó — no la volví a mover.'
          : 'Esa lectura ya no está disponible.'],
      };
    }

    const skippedLine = skipped.length > 0
      ? `\n\n⚠️ ${skipped.length} no se movieron (${[...new Set(skipped.map((s) => s.reason))].join(', ')}).`
      : '';

    return {
      messages: [
        `🔄 *${moved} animal${moved === 1 ? '' : 'es'} movido${moved === 1 ? '' : 's'}*\n\n` +
        `  📍 Hacia ${loc.label ?? 'destino'}${skippedLine}`,
      ],
    };
  }

  private async batchCancel(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const batchId = (cmd.batchId as string) ?? null;
    if (batchId) await this.batches.discard(Number(userId), batchId);
    return { messages: ['Listo, descarté esa lectura. No registré ningún movimiento.'] };
  }

  // ========================
  // REVERSIÓN
  // ========================

  private async revertMovement(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    let movementId: string | null = (cmd.movementId as string) ?? null;

    // Sin id explícito se toma el último movimiento REVERTIBLE. El usuario dice
    // "eso estuvo mal, volvelo atrás" — no conoce los UUIDs, y pedirle que elija
    // entre reversas y ajustes no reversibles sería ruido.
    if (!movementId) {
      const latest = await this.livestockRepo.findLatestRevertibleMovement(Number(userId));
      movementId = latest?.id ?? null;
    }
    if (!movementId) return { messages: ['No encontré ningún movimiento reciente para revertir.'] };

    const { label } = await this.livestock.undoMovement(userId, movementId);
    return {
      messages: [
        `↩️ *Movimiento revertido*\n\n  ${label}\n\n` +
        `_El movimiento original queda en el historial; la reversión se registró aparte y lo referencia._`,
      ],
    };
  }

  // ========================
  // INTERNOS
  // ========================

  /**
   * Resuelve la ubicación mencionada en el comando a ids. Delega en el servicio
   * de hacienda para que lotes y corrales se resuelvan EXACTAMENTE igual que en
   * el camino por grupos — una segunda resolución divergiría (invariante 3).
   */
  private async resolveLocation(
    cmd: ParsedCommand, userId: UserId,
    opts: { optional?: boolean; dest?: boolean } = {},
  ): Promise<{ fieldId: number | null; plotId: number | null; corralId: number | null; groupId: string | null; label: string | null }> {
    const empty = { fieldId: null, plotId: null, corralId: null, groupId: null, label: null };

    // El destino puede llegar por DOS caminos y hay que aceptar los dos:
    //  · desde el agente, en `dest_plot`/`dest_corral` (mapeados a destPlot/destCorral);
    //  · desde un pending, donde el slot-extractor llena las claves genéricas
    //    `plot`/`plotName` (ver slotToCmdKeys en pending-action-processor).
    // Leer solo las `dest*` hacía que la respuesta "Sur" al «¿a qué lote?» se
    // ignorara y el handler re-preguntara el mismo slot en loop.
    const pick = (...vals: unknown[]) => vals.find((v) => typeof v === 'string' && v.trim()) as string | undefined;

    const fieldName = opts.dest
      ? pick(cmd.destField, cmd.fieldName, cmd.field)
      : pick(cmd.fieldName, cmd.field);
    const plotName = opts.dest
      ? pick(cmd.destPlot, cmd.plotName, cmd.plot)
      : pick(cmd.plotName, cmd.plot);
    const corralName = opts.dest
      ? pick(cmd.destCorral, cmd.corralName, cmd.corral)
      : pick(cmd.corralName, cmd.corral);

    if (!fieldName && !plotName && !corralName) return empty;

    try {
      const loc = await this.livestock.resolveLocation(userId, fieldName, plotName, corralName);
      if (loc.type === 'corral') {
        return {
          fieldId: loc.fieldId, plotId: null, corralId: loc.corralId, groupId: null,
          label: `Corral ${loc.corralName}`,
        };
      }
      return {
        fieldId: loc.fieldId, plotId: loc.plotId, corralId: null, groupId: null,
        label: `Lote ${loc.plotName}`,
      };
    } catch (err) {
      // En un listado la ubicación es un filtro opcional: que no resuelva no
      // puede hacer fallar la consulta entera.
      if (opts.optional) return empty;
      throw err;
    }
  }
}
