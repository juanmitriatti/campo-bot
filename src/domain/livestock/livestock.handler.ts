import { LivestockService } from './livestock.service.js';
import {
  LIVESTOCK_CATEGORY_LABEL,
  LIVESTOCK_MOVEMENT_LABEL,
  HEALTH_TYPE_LABEL,
  REPRO_TYPE_LABEL,
} from './livestock.types.js';
import type { LivestockCategory, LivestockGroupRow } from './livestock.types.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { FeedlotService } from '../feedlot/feedlot.service.js';
import { saveDomainEvent, queryLivestockEvents, updateLivestockGroupWeight, updateConversationState } from '../../services/expenses.js';
import { formatDateAR } from '../../utils/date.js';
import { formatPlotLocation } from '../../utils/format-location.js';
import { userExplicitlyReferencedPlot } from '../../utils/plot-intent.js';
import { pool } from '../../config/db.js';
import { encodeLivestockPayload, decodeLivestockPayload } from './livestock-payload.js';
import { buildPostActionButtons } from './livestock-post-actions.js';
import { livestockLocationIntent } from '../../utils/livestock-location-intent.js';
import { callbackPayloadStore } from '../../middleware/callback-payload-store.js';
import type {
  UserId,
  User,
  UserSettings,
  ParsedCommand,
  HandlerResponse,
  Currency,
} from '../../types/index.js';

/** Format a group's location for display */
function fmtLoc(group: LivestockGroupRow): string {
  return LivestockService.formatLocation(group);
}

/** Format a monetary amount for WhatsApp/Telegram messages */
function fmtAmount(amount: number, currency: Currency): string {
  const nf = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 });
  return currency === 'USD' ? `USD ${nf.format(amount)}` : `$${nf.format(amount)}`;
}
/** Etiqueta legible por tipo de movimiento. Se usa para el filtro y el render. */
const MOVEMENT_FILTER_LABEL: Record<string, string> = {
  entrada: 'entradas',
  salida: 'ventas/salidas',
  muerte: 'muertes',
  nacimiento: 'nacimientos',
  transferencia: 'transferencias',
  recategorizacion: 'recategorizaciones',
  ajuste: 'ajustes',
};

export class LivestockHandler {
  private service: LivestockService;
  private plotDiscovery = new PlotDiscoveryService();
  private feedlotService = new FeedlotService();

  constructor(service?: LivestockService) {
    this.service = service ?? new LivestockService();
  }

  /**
   * Re-ejecución del pending "¿a cuánto fue la compra/venta?" — adjunta el
   * precio al movimiento y crea el gasto/ingreso vinculado. El precio llega
   * vía slot-extractor como unit_price (o amount, que el processor cross-fillea).
   */
  private async setLivestockPrice(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const c = cmd as unknown as Record<string, unknown>;
    let movementId = String(c.movementId ?? '');
    const rawNum = (v: unknown): number | null => {
      const n = typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : NaN);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const unitPrice = rawNum(c.unit_price) ?? rawNum(c.unit_price_ars) ?? rawNum(c.unit_price_usd) ?? rawNum(c.amount);
    const currency: Currency = (c.currency === 'USD' || rawNum(c.unit_price_usd)) ? 'USD' : 'ARS';
    let kind: 'expense' | 'income' | null =
      c.kind === 'income' ? 'income' : (c.kind === 'expense' ? 'expense' : null);

    if (!unitPrice) {
      return { messages: ['💰 Necesito el precio (ej: "350 mil por cabeza" o "1500 USD").'] };
    }

    // Sin movementId (el agente lo llamó por un precio tardío, sin pending):
    // auto-resolver al último movimiento de compra/venta sin precio. Visto
    // live: "los toros me salieron 2 millones por cabeza" después de que una
    // consulta intermedia matara el pending — terminaba en una tool alucinada
    // (edit_last_livestock) y silencio.
    if (!movementId) {
      const category = LivestockService.normalizeCategory(c.category as string | undefined);
      const movementType = kind === 'income' ? 'salida' : (kind === 'expense' ? 'entrada' : null);
      const found = await this.service.findLatestUnpricedMovement(Number(userId), category, movementType);
      if (!found) {
        return { messages: ['No encontré una compra o venta de hacienda reciente sin precio. Si es una operación nueva, decime por ej: "compré 5 toros a 2 millones por cabeza".'] };
      }
      movementId = found.id;
      if (!kind) kind = found.movement_type === 'salida' ? 'income' : 'expense';
      console.log(`[INTERCEPT] set_livestock_price auto-resolved movement=${movementId} (${found.movement_type}, ${found.category} x${found.count})`);
    }
    if (!kind) kind = 'expense';

    try {
      const r = await this.service.attachPriceToMovement(userId, movementId, unitPrice, currency, kind);
      if (!r.financial) {
        return { messages: ['No pude registrar el precio — probá de nuevo con "350 mil por cabeza".'] };
      }
      const label = kind === 'expense' ? '💸 Gasto registrado' : '💰 Ingreso registrado';
      const catLabel = LIVESTOCK_CATEGORY_LABEL[r.category] ?? r.category;
      return {
        messages: [
          `${label}: ${fmtAmount(r.financial.amount, r.financial.currency)} (Hacienda)\n` +
          `  ${r.count} ${catLabel}${r.count > 1 ? 's' : ''} a ${fmtAmount(unitPrice, currency)} c/u`,
        ],
      };
    } catch (err) {
      return { messages: [(err as Error).message] };
    }
  }

  /**
   * Alimenta el context_stack después de una operación de hacienda que quedó
   * en un lote concreto, para que el próximo "ahí mismo / ese lote" resuelva
   * bien. Los paths que pasan por plotDiscovery ya lo hacen — esto cubre los
   * que toman el lote del GRUPO (livestock_groups.plot_id) sin discovery.
   * Best-effort: nunca bloquea la operación por bookkeeping de memoria.
   */
  private async bumpConversationContext(
    userId: UserId,
    plotId: number | null | undefined,
    fieldId?: number | null,
  ): Promise<void> {
    try {
      if (!plotId) return;
      let fid = fieldId ?? null;
      if (fid == null) {
        const { rows } = await pool.query('SELECT field_id FROM plots WHERE id = $1 AND deleted_at IS NULL', [plotId]);
        fid = rows[0]?.field_id ?? null;
      }
      if (fid != null) await updateConversationState(userId, fid, plotId);
    } catch {
      // nunca romper una operación de hacienda por la memoria conversacional
    }
  }

  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    _user: User,
    _settings: UserSettings,
  ): Promise<HandlerResponse> {
    try {
      switch (cmd.command) {
        case 'add_livestock': return await this.addLivestock(cmd, userId);
        case 'remove_livestock': return await this.removeLivestock(cmd, userId);
        case 'set_livestock_price': return await this.setLivestockPrice(cmd, userId);
        case 'transfer_livestock': return await this.transferLivestock(cmd, userId);
        case 'record_livestock_death': return await this.recordDeath(cmd, userId);
        case 'record_livestock_birth': return await this.recordBirth(cmd, userId);
        case 'adjust_livestock': return await this.adjustLivestock(cmd, userId);
        case 'list_livestock': return await this.listLivestock(cmd, userId);
        case 'livestock_history': return await this.livestockHistory(cmd, userId);
        case 'log_health_event': return await this.logHealthEvent(cmd, userId);
        case 'query_health_events': return await this.queryHealthEvents(cmd, userId);
        case 'log_repro_event': return await this.logReproEvent(cmd, userId);
        case 'query_repro_events': return await this.queryReproEvents(cmd, userId);
        case 'log_weighing': return await this.logWeighing(cmd, userId);
        case 'query_weighings': return await this.queryWeighings(cmd, userId);
        case 'livestock_pick_location': return await this.pickLocation(cmd, userId);
        case 'livestock_apply_animals': return await this.applyAnimalsAffected(cmd, userId);
        case 'livestock_create_continue': return await this.createAndContinue(cmd, userId);
        case 'livestock_create_cancel': return await this.createCancel(cmd, userId);
        case 'livestock_place_choice': return await this.placeLocationChoice(cmd, userId);
        case 'livestock_move_choice': return await this.moveOrNewChoice(cmd, userId);
        case 'livestock_place_corral': return await this.placeCorralChoice(cmd, userId);
        case 'livestock_post_stock': return await this.postActionStock(cmd, userId);
        case 'livestock_post_weigh': return await this.postActionWeigh(cmd, userId);
        case 'livestock_post_gdpv': return await this.postActionGdpv(cmd, userId);
        case 'livestock_post_health_hist': return await this.postActionHealthHist(cmd, userId);
        case 'livestock_post_repro_hist': return await this.postActionReproHist(cmd, userId);
        case 'livestock_post_resumen_mes': return await this.postActionResumenMes(cmd, userId);
        case 'livestock_post_new_event': return await this.postActionNewEvent(cmd, userId);
        case 'livestock_post_undo_movement': return await this.postActionUndoMovement(cmd, userId);
        case 'livestock_post_undo_event': return await this.postActionUndoEvent(cmd, userId);
        default:
          return { messages: ['Comando de hacienda no reconocido.'] };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error en operación de hacienda';
      return { messages: [`❌ ${msg}`] };
    }
  }

  async createAndContinue(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const subType = cmd.subType as 'corral' | 'plot' | 'feedlot' | 'field';
    const payload = decodeLivestockPayload(cmd.payload as string);
    const { missingName } = payload;
    if (!missingName) return { messages: ['No tengo info para crear. Probá registrar la operación de nuevo.'] };

    try {
      if (subType === 'corral') {
        const feedlots = await this.feedlotService.listFeedlots(userId);
        if (feedlots.length !== 1) {
          return { messages: ['Tenés más de un feedlot. Decime cuál usar: "crear corral X en campo Y".'] };
        }
        await this.feedlotService.createCorral(userId, missingName, feedlots[0].field_name || null, {});
      } else if (subType === 'feedlot') {
        const fieldName = (payload.cmd.fieldName as string | undefined) || payload.fieldName;
        if (!fieldName) return { messages: ['Necesito saber el campo para crear el feedlot.'] };
        await this.feedlotService.createFeedlot(userId, fieldName, 'Feedlot', {});
        await this.feedlotService.createCorral(userId, missingName, fieldName, {});
      } else if (subType === 'plot') {
        return { messages: ['Para esta versión, creá el lote primero con "agregar lote Norte en campo X" y volvé a intentar.'] };
      } else if (subType === 'field') {
        return { messages: ['Para esta versión, creá el campo primero con "nuevo campo X" y volvé a intentar.'] };
      }
      return this.handleCommand(payload.cmd, userId, {} as User, {} as UserSettings);
    } catch (err: unknown) {
      return { messages: [`Hubo un problema creando: ${err instanceof Error ? err.message : String(err)}`] };
    }
  }

  async createCancel(_cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
    return { messages: ['Cancelado. Si querés volver a intentarlo, registrá la operación de nuevo.'] };
  }

  // ========================
  // POST-ACTION CALLBACKS
  // ========================

  async postActionStock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const plotId = cmd.plotIdStr === 'null' ? null : Number(cmd.plotIdStr);
    const corralId = cmd.corralIdStr === 'null' ? null : Number(cmd.corralIdStr);
    const rebuilt = { command: 'list_livestock' } as ParsedCommand & Record<string, unknown>;
    if (plotId != null) rebuilt.__resolvedPlotId = plotId;
    if (corralId != null) rebuilt.__resolvedCorralId = corralId;
    return this.listLivestock(rebuilt, userId);
  }

  async postActionWeigh(_cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
    return { messages: ['⚖️ Decime el peso promedio (ej: "los novillos del corral 1 a 380 kg").'] };
  }

  async postActionGdpv(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    return this.queryWeighings({ ...(cmd as ParsedCommand), command: 'query_weighings' } as ParsedCommand, userId);
  }

  async postActionHealthHist(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    return this.queryHealthEvents({ ...(cmd as ParsedCommand), command: 'query_health_events' } as ParsedCommand, userId);
  }

  async postActionReproHist(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    return this.queryReproEvents({ ...(cmd as ParsedCommand), command: 'query_repro_events' } as ParsedCommand, userId);
  }

  async postActionResumenMes(_cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
    return { messages: ['📊 Para ver el resumen del mes, escribí *resumen del mes*.'] };
  }

  async postActionUndoMovement(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const movementId = cmd.movementId as string;
    try {
      const r = await this.service.undoMovement(userId, movementId);
      return { messages: [`↩️ ${r.label} aplicado.`] };
    } catch (err: unknown) {
      return { messages: [err instanceof Error ? err.message : String(err)] };
    }
  }

  async postActionUndoEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const eventId = Number(cmd.eventId);
    if (!Number.isFinite(eventId)) return { messages: ['ID de evento inválido.'] };
    const ok = await this.service.softDeleteDomainEvent(userId, eventId);
    if (!ok) return { messages: ['No encontré ese evento para deshacer.'] };
    return { messages: ['↩️ Evento eliminado.'] };
  }

  async postActionNewEvent(cmd: ParsedCommand, _userId: UserId): Promise<HandlerResponse> {
    const subKind = cmd.subKind as 'health' | 'repro';
    return {
      messages: [
        subKind === 'health'
          ? '💉 Decime el evento sanitario (ej: "vacuné a 20 vacas contra aftosa").'
          : '🐂 Decime el evento reproductivo (ej: "eché el toro a 30 vacas").',
      ],
    };
  }

  /**
   * When a livestock movement fails because a corral / lote / feedlot / campo
   * doesn't exist, surface Sí/No buttons so the user can create the missing
   * location and continue the operation. Returns null when the error is not
   * a recognized "not found" case.
   */
  private async maybeOfferCreateAndContinue(
    cmd: ParsedCommand,
    userId: UserId,
    errorMsg: string,
  ): Promise<HandlerResponse | null> {
    const corralMatch = errorMsg.match(/No encontré el corral "([^"]+)"/);
    const plotMatch = errorMsg.match(/No encontré el lote "([^"]+)"/);
    const fieldMatch = errorMsg.match(/No encontré el campo "([^"]+)"/);
    const noLotesMatch = errorMsg.match(/El campo "([^"]+)" no tiene lotes/);

    let missingType: 'corral' | 'plot' | 'feedlot' | 'field' | null = null;
    let missingName = '';
    if (corralMatch) { missingType = 'corral'; missingName = corralMatch[1]; }
    else if (plotMatch) { missingType = 'plot'; missingName = plotMatch[1]; }
    else if (fieldMatch) { missingType = 'field'; missingName = fieldMatch[1]; }
    else if (noLotesMatch) { missingType = 'plot'; missingName = 'A1'; }
    if (!missingType) return null;

    const feedlotCount = await this.feedlotService.countUserFeedlots(userId);
    const payload = encodeLivestockPayload({
      cmd, step: 'create_loc', missingType, missingName,
      fieldName: cmd.fieldName as string | undefined,
    });

    let body = '';
    let yesId = '';
    if (missingType === 'corral') {
      if (feedlotCount === 0) {
        body = `🔍 No encontré el corral *${missingName}* (no tenés feedlots). ¿Querés que cree el feedlot y el corral, y registre la operación?`;
        yesId = `lv_create_feedlot_continue_${payload}`;
      } else {
        body = `🔍 No encontré el corral *${missingName}*. ¿Querés que lo cree y continúe?`;
        yesId = `lv_create_corral_continue_${payload}`;
      }
    } else if (missingType === 'plot') {
      body = `🔍 No encontré el lote *${missingName}*. ¿Querés que lo cree y continúe?`;
      yesId = `lv_create_plot_continue_${payload}`;
    } else if (missingType === 'field') {
      body = `🔍 No encontré el campo *${missingName}*. ¿Querés que lo cree y continúe?`;
      yesId = `lv_create_field_continue_${payload}`;
    }

    return {
      messages: [],
      interactive: {
        type: 'buttons' as const,
        body,
        buttons: [
          { id: yesId, title: 'Sí, crear y continuar' },
          { id: 'lv_create_cancel', title: 'No, cancelar' },
        ],
      },
    };
  }

  // ========================
  // LOCATION: LOTE vs FEEDLOT (deterministic)
  // ========================

  /** Ambiguous location → ask with Lote/Feedlot buttons (no orphan free-text). */
  private async askLivestockLocationType(
    cmd: ParsedCommand,
    _userId: UserId,
    category: string,
    count: number,
  ): Promise<HandlerResponse> {
    const token = callbackPayloadStore.set(encodeLivestockPayload({ cmd, step: 'pick_loc' }));
    const label = LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category;
    return {
      messages: [],
      interactive: {
        type: 'buttons' as const,
        body: `🐄 ¿Dónde van ${count} ${label}? Elegí:`,
        buttons: [
          { id: `lv_loc_lote_${token}`, title: '🌾 En un lote' },
          { id: `lv_loc_feedlot_${token}`, title: '🏗️ En un feedlot' },
        ],
      },
    };
  }

  /** Button tap on the Lote/Feedlot prompt. */
  async placeLocationChoice(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const stored = callbackPayloadStore.get(cmd.payload as string);
    if (!stored) return { messages: ['Esa opción expiró. Volvé a registrar la hacienda (ej: "agregá 50 vacas").'] };
    const { cmd: origCmd } = decodeLivestockPayload(stored);
    if (cmd.placeChoice === 'feedlot') {
      return this.placeLivestockInFeedlot(origCmd, userId);
    }
    // Lote: re-run forzando el camino de lote (sin re-preguntar lote-vs-feedlot).
    return this.addLivestock({ ...origCmd, __forcePlotPath: true } as ParsedCommand, userId);
  }

  /** Deterministic feedlot placement: auto-create feedlot+corral if none, pick corral. */
  private async placeLivestockInFeedlot(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    let fieldName = (cmd.fieldName as string | null) || null;
    if (!fieldName) {
      const { getUserFields } = await import('../../services/expenses.js');
      const fields = await getUserFields(userId);
      if (fields.length === 0) return { messages: ['Primero creá un campo: *nuevo campo La Esperanza*.'] };
      if (fields.length === 1) fieldName = fields[0].name;
      else {
        const names = fields.map((f: { name: string }) => f.name).join(', ');
        return { messages: [`¿En qué campo está el feedlot? Tenés: ${names}.\nDecime, ej: "...en el campo ${fields[0].name}".`] };
      }
    }

    const norm = (s: string | null | undefined) => (s || '').toLowerCase().trim();
    const feedlots = await this.feedlotService.listFeedlots(userId);
    const fl = feedlots.find(f => norm(f.field_name) === norm(fieldName));

    let corralName: string;
    let note = '';
    try {
      if (!fl) {
        await this.feedlotService.createFeedlot(userId, fieldName, `Feedlot ${fieldName}`);
        const c = await this.feedlotService.createCorral(userId, '1', fieldName);
        corralName = c.name;
        note = '🏗️ Feedlot y corral creados.\n';
      } else {
        const corrals = await this.feedlotService.listCorrals(userId, fieldName);
        if (corrals.length === 0) {
          const c = await this.feedlotService.createCorral(userId, '1', fieldName);
          corralName = c.name;
          note = '🔲 Corral creado.\n';
        } else if (corrals.length === 1) {
          corralName = corrals[0].name;
        } else {
          return this.askLivestockCorral(cmd, fieldName, corrals);
        }
      }
    } catch (err: unknown) {
      return { messages: [`No pude preparar el feedlot: ${err instanceof Error ? err.message : String(err)}`] };
    }

    const placed = await this.addLivestock({ ...cmd, corralName, fieldName } as ParsedCommand, userId);
    if (note && placed.messages && placed.messages.length > 0) {
      placed.messages[0] = note + placed.messages[0];
    }
    return placed;
  }

  /** Feedlot has 2+ corrales → ask which one (buttons, no free-text). */
  private async askLivestockCorral(
    cmd: ParsedCommand,
    fieldName: string,
    corrals: Array<{ name: string }>,
  ): Promise<HandlerResponse> {
    // One token per corral: each carries the original cmd + the chosen corral,
    // so the callback_data is just `lv_loc_corralpick_<token>` (no name to parse
    // out — base64url tokens contain '_', which would break inline delimiters).
    const buttons = corrals.slice(0, 8).map(c => {
      const token = callbackPayloadStore.set(
        encodeLivestockPayload({ cmd: { ...cmd, fieldName, corralName: c.name } as ParsedCommand, step: 'pick_loc' }),
      );
      return { id: `lv_loc_corralpick_${token}`, title: c.name.slice(0, 24) };
    });
    return {
      messages: [],
      interactive: { type: 'buttons' as const, body: `🏗️ ¿En qué corral del feedlot (${fieldName})?`, buttons },
    };
  }

  /** Button tap selecting a specific corral. */
  async placeCorralChoice(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const stored = callbackPayloadStore.get(cmd.payload as string);
    if (!stored) return { messages: ['Esa opción expiró. Volvé a registrar la hacienda.'] };
    const { cmd: origCmd } = decodeLivestockPayload(stored);
    return this.addLivestock({ ...origCmd } as ParsedCommand, userId);
  }

  // ========================
  // ADD
  // ========================

  /**
   * Cuantificador distributivo perdido: "murieron 10 vacas EN CADA LOTE" con
   * UNA sola tool emitida registra la mitad en silencio (bug prod Ago 2026:
   * quedaron 40 en vez de 30). No podemos expandir determinísticamente (no
   * sabemos si el agente ya emitió las otras), pero SÍ avisar (invariante 1).
   * En compound (_bulkMode) el agente emitió N tools → sin advisory.
   */
  private distributiveAdvisory(cmd: ParsedCommand, appliedLoc: string): string {
    if (cmd._bulkMode) return '';
    const t = (cmd.originalText as string) || '';
    if (!/\ben\s+cada\s+(lote|potrero|corral|campo)s?\b/i.test(t)) return '';
    console.log(`[INTERCEPT] LIVESTOCK DISTRIBUTIVE-SUSPECT: "en cada lote" con UNA sola operación (aplicada en ${appliedLoc}) — advisory al usuario`);
    return `\n\n⚠️ _Ojo: esto lo registré SOLO en *${appliedLoc}*. Si era en cada lote, decime los demás: ej. "murieron 10 vacas en Norte"._`;
  }

  /**
   * Bajas/ventas/ajustes SIN ubicación: resolver por los GRUPOS de la
   * categoría — 1 grupo → directo; 2+ → pending real con las opciones.
   * NUNCA heredar el lote del contexto conversacional: "se murió 1 vaca"
   * tras operar en Alto buscaba vacas en Alto (no había) y fallaba sin
   * listar el inventario (barrido de agentes Ago 2026).
   */
  private async presetLocationFromGroups(cmd: ParsedCommand, userId: UserId, category: string): Promise<HandlerResponse | null> {
    if (cmd.plotName || cmd.corralName || cmd.fieldName || cmd._bulkMode) return null;
    let groups: Awaited<ReturnType<LivestockService['findGroupsByCategory']>>;
    try {
      groups = await this.service.findGroupsByCategory(userId, category);
    } catch { return null; }
    const alive = groups.filter(g => Number(g.count) > 0);
    if (alive.length === 1) {
      try {
        const { pool } = await import('../../config/db.js');
        if (alive[0].corral_id) {
          const r = await pool.query(`SELECT name FROM corrals WHERE id = $1`, [alive[0].corral_id]);
          if (r.rows[0]?.name) cmd.corralName = r.rows[0].name;
        } else if (alive[0].plot_id) {
          const r = await pool.query(`SELECT name FROM plots WHERE id = $1`, [alive[0].plot_id]);
          if (r.rows[0]?.name) cmd.plotName = r.rows[0].name;
        }
      } catch { /* best-effort */ }
      return null;
    }
    if (alive.length > 1) {
      const labels = alive.slice(0, 6).map(g => `${g.location_label} (${g.count})`).join(', ');
      const ask = `🐄 ¿De qué ubicación? Tenés ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] ?? category}s en: ${labels}.`;
      return {
        messages: [ask],
        sideEffects: { setPendingActivity: { command: cmd.command as string, data: { ...cmd }, missing: ['plot'], askPrompt: ask } },
      };
    }
    return null; // 0 grupos → que el service produzca su error con inventario
  }

  /** Tap de la oferta mover-vs-alta ("metí N al corral"). */
  private async moveOrNewChoice(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { callbackPayloadStore } = await import('../../middleware/callback-payload-store.js');
    const raw = callbackPayloadStore.get((cmd.payload as string) || '');
    if (!raw) return { messages: ['Ese botón venció. Repetime la operación, ej: *"pasá 10 terneros al corral 2"*.'] };
    const p = JSON.parse(raw) as {
      category: string; count: number;
      srcPlotId: number | null; srcCorralId: number | null; srcLabel: string;
      destPlot: string | null; destCorral: string | null; fieldName: string | null;
      original: Record<string, unknown>;
    };
    if (cmd.moveChoice === 'new') {
      return await this.addLivestock({ ...(p.original as ParsedCommand), __skipMoveOffer: true } as ParsedCommand, userId);
    }
    // Mover: resolver el nombre de la ubicación origen para el transfer
    let sourcePlot: string | null = null;
    let sourceCorral: string | null = null;
    try {
      const { pool } = await import('../../config/db.js');
      if (p.srcCorralId) {
        const r = await pool.query(`SELECT name FROM corrals WHERE id = $1`, [p.srcCorralId]);
        sourceCorral = r.rows[0]?.name ?? null;
      } else if (p.srcPlotId) {
        const r = await pool.query(`SELECT name FROM plots WHERE id = $1`, [p.srcPlotId]);
        sourcePlot = r.rows[0]?.name ?? null;
      }
    } catch { /* best-effort */ }
    return await this.transferLivestock({
      command: 'transfer_livestock',
      category: p.category,
      count: p.count,
      sourcePlot,
      sourceCorral,
      destPlot: p.destPlot,
      destCorral: p.destCorral,
      fieldName: p.fieldName,
      originalText: (p.original.originalText as string) || '',
    } as ParsedCommand, userId);
  }

  private async addLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito saber la categoría. Ej: "agregué 20 vacas".'] };
    if (!count || count <= 0) {
      // Pending machine-readable (invariante 5): "compré vacas" → preguntar la
      // cantidad y consumir la respuesta ("20") sin round-trip al agente.
      const askAdd = `🐄 ¿Cuántas cabezas${category ? ` de ${category.toLowerCase()}` : ''}?`;
      return {
        messages: [askAdd],
        sideEffects: { setPendingActivity: { command: 'add_livestock', data: { ...cmd }, missing: ['count'], askPrompt: askAdd } },
      };
    }
    // "Metí/encerré/pasé N <categoría> al corral X" con un grupo existente de
    // la misma categoría en OTRA ubicación: casi seguro es un MOVIMIENTO, no
    // un alta — el alta duplicaba el inventario en silencio (95→105, barrido
    // de agentes Ago 2026). Preguntamos con botones (nunca texto suelto).
    const moveVerb = /\b(?:met[íi]|encerr[ée]|pas[ée]|mand[ée]|llev[ée])(?=\s|$|[.,;:!?])/i.test((cmd.originalText as string) || '');
    const hasTarget = !!(cmd.corralName || cmd.plotName);
    const skipOffer = !!(cmd as Record<string, unknown>).__skipMoveOffer || cmd._bulkMode
      || (cmd as Record<string, unknown>).__resolvedPlotId != null || (cmd as Record<string, unknown>).__resolvedCorralId != null;
    if (moveVerb && hasTarget && !skipOffer) {
      try {
        const existing = await this.service.findGroupsByCategory(userId, category);
        const targetName = ((cmd.corralName || cmd.plotName) as string).toLowerCase();
        const candidates = existing.filter(g => Number(g.count) >= count && !g.location_label.toLowerCase().includes(targetName));
        if (candidates.length > 0) {
          const src = candidates[0];
          const { callbackPayloadStore } = await import('../../middleware/callback-payload-store.js');
          const token = callbackPayloadStore.set(JSON.stringify({
            category, count,
            srcPlotId: src.plot_id, srcCorralId: src.corral_id, srcLabel: src.location_label,
            destPlot: (cmd.plotName as string) || null, destCorral: (cmd.corralName as string) || null,
            fieldName: (cmd.fieldName as string) || null,
            original: { ...cmd },
          }));
          return {
            messages: [],
            interactive: {
              type: 'buttons' as const,
              body: `🐄 Tenés ${src.count} ${LIVESTOCK_CATEGORY_LABEL[src.category as LivestockCategory] ?? src.category}s en *${src.location_label}*. ¿Los ${count} que "metiste" son de ahí (los muevo) o son animales nuevos?`,
              buttons: [
                { id: `lv_move_yes_${token}`, title: '🔁 Moverlos' },
                { id: `lv_move_new_${token}`, title: '➕ Son nuevos' },
              ],
            },
          };
        }
      } catch { /* best-effort: ante error seguimos con el alta normal */ }
    }

    // Hardening: reject absurd counts + out-of-range movement dates.
    {
      const { validateLivestockCount, validateDate } = await import('../../utils/value-validator.js');
      const cntCheck = validateLivestockCount(count);
      if (!cntCheck.ok) return { messages: [cntCheck.reason] };
      const dateCheck = validateDate((cmd.eventDate as string) ?? null, 'fecha del movimiento');
      if (!dateCheck.ok) return { messages: [dateCheck.reason] };
    }

    // Resolución determinística lote-vs-feedlot. Cuando el agente NO pasó una
    // ubicación concreta (ni plot ni corral) y el usuario habla de feedlot o
    // duda ("no sé si lote o feedlot"), decidimos NOSOTROS — no el LLM con
    // texto suelto (eso daba resultados no determinísticos: a veces lote, a
    // veces feedlot). Ver utils/livestock-location-intent.ts.
    const skipLocPrompt = (cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true
      || cmd.__forcePlotPath === true
      || cmd.__resolvedCorralId != null || cmd.__resolvedPlotId != null;
    if (!skipLocPrompt && !cmd.plotName && !cmd.corralName) {
      const locIntent = livestockLocationIntent(cmd.originalText as string | null);
      if (locIntent === 'ambiguous') {
        return this.askLivestockLocationType(cmd, userId, category, count);
      }
      if (locIntent === 'feedlot') {
        return this.placeLivestockInFeedlot(cmd, userId);
      }
    }

    let group, created, financial, movement;
    try {
      ({ group, created, financial, movement } = await this.service.addAnimals(userId, {
        category,
        count,
        fieldName: cmd.fieldName as string,
        plotName: cmd.plotName as string,
        corralName: cmd.corralName as string,
        breed: cmd.breed as string,
        avg_weight_kg: cmd.avg_weight_kg as number,
        total_weight_kg: cmd.total_weight_kg as number,
        unit_price_ars: cmd.unit_price_ars as number,
        unit_price_usd: cmd.unit_price_usd as number,
        price_per_kg_ars: cmd.price_per_kg_ars as number,
        price_per_kg_usd: cmd.price_per_kg_usd as number,
        reason: cmd.reason as string,
        movement_date: cmd.eventDate as string,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const offer = await this.maybeOfferCreateAndContinue(cmd, userId, msg);
      if (offer) return offer;
      // Plot ambiguous / unspecified ("Decime en qué lote. Opciones: …"): instead
      // of a dead error that saves nothing AND keeps no state (so a pivot loses
      // the whole alta), set a pending so the next "Norte" completes it — and a
      // pivot triggers the pivot-flush deferred notice (no silent data loss).
      if (/Decime en qu[eé] lote/i.test(msg)) {
        return {
          messages: [msg],
          suggestionKey: 'default_menu',
          sideEffects: {
            setPendingActivity: {
              command: 'add_livestock',
              data: { ...cmd },
              missing: ['plot'],
              askPrompt: msg,
            },
          },
        };
      }
      throw err;
    }

    await this.bumpConversationContext(userId, group.plot_id, group.field_id);

    const newLabel = created ? ' (nuevo grupo)' : '';
    const breed = group.breed ? ` ${group.breed}` : '';
    const financialLine = financial
      ? `\n  💸 Gasto registrado: ${fmtAmount(financial.amount, financial.currency)} (Hacienda)`
      : '';
    const isPurchase = cmd.isPurchase === true;
    const hasPrice = !!(cmd.unit_price_ars || cmd.unit_price_usd || cmd.price_per_kg_ars || cmd.price_per_kg_usd);
    const askPriceLine = (isPurchase && !hasPrice && !financial)
      ? '\n\n¿A cuánto fue la compra? Así registro el gasto.'
      : '';

    const movementsCount = await this.service.countUserMovements(userId);
    const isFirstRecord = movementsCount === 1;
    const destIsPlot = group.plot_id != null;
    const nudgeLine = (isFirstRecord && destIsPlot)
      ? `\n\n💡 Si hacés engorde a corral, podés crear un feedlot con "nuevo feedlot en ${group.field_name || '<campo>'}".`
      : '';

    const body =
      `🐄 *Hacienda registrada*\n\n` +
      `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}${newLabel}\n` +
      `  ➕ ${count} animales\n` +
      `  📊 Total: *${group.count}*\n` +
      `  📍 ${fmtLoc(group)}` +
      financialLine +
      askPriceLine +
      nudgeLine;

    const buttons = buildPostActionButtons('add', {
      groupId: String(group.id),
      movementId: movement?.id ? String(movement.id) : undefined,
      plotId: group.plot_id,
      corralId: group.corral_id,
    });

    // bulkMode: when this add happened inside a compound AND the group got
    // saved without a plot (only field auto-resolved), emit savedRecordsWithoutPlot
    // so the post-compound bulk-plot prompt offers reassignment with one tap.
    // Without this, the user sees "📍 — (la esperanza)" and has no way to
    // assign a plot retroactively.
    const bulkExtras = ((cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true
      && group.plot_id == null
      && group.corral_id == null
      && group.field_id)
      // group.id viene como texto (id::text en la query) — `as number` no
      // convierte, solo miente el tipo; hay que parsearlo.
      ? { savedRecordsWithoutPlot: [{ kind: 'livestock' as const, id: Number(group.id), fieldId: group.field_id as number }] }
      : {};

    // Cuando preguntamos el precio, dejamos un pending REAL apuntando al
    // movimiento. Sin esto la pregunta era texto huérfano y la respuesta
    // ("la compra fue a mil pesos por vaca") llegaba al agente sin contexto —
    // Haiku la mapeaba a edit_last_expense y corrompía el último gasto que
    // existiera (visto live: pisó un gasto de agroquímicos en USD).
    const priceSideEffects = (askPriceLine && movement?.id)
      ? {
          sideEffects: {
            setPendingActivity: {
              command: 'set_livestock_price',
              data: { movementId: String(movement.id), kind: 'expense' },
              missing: ['unit_price'],
              askPrompt: '💰 ¿A cuánto fue la compra? (precio por cabeza, ej: "350 mil" o "1500 USD")',
            },
          },
        }
      : {};

    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons }, ...bulkExtras, ...priceSideEffects }
      : { messages: [body], ...bulkExtras, ...priceSideEffects };
  }

  // ========================
  // REMOVE
  // ========================

  private async removeLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "vendí 5 vacas".'] };
    if (!count || count <= 0) {
      const askRemove = `🐄 ¿Cuántas cabezas${category ? ` de ${category.toLowerCase()}` : ''}?`;
      return {
        messages: [askRemove],
        sideEffects: { setPendingActivity: { command: 'remove_livestock', data: { ...cmd }, missing: ['count'], askPrompt: askRemove } },
      };
    }

    const removePreset = await this.presetLocationFromGroups(cmd, userId, category);
    if (removePreset) return removePreset;

    let group, financial, movement;
    try {
      ({ group, financial, movement } = await this.service.removeAnimals(userId, {
        category,
        count,
        fieldName: cmd.fieldName as string,
        plotName: cmd.plotName as string,
        corralName: cmd.corralName as string,
        breed: cmd.breed as string,
        avg_weight_kg: cmd.avg_weight_kg as number,
        total_weight_kg: cmd.total_weight_kg as number,
        unit_price_ars: cmd.unit_price_ars as number,
        unit_price_usd: cmd.unit_price_usd as number,
        price_per_kg_ars: cmd.price_per_kg_ars as number,
        price_per_kg_usd: cmd.price_per_kg_usd as number,
        reason: cmd.reason as string,
        movement_date: cmd.eventDate as string,
        // In compound (bulkMode), if multiple breeds coexist, auto-pick the
        // largest group instead of throwing. Without this the compound stops
        // mid-stream and subsequent steps are lost.
        bulkMode: (cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const offer = await this.maybeOfferCreateAndContinue(cmd, userId, msg);
      if (offer) return offer;
      throw err;
    }

    await this.bumpConversationContext(userId, group.plot_id, group.field_id);

    const breed = group.breed ? ` ${group.breed}` : '';
    const financialLine = financial
      ? `\n  💰 Ingreso registrado: ${fmtAmount(financial.amount, financial.currency)} (Hacienda)`
      : '';
    const isSale = cmd.isSale === true;
    const hasPrice = !!(cmd.unit_price_ars || cmd.unit_price_usd || cmd.price_per_kg_ars || cmd.price_per_kg_usd);
    const askPriceLine = (isSale && !hasPrice && !financial)
      ? '\n\n¿A cuánto fue la venta? Así registro el ingreso.'
      : '';

    const body =
      `🐄 *Hacienda descontada*\n\n` +
      `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
      `  ➖ ${count} animales\n` +
      `  📊 Quedan: *${group.count}*\n` +
      `  📍 ${fmtLoc(group)}` +
      financialLine +
      this.distributiveAdvisory(cmd, fmtLoc(group)) +
      askPriceLine;

    const buttons = buildPostActionButtons('remove', {
      movementId: movement?.id ? String(movement.id) : undefined,
      plotId: group.plot_id,
      corralId: group.corral_id,
      isSale,
    });

    // Pending real para la respuesta al "¿a cuánto fue la venta?" — espejo
    // del pending de compra en addLivestock (ver comentario ahí).
    const priceSideEffects = (askPriceLine && movement?.id)
      ? {
          sideEffects: {
            setPendingActivity: {
              command: 'set_livestock_price',
              data: { movementId: String(movement.id), kind: 'income' },
              missing: ['unit_price'],
              askPrompt: '💰 ¿A cuánto fue la venta? (precio por cabeza, ej: "400 mil" o "1500 USD")',
            },
          },
        }
      : {};

    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons }, ...priceSideEffects }
      : { messages: [body], ...priceSideEffects };
  }

  // ========================
  // TRANSFER
  // ========================

  private async transferLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    const sourcePlot = cmd.sourcePlot as string;
    const destPlot = cmd.destPlot as string;
    const sourceCorral = cmd.sourceCorral as string;
    const destCorral = cmd.destCorral as string;
    const destCategory = cmd.destCategory as string;
    if (!category) return { messages: ['Necesito la categoría. Ej: "mové 10 vacas del lote A1 al lote B2".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };

    // Auto-resolve source: if not specified, look for a unique group of this category
    let effectiveSourcePlot = sourcePlot;
    let effectiveSourceCorral = sourceCorral;
    if (!sourcePlot && !sourceCorral) {
      try {
        const { groups } = await this.service.listInventory(userId, { category });
        const nonEmpty = groups.filter((g) => g.count > 0);
        if (nonEmpty.length === 1) {
          // Unique group — auto-resolve source location
          const g = nonEmpty[0];
          if (g.plot_name) effectiveSourcePlot = g.plot_name;
          if (g.corral_name) effectiveSourceCorral = g.corral_name;
        } else if (nonEmpty.length === 0) {
          return { messages: [`❌ No hay ${category} registrados.`] };
        } else {
          return { messages: ['Necesito el origen (lote o corral).'] };
        }
      } catch {
        return { messages: ['Necesito el origen (lote o corral).'] };
      }
    }
    if (!effectiveSourcePlot && !effectiveSourceCorral) return { messages: ['Necesito el origen (lote o corral).'] };
    // Recategorización in-situ: si hay destCategory pero no destino explícito, usar el mismo origen
    let effectiveDestPlot = destPlot;
    let effectiveDestCorral = destCorral;
    if (!destPlot && !destCorral && destCategory) {
      effectiveDestPlot = effectiveSourcePlot;
      effectiveDestCorral = effectiveSourceCorral;
    } else if (!destPlot && !destCorral) {
      return { messages: ['Necesito el destino (lote o corral).'] };
    }

    let sourceGroup, destGroup, movement;
    try {
      ({ sourceGroup, destGroup, movement } = await this.service.transferAnimals(userId, {
        category,
        count,
        sourceField: cmd.sourceField as string,
        sourcePlot: effectiveSourcePlot || undefined,
        sourceCorral: effectiveSourceCorral || undefined,
        destField: cmd.destField as string,
        destPlot: effectiveDestPlot || undefined,
        destCorral: effectiveDestCorral || undefined,
        breed: cmd.breed as string,
        destCategory: destCategory || undefined,
        reason: cmd.reason as string,
        movement_date: cmd.eventDate as string,
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const offer = await this.maybeOfferCreateAndContinue(cmd, userId, msg);
      if (offer) return offer;
      throw err;
    }

    await this.bumpConversationContext(userId, destGroup.plot_id, destGroup.field_id);

    const mvLabel = LIVESTOCK_MOVEMENT_LABEL[movement.movement_type];
    const breed = sourceGroup.breed ? ` ${sourceGroup.breed}` : '';
    // Recategorización: mostrar la categoría DESTINO — "Ternero ↗️ 20, Loma →
    // Loma" parecía una transferencia al mismo lote sin decir jamás "Novillo"
    // (QA agentes Ago 2026).
    const isRecat = sourceGroup.category !== destGroup.category;
    const categoryLine = isRecat
      ? `  ${LIVESTOCK_CATEGORY_LABEL[sourceGroup.category]}${breed} → *${LIVESTOCK_CATEGORY_LABEL[destGroup.category]}*\n`
      : `  ${LIVESTOCK_CATEGORY_LABEL[sourceGroup.category]}${breed}\n`;
    const body =
      `${mvLabel.emoji} *${mvLabel.label}*\n\n` +
      categoryLine +
      `  ↗️ ${count} animales\n` +
      `  Desde: *${fmtLoc(sourceGroup)}* (quedan ${sourceGroup.count})\n` +
      `  Hacia: *${fmtLoc(destGroup)}* (ahora ${destGroup.count})`;

    const buttons = buildPostActionButtons('transfer', {
      groupId: String(destGroup.id),
      movementId: movement?.id ? String(movement.id) : undefined,
      plotId: destGroup.plot_id,
      corralId: destGroup.corral_id,
    });

    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons } }
      : { messages: [body] };
  }

  // ========================
  // DEATH / BIRTH
  // ========================

  private async recordDeath(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "se murieron 2 terneros".'] };
    if (!count || count <= 0) {
      const askDeath = `🐄 ¿Cuántas cabezas${category ? ` de ${category.toLowerCase()}` : ''}?`;
      return {
        messages: [askDeath],
        sideEffects: { setPendingActivity: { command: 'record_livestock_death', data: { ...cmd }, missing: ['count'], askPrompt: askDeath } },
      };
    }

    // Expansión distributiva: "se murieron N vacas en cada lote" con UNA sola
    // tool y sin lote nombrado → aplicar la baja a CADA grupo de la categoría
    // (una muerte no es ambigua; las VENTAS no se expanden — involucran plata
    // y quedan con el advisory). QA agentes Ago 2026.
    const distributiveCue = !cmd._bulkMode && !cmd.plotName && !cmd.corralName
      && /\b(?:en\s+)?(?:cada|todos?\s+l[oa]s|ambos|los\s+dos)\s+(?:lotes?|potreros?|corrales?|campos?)\b/i.test((cmd.originalText as string) || '');
    if (distributiveCue) {
      const groups = await this.service.findGroupsByCategory(userId, category);
      if (groups.length > 1) {
        console.log(`[INTERCEPT] LIVESTOCK DISTRIBUTIVE-EXPAND: baja de ${count} ${category} aplicada a ${groups.length} grupos (user ${userId})`);
        const lines: string[] = [`💀 *Bajas registradas* (${category.toLowerCase()}, ${count} en cada ubicación)`, ''];
        const { pool } = await import('../../config/db.js');
        for (const g of groups) {
          try {
            let plotName: string | null = null;
            let corralName: string | null = null;
            if (g.corral_id) {
              const c = await pool.query(`SELECT name FROM corrals WHERE id = $1`, [g.corral_id]);
              corralName = c.rows[0]?.name ?? null;
            } else if (g.plot_id) {
              const p = await pool.query(`SELECT name FROM plots WHERE id = $1`, [g.plot_id]);
              plotName = p.rows[0]?.name ?? null;
            }
            const { group: gg } = await this.service.recordDeath(userId, {
              category, count,
              plotName, corralName,
              reason: cmd.reason as string, movement_date: cmd.eventDate as string,
            });
            lines.push(`  📍 ${g.location_label}: ➖ ${count} → quedan *${gg.count}*`);
          } catch (e: unknown) {
            lines.push(`  ⚠️ ${g.location_label}: no pude registrarla (${(e as Error).message})`);
          }
        }
        return { messages: [lines.join('\n')] };
      }
    }

    // Sin cue distributivo: resolver ubicación por grupos (1 → directo,
    // 2+ → pending; nunca heredar contexto).
    const deathPreset = await this.presetLocationFromGroups(cmd, userId, category);
    if (deathPreset) return deathPreset;

    const { group } = await this.service.recordDeath(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    await this.bumpConversationContext(userId, group.plot_id, group.field_id);

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `💀 *Baja registrada*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➖ ${count} animales\n` +
        `  📊 Quedan: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}` +
        (cmd.reason ? `\n  📝 ${cmd.reason}` : '') +
        this.distributiveAdvisory(cmd, fmtLoc(group)),
      ],
    };
  }

  private async recordBirth(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "nacieron 5 terneros en el lote A1".'] };
    if (!count || count <= 0) return { messages: ['Necesito la cantidad.'] };

    const { group } = await this.service.recordBirth(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      movement_date: cmd.eventDate as string,
    });

    await this.bumpConversationContext(userId, group.plot_id, group.field_id);

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐣 *Nacimiento registrado*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  ➕ ${count} animales\n` +
        `  📊 Total: *${group.count}*\n` +
        `  📍 ${fmtLoc(group)}`,
      ],
    };
  }

  // ========================
  // ADJUST
  // ========================

  private async adjustLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const category = cmd.category as string;
    const count = cmd.count as number;
    if (!category) return { messages: ['Necesito la categoría. Ej: "en el lote A1 hay 50 vacas".'] };
    if (count == null || count < 0) return { messages: ['Necesito la cantidad (0 o más). Ej: "en el lote A1 hay 50 vacas".'] };

    const { group, previousCount } = await this.service.adjustAnimals(userId, {
      category,
      count,
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      breed: cmd.breed as string,
      reason: cmd.reason as string,
      movement_date: cmd.eventDate as string,
    });

    await this.bumpConversationContext(userId, group.plot_id, group.field_id);

    const breed = group.breed ? ` ${group.breed}` : '';
    const diff = count - previousCount;
    const diffLabel = diff > 0 ? `+${diff}` : `${diff}`;
    return {
      messages: [
        `🔄 *Hacienda corregida*\n\n` +
        `  ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}\n` +
        `  📊 Antes: ${previousCount} → Ahora: *${group.count}*` +
        (diff !== 0 ? ` (${diffLabel})` : '') + `\n` +
        `  📍 ${fmtLoc(group)}`,
      ],
    };
  }

  // ========================
  // LIST / HISTORY
  // ========================

  private async listLivestock(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Unified dispatch: when any new param is set, route to the rich query handler
    const hasNewParam = cmd.view != null || cmd.inFeedlot != null || cmd.weightMinKg != null
      || cmd.weightMaxKg != null || cmd.countMin != null || cmd.countMax != null
      || cmd.aggregateMetric != null || cmd.group_by != null || cmd.sort_by != null
      || cmd.sort_desc != null || cmd.top_n != null || cmd.inherit != null
      || cmd.compareCategory != null || cmd.compareField != null || cmd.compareCorral != null
      || cmd.breed != null;
    if (hasNewParam) return this.handleQueryInventory(cmd, userId);

    const { groups, total } = await this.service.listInventory(userId, {
      fieldName: cmd.fieldName as string,
      plotName: cmd.plotName as string,
      corralName: cmd.corralName as string,
      category: cmd.category as string,
    });

    if (groups.length === 0) {
      return {
        messages: ['🐄 No tenés hacienda registrada. Cargá animales con "agregué 20 vacas al lote A1".'],
        suggestionKey: 'livestock_empty',
      };
    }

    // Group by location for readability
    const byLocation = new Map<string, LivestockGroupRow[]>();
    for (const g of groups) {
      const key = g.corral_name
        ? `🔲 Corral ${g.corral_name} (${g.feedlot_name || 'Feedlot'} — ${g.field_name || ''})`
        : `📍 ${g.field_name || '—'} / ${g.plot_name || '—'}`;
      if (!byLocation.has(key)) byLocation.set(key, []);
      byLocation.get(key)!.push(g);
    }

    const sections: string[] = [];
    for (const [locKey, locGroups] of byLocation.entries()) {
      let locWeight = 0;
      const lines = locGroups.map(g => {
        const breed = g.breed ? ` ${g.breed}` : '';
        const weight = g.avg_weight_kg ? ` (${g.avg_weight_kg} kg prom.)` : '';
        if (g.avg_weight_kg) locWeight += g.avg_weight_kg * g.count;
        return `    • ${LIVESTOCK_CATEGORY_LABEL[g.category]}${breed}: *${g.count}*${weight}`;
      });
      const weightLabel = locWeight > 0 ? `\n    ⚖️ Peso estimado: ${Math.round(locWeight).toLocaleString('es-AR')} kg` : '';
      sections.push(`  ${locKey}\n${lines.join('\n')}${weightLabel}`);
    }

    // Header must reflect any filter — calling a filtered count "total" was
    // misleading ("cuántas vacas?" → "Hacienda total: 190" while there were 228).
    const catLabel = cmd.category ? (LIVESTOCK_CATEGORY_LABEL[cmd.category as keyof typeof LIVESTOCK_CATEGORY_LABEL] ?? String(cmd.category)) : null;
    const header = catLabel
      ? `🐄 *${catLabel}: ${total}*`
      : (cmd.fieldName || cmd.plotName || cmd.corralName)
        ? `🐄 *${total} animales* (filtrado)`
        : `🐄 *Hacienda total: ${total} animales*`;
    return {
      messages: [
        `${header}\n\n${sections.join('\n\n')}`,
      ],
    };
  }

  // ========================
  // HEALTH EVENTS (sanidad)
  // ========================

  /**
   * Resolve location for domain_events: returns plotId OR corralId (same pattern as tacto in agronomy).
   */
  private async resolveEventLocation(
    cmd: ParsedCommand,
    userId: UserId,
    opts: { allowContextStackFallback?: boolean } = {},
  ): Promise<{ plotId: number | null; corralId: number | null; label: string } | { error: string }> {
    const corralName = cmd.corralName as string | null;
    if (corralName) {
      try {
        const feedlotService = new FeedlotService();
        const ref = await feedlotService.resolveCorral(userId, corralName, cmd.fieldName as string | null);
        return { plotId: null, corralId: ref.corralId, label: `Feedlot ${ref.feedlotName} > ${ref.corralName}` };
      } catch (err: unknown) {
        return { error: (err as Error).message };
      }
    }

    const resolved = await this.plotDiscovery.resolveFromNames(
      userId,
      cmd.fieldName as string | null,
      cmd.plotName as string | null,
      opts.allowContextStackFallback === false ? { allowContextStackFallback: false } : undefined,
    );

    if (resolved.plotId) {
      const label = formatPlotLocation(resolved.fieldName, resolved.plotName);
      return { plotId: resolved.plotId, corralId: null, label };
    }

    // No specific plot — return null (event without location is OK for these)
    return { plotId: null, corralId: null, label: 'Sin ubicación' };
  }

  private async resolveEventLocationOrAsk(
    cmd: ParsedCommand,
    userId: UserId,
  ): Promise<
    | { plotId: number | null; corralId: number | null; label: string; autoResolved?: boolean; knownGroupCount?: number }
    | { needsLocationPick: true; options: Array<{ plotId: number | null; corralId: number | null; label: string; groupCount: number }> }
    | { error: string }
  > {
    const resolvedPlotId = (cmd as Record<string, unknown>).__resolvedPlotId as number | null | undefined;
    const resolvedCorralId = (cmd as Record<string, unknown>).__resolvedCorralId as number | null | undefined;
    if (resolvedPlotId != null || resolvedCorralId != null) {
      // Resolver el NOMBRE real: "📍 Ubicación seleccionada" en la card no le
      // dice nada al usuario (QA agentes Ago 2026).
      let realLabel = 'Ubicación seleccionada';
      try {
        const { pool } = await import('../../config/db.js');
        if (resolvedCorralId != null) {
          const r = await pool.query(`SELECT c.name AS corral, f.name AS field FROM corrals c JOIN feedlots ft ON ft.id = c.feedlot_id JOIN fields f ON f.id = ft.field_id WHERE c.id = $1`, [resolvedCorralId]);
          if (r.rows[0]) realLabel = `Corral ${r.rows[0].corral} (${r.rows[0].field})`;
        } else if (resolvedPlotId != null) {
          const r = await pool.query(`SELECT p.name AS plot, f.name AS field FROM plots p JOIN fields f ON f.id = p.field_id WHERE p.id = $1`, [resolvedPlotId]);
          if (r.rows[0]) realLabel = `${r.rows[0].plot} (${r.rows[0].field})`;
        }
      } catch { /* best-effort */ }
      return {
        plotId: resolvedPlotId ?? null,
        corralId: resolvedCorralId ?? null,
        label: realLabel,
      };
    }

    if (cmd.corralName || cmd.plotName) {
      const r = await this.resolveEventLocation(cmd, userId);
      if ('error' in r) return r;
      return { plotId: r.plotId, corralId: r.corralId, label: r.label };
    }

    const category = (cmd.category as string | null) ?? null;
    const groups = await this.service.findGroupsByCategory(userId, category);

    if (groups.length === 0) {
      // Decirle QUÉ tiene en vez del genérico "no tenés hacienda" — cuando el
      // mismatch es de categoría (pidió "novillos" y tiene "vacas"), el listado
      // le permite auto-corregirse en el próximo mensaje.
      const inventory = await this.service.listInventory(userId, {});
      if (inventory.groups.length > 0) {
        const have = inventory.groups
          .filter(g => Number(g.count) > 0) // sin grupos zombie "0 Terneros"
          .slice(0, 5)
          .map(g => `${g.count} ${LIVESTOCK_CATEGORY_LABEL[g.category] ?? g.category}${g.count === 1 ? '' : 's'} (${fmtLoc(g)})`)
          .join(', ');
        return { error: `No encontré ${category ? `"${category}s"` : 'esa categoría'} en tu hacienda. Tenés: ${have}. Repetí el registro con la categoría correcta.` };
      }
      return { error: 'No tenés hacienda registrada con esos criterios. Primero agregá animales con "agregué N <categoría> al lote X".' };
    }

    if (groups.length === 1) {
      const g = groups[0];
      return {
        plotId: g.plot_id,
        corralId: g.corral_id,
        label: g.location_label,
        autoResolved: true,
        knownGroupCount: g.count,
      };
    }

    return {
      needsLocationPick: true,
      options: groups.slice(0, 7).map(g => ({
        plotId: g.plot_id,
        corralId: g.corral_id,
        label: g.location_label,
        groupCount: g.count,
      })),
    };
  }

  async pickLocation(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = cmd.kind as 'health' | 'repro' | 'weigh';
    const plotId = cmd.plotIdStr === 'null' ? null : Number(cmd.plotIdStr);
    const corralId = cmd.corralIdStr === 'null' ? null : Number(cmd.corralIdStr);
    const payload = decodeLivestockPayload(cmd.payload as string);
    const rebuilt = { ...payload.cmd } as ParsedCommand & Record<string, unknown>;
    rebuilt.__resolvedPlotId = plotId;
    rebuilt.__resolvedCorralId = corralId;

    switch (kind) {
      case 'health': return this.logHealthEvent(rebuilt, userId);
      case 'repro':  return this.logReproEvent(rebuilt, userId);
      case 'weigh':  return this.logWeighing(rebuilt, userId);
      default: return { messages: ['Tipo de evento no reconocido.'] };
    }
  }

  async applyAnimalsAffected(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const kind = cmd.kind as 'health' | 'repro' | 'weigh';
    const mode = cmd.mode as 'all' | 'skip';
    const payload = decodeLivestockPayload(cmd.payload as string);
    const rebuilt = { ...payload.cmd } as ParsedCommand & Record<string, unknown>;
    if (payload.resolvedLocation) {
      if (payload.resolvedLocation.plotId != null) rebuilt.__resolvedPlotId = payload.resolvedLocation.plotId;
      if (payload.resolvedLocation.corralId != null) rebuilt.__resolvedCorralId = payload.resolvedLocation.corralId;
    }
    if (mode === 'all' && payload.knownGroupCount) {
      if (kind === 'weigh') rebuilt.animalsWeighed = payload.knownGroupCount;
      else rebuilt.animalsAffected = payload.knownGroupCount;
    } else {
      rebuilt.__animalsAffectedSkipped = true;
    }
    switch (kind) {
      case 'health': return this.logHealthEvent(rebuilt, userId);
      case 'repro':  return this.logReproEvent(rebuilt, userId);
      case 'weigh':  return this.logWeighing(rebuilt, userId);
      default: return { messages: ['Tipo de evento no reconocido.'] };
    }
  }

  private buildAnimalsAffectedAskResponse(
    cmd: ParsedCommand,
    resolvedLocation: { plotId: number | null; corralId: number | null; label: string },
    knownGroupCount: number | undefined,
    kind: 'health' | 'repro' | 'weigh',
  ): HandlerResponse {
    const payload = encodeLivestockPayload({
      cmd, step: 'animals', resolvedLocation, knownGroupCount,
    });
    const buttons: Array<{ id: string; title: string }> = [];
    if (knownGroupCount && knownGroupCount > 0) {
      buttons.push({ id: `lv_animals_all_${kind}_${payload}`, title: `Todos (${knownGroupCount})` });
    }
    buttons.push({ id: `lv_animals_skip_${kind}_${payload}`, title: 'Saltar' });
    // Register a unified pending so a TEXT reply ("las 280 vacas", "todas, 50")
    // is captured as the answer. Previously this only offered buttons and no
    // pending, so a typed count fell through to the classifier and the event
    // (servicio/vacunación/pesaje) was silently lost.
    const pendingCommand = (cmd.command as string | null) || (
      kind === 'health' ? 'log_health_event' : kind === 'repro' ? 'log_repro_event' : 'log_weighing'
    );
    return {
      messages: [],
      interactive: {
        type: 'buttons' as const,
        body: '¿A cuántos animales?',
        buttons,
      },
      sideEffects: {
        setPendingActivity: {
          command: pendingCommand,
          // La ubicación YA resuelta viaja en el pending — sin esto, contestar
          // la cantidad por texto re-preguntaba el lote que el usuario acababa
          // de elegir por botón (loop visto por QA agentes Ago 2026).
          data: {
            ...cmd,
            command: pendingCommand,
            __resolvedPlotId: resolvedLocation.plotId,
            __resolvedCorralId: resolvedLocation.corralId,
            __allCount: knownGroupCount ?? null,
          },
          missing: ['count'],
          askPrompt: '¿A cuántos animales?',
        },
      },
    };
  }

  private async logHealthEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const healthType = cmd.healthType as string;
    if (!healthType) return { messages: ['Necesito el tipo de evento sanitario (vacunación, desparasitación, tratamiento).'] };

    // Required-slot guard (unified pending-action pattern). vacunación and
    // desparasitación need the disease/vaccine name to be meaningful — without
    // it we'd save a hollow "Vacunación: ???" row.
    const needsDisease = healthType === 'vacunacion' || healthType === 'desparasitacion';
    if (needsDisease && !cmd.diseaseOrVaccine) {
      const askPrompt = healthType === 'vacunacion'
        ? '💉 ¿Contra qué vacuna fue? (ej: aftosa, brucelosis, IBR)'
        : '💊 ¿Con qué antiparasitario? (ej: ivermectina, doramectina)';
      return {
        messages: [askPrompt],
        sideEffects: {
          setPendingActivity: {
            command: 'log_health_event',
            data: { ...cmd },
            missing: ['product'],
            askPrompt,
          },
        },
      };
    }

    const loc = await this.resolveEventLocationOrAsk(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const inBulk = (cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true;

    let resolvedLoc: { plotId: number | null; corralId: number | null; label: string; knownGroupCount?: number };
    if ('needsLocationPick' in loc) {
      // bulkMode: auto-pick FIRST option (most populated group usually) so
      // the event saves. Without this, in a compound the location-pick
      // interactive stays in lastInteractive but the event is never persisted.
      if (inBulk && loc.options.length > 0) {
        const first = loc.options[0];
        resolvedLoc = { plotId: first.plotId, corralId: first.corralId, label: first.label, knownGroupCount: first.groupCount };
      } else {
        const payload = encodeLivestockPayload({ cmd, step: 'pick_loc' });
        return {
          messages: [],
          interactive: {
            type: 'buttons' as const,
            body: '¿En qué ubicación lo registramos?',
            buttons: loc.options.map(o => ({
              id: `lv_pick_loc_health_${payload}_${o.plotId ?? 'null'}_${o.corralId ?? 'null'}`,
              title: `${o.label} (${o.groupCount})`.slice(0, 24),
            })),
          },
        };
      }
    } else {
      resolvedLoc = { plotId: loc.plotId, corralId: loc.corralId, label: loc.label, knownGroupCount: 'knownGroupCount' in loc ? loc.knownGroupCount : undefined };
    }

    const category = cmd.category as string | null;
    const animalsAffected = typeof cmd.animalsAffected === 'number' ? cmd.animalsAffected : (typeof cmd.count === 'number' ? cmd.count : null);
    const diseaseOrVaccine = cmd.diseaseOrVaccine as string | null;
    const doseQuantity = typeof cmd.doseQuantity === 'number' ? cmd.doseQuantity : null;
    const doseUnit = cmd.doseUnit as string | null;
    const veterinarian = cmd.implement as string | null;

    if (animalsAffected == null && !(cmd as Record<string, unknown>).__animalsAffectedSkipped) {
      // bulkMode: don't ask — save with animals_affected=null. The user can edit later.
      if (!inBulk) {
        return this.buildAnimalsAffectedAskResponse(
          cmd,
          { plotId: resolvedLoc.plotId, corralId: resolvedLoc.corralId, label: resolvedLoc.label },
          resolvedLoc.knownGroupCount,
          'health',
        );
      }
    }

    const event = await saveDomainEvent(userId, {
      plotId: resolvedLoc.plotId,
      corralId: resolvedLoc.corralId,
      eventType: 'health_event',
      eventDate: (cmd.eventDate as string | Date | null) || null,
      productType: healthType,
      product: diseaseOrVaccine,
      animalCategory: category,
      animalsAffected,
      quantity: doseQuantity,
      unit: doseUnit,
      implement: veterinarian,
      notes: (cmd.notes as string | null) || null,
    });

    await this.bumpConversationContext(userId, resolvedLoc.plotId);

    const typeLabel = HEALTH_TYPE_LABEL[healthType] || healthType;
    const lines: string[] = [`💉 *Evento sanitario registrado*`];
    lines.push(`  Tipo: ${typeLabel}`);
    if (diseaseOrVaccine) lines.push(`  🦠 ${diseaseOrVaccine}`);
    if (animalsAffected && category) {
      lines.push(`  🐄 ${animalsAffected} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsAffected > 1 ? 's' : ''}`);
    } else if (animalsAffected) {
      lines.push(`  🐄 ${animalsAffected} animales`);
    }
    if (doseQuantity) lines.push(`  💊 ${doseQuantity} ${doseUnit || ''}/animal`);
    if (veterinarian) lines.push(`  👨‍⚕️ ${veterinarian}`);
    lines.push(`  📍 ${resolvedLoc.label}${('autoResolved' in loc && loc.autoResolved) ? ' (auto)' : ''}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (cmd.eventDate) {
      const dateStr = formatDateAR(cmd.eventDate as string);
      lines.push(`  📅 ${dateStr}`);
    }
    if (animalsAffected == null) {
      lines.push('  ⚠️ Sin cantidad de animales — agregalo más tarde si lo necesitás.');
    }

    const body = lines.join('\n');
    const buttons = buildPostActionButtons('health', {
      eventId: event?.id as number | undefined,
      plotId: resolvedLoc.plotId,
      corralId: resolvedLoc.corralId,
    });
    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons } }
      : { messages: [body] };
  }

  private async queryHealthEvents(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Filtro fantasma (mismo patrón que query_scoutings, 11e54b9): "cuándo
    // vacuné contra aftosa" sin nombrar lote debe buscar en TODOS los lotes —
    // heredar el lote del context_stack hacía que el bot NEGARA registros
    // existentes (QA agentes Ago 2026). El fallback de contexto solo corre si
    // el usuario referenció un lote por nombre o pronombre.
    const loc = await this.resolveEventLocation(cmd, userId, {
      allowContextStackFallback: userExplicitlyReferencedPlot(cmd.originalText as string | null),
    });
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'health_event', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      subtype: cmd.healthType as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['💉 No hay eventos sanitarios registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = formatDateAR(r.event_date as string);
      const typeLabel = HEALTH_TYPE_LABEL[r.product_type as string] || r.product_type;
      const disease = r.product ? ` — ${r.product}` : '';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? formatPlotLocation(r.field_name, r.plot_name)
        : '';
      return `  📅 ${date}: ${typeLabel}${disease}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    return { messages: [`💉 *Historial sanitario*\n\n${lines.join('\n')}`] };
  }

  // ========================
  // REPRO EVENTS (reproducción)
  // ========================

  private async logReproEvent(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const reproType = cmd.reproType as string;
    if (!reproType) return { messages: ['Necesito el tipo de evento reproductivo (servicio, destete, inseminación, detección de celo).'] };

    const loc = await this.resolveEventLocationOrAsk(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    const inBulk = (cmd as ParsedCommand & { _bulkMode?: boolean })._bulkMode === true;

    let resolvedLoc: { plotId: number | null; corralId: number | null; label: string; knownGroupCount?: number };
    if ('needsLocationPick' in loc) {
      if (inBulk && loc.options.length > 0) {
        const first = loc.options[0];
        resolvedLoc = { plotId: first.plotId, corralId: first.corralId, label: first.label, knownGroupCount: first.groupCount };
      } else {
        const payload = encodeLivestockPayload({ cmd, step: 'pick_loc' });
        return {
          messages: [],
          interactive: {
            type: 'buttons' as const,
            body: '¿En qué ubicación lo registramos?',
            buttons: loc.options.map(o => ({
              id: `lv_pick_loc_repro_${payload}_${o.plotId ?? 'null'}_${o.corralId ?? 'null'}`,
              title: `${o.label} (${o.groupCount})`.slice(0, 24),
            })),
          },
        };
      }
    } else {
      resolvedLoc = { plotId: loc.plotId, corralId: loc.corralId, label: loc.label, knownGroupCount: 'knownGroupCount' in loc ? loc.knownGroupCount : undefined };
    }

    const category = cmd.category as string | null;
    const animalsAffected = typeof cmd.animalsAffected === 'number' ? cmd.animalsAffected : (typeof cmd.count === 'number' ? cmd.count : null);
    const sireInfo = cmd.sireInfo as string | null;
    const method = cmd.method as string | null;

    if (animalsAffected == null && !(cmd as Record<string, unknown>).__animalsAffectedSkipped) {
      if (!inBulk) {
        return this.buildAnimalsAffectedAskResponse(
          cmd,
          { plotId: resolvedLoc.plotId, corralId: resolvedLoc.corralId, label: resolvedLoc.label },
          resolvedLoc.knownGroupCount,
          'repro',
        );
      }
    }

    // Consistencia suave: "desteté 30 terneros" con 20 en inventario se
    // registra igual (el evento puede ser correcto y el inventario viejo),
    // pero SE AVISA — antes pasaba mudo (QA agentes Ago 2026).
    let overshootNote = '';
    if (animalsAffected && category) {
      try {
        const invGroups = await this.service.findGroupsByCategory(userId, category);
        const totalCat = invGroups.reduce((a, g) => a + Number(g.count || 0), 0);
        if (totalCat > 0 && animalsAffected > totalCat) {
          overshootNote = `\n  ⚠️ _Ojo: registré ${animalsAffected}, pero en tu inventario figuran ${totalCat} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}s. Si el inventario está viejo, corregilo: "tengo ${animalsAffected} ${category}s"._`;
        }
      } catch { /* best-effort */ }
    }

    const event = await saveDomainEvent(userId, {
      plotId: resolvedLoc.plotId,
      corralId: resolvedLoc.corralId,
      eventType: 'repro_event',
      eventDate: (cmd.eventDate as string | Date | null) || null,
      productType: reproType,
      product: sireInfo,
      implement: method,
      animalCategory: category,
      animalsAffected,
      notes: (cmd.notes as string | null) || null,
    });

    await this.bumpConversationContext(userId, resolvedLoc.plotId);

    const typeLabel = REPRO_TYPE_LABEL[reproType] || reproType;
    const emoji = reproType === 'destete' ? '🍼' : reproType === 'inseminacion' ? '💉' : '🐂';
    const lines: string[] = [`${emoji} *Evento reproductivo registrado*`];
    lines.push(`  Tipo: ${typeLabel}`);
    if (animalsAffected && category) {
      lines.push(`  🐄 ${animalsAffected} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsAffected > 1 ? 's' : ''}`);
    } else if (animalsAffected) {
      lines.push(`  🐄 ${animalsAffected} animales`);
    }
    if (sireInfo) lines.push(`  🐂 ${sireInfo}`);
    if (overshootNote) lines.push(overshootNote);
    if (method) lines.push(`  🔬 Método: ${method}`);
    lines.push(`  📍 ${resolvedLoc.label}${('autoResolved' in loc && loc.autoResolved) ? ' (auto)' : ''}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (cmd.eventDate) {
      const dateStr = formatDateAR(cmd.eventDate as string);
      lines.push(`  📅 ${dateStr}`);
    }
    if (animalsAffected == null) {
      lines.push('  ⚠️ Sin cantidad de animales — agregalo más tarde si lo necesitás.');
    }

    const body = lines.join('\n');
    const buttons = buildPostActionButtons('repro', {
      eventId: event?.id as number | undefined,
      plotId: resolvedLoc.plotId,
      corralId: resolvedLoc.corralId,
    });
    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons } }
      : { messages: [body] };
  }

  private async queryReproEvents(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Filtro fantasma (mismo patrón que query_scoutings, 11e54b9): "cuándo
    // vacuné contra aftosa" sin nombrar lote debe buscar en TODOS los lotes —
    // heredar el lote del context_stack hacía que el bot NEGARA registros
    // existentes (QA agentes Ago 2026). El fallback de contexto solo corre si
    // el usuario referenció un lote por nombre o pronombre.
    const loc = await this.resolveEventLocation(cmd, userId, {
      allowContextStackFallback: userExplicitlyReferencedPlot(cmd.originalText as string | null),
    });
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'repro_event', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      subtype: cmd.reproType as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['🐂 No hay eventos reproductivos registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = formatDateAR(r.event_date as string);
      const typeLabel = REPRO_TYPE_LABEL[r.product_type as string] || r.product_type;
      const sire = r.product ? ` — ${r.product}` : '';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? formatPlotLocation(r.field_name, r.plot_name)
        : '';
      return `  📅 ${date}: ${typeLabel}${sire}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    return { messages: [`🐂 *Historial reproductivo*\n\n${lines.join('\n')}`] };
  }

  // ========================
  // WEIGHING (pesaje)
  // ========================

  private async logWeighing(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const avgWeightKg = typeof cmd.avg_weight_kg === 'number' ? cmd.avg_weight_kg : null;
    if (!avgWeightKg) return { messages: ['Necesito el peso promedio en kg. Ej: "pesé los novillos, 380 kg promedio".'] };

    const loc = await this.resolveEventLocationOrAsk(cmd, userId);
    if ('error' in loc) return { messages: [loc.error] };

    if ('needsLocationPick' in loc) {
      const payload = encodeLivestockPayload({ cmd, step: 'pick_loc' });
      return {
        messages: [],
        interactive: {
          type: 'buttons' as const,
          body: '¿En qué ubicación lo registramos?',
          buttons: loc.options.map(o => ({
            id: `lv_pick_loc_weigh_${payload}_${o.plotId ?? 'null'}_${o.corralId ?? 'null'}`,
            title: `${o.label} (${o.groupCount})`.slice(0, 24),
          })),
        },
      };
    }

    const category = cmd.category as string | null;
    // Accept the count filled via the unified pending ('¿a cuántos?' → text
    // reply "los 30") through animalsAffected/count, not only animalsWeighed.
    const animalsWeighed = typeof cmd.animalsWeighed === 'number' ? cmd.animalsWeighed
      : typeof cmd.animalsAffected === 'number' ? cmd.animalsAffected
      : typeof cmd.count === 'number' ? cmd.count
      : null;

    if (animalsWeighed == null && !(cmd as Record<string, unknown>).__animalsAffectedSkipped) {
      return this.buildAnimalsAffectedAskResponse(
        cmd,
        { plotId: loc.plotId, corralId: loc.corralId, label: loc.label },
        'knownGroupCount' in loc ? loc.knownGroupCount : undefined,
        'weigh',
      );
    }

    const event = await saveDomainEvent(userId, {
      plotId: loc.plotId,
      corralId: loc.corralId,
      eventType: 'weighing',
      eventDate: (cmd.eventDate as string | Date | null) || null,
      quantity: avgWeightKg,
      unit: 'kg',
      animalCategory: category,
      animalsAffected: animalsWeighed,
      notes: (cmd.notes as string | null) || null,
    });

    if (category) {
      await updateLivestockGroupWeight(userId, {
        category,
        plotId: loc.plotId,
        corralId: loc.corralId,
        avgWeightKg,
      });
    }

    await this.bumpConversationContext(userId, loc.plotId);

    const lines: string[] = ['⚖️ *Pesaje registrado*'];
    if (animalsWeighed && category) {
      lines.push(`  🐄 ${animalsWeighed} ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}${animalsWeighed > 1 ? 's' : ''}`);
    } else if (category) {
      lines.push(`  🐄 ${LIVESTOCK_CATEGORY_LABEL[category as LivestockCategory] || category}`);
    }
    lines.push(`  📊 Peso promedio: *${avgWeightKg} kg*`);
    lines.push(`  📍 ${loc.label}${('autoResolved' in loc && loc.autoResolved) ? ' (auto)' : ''}`);
    if (cmd.notes) lines.push(`  📝 ${cmd.notes}`);
    if (animalsWeighed == null) {
      lines.push('  ⚠️ Sin cantidad de animales — agregalo más tarde si lo necesitás.');
    }
    if (cmd.eventDate) {
      const dateStr = formatDateAR(cmd.eventDate as string);
      lines.push(`  📅 ${dateStr}`);
    }

    const body = lines.join('\n');
    const buttons = buildPostActionButtons('weigh', {
      eventId: event?.id as number | undefined,
      plotId: loc.plotId,
      corralId: loc.corralId,
    });
    return buttons.length > 0
      ? { messages: [], interactive: { type: 'buttons' as const, body, buttons } }
      : { messages: [body] };
  }

  private async queryWeighings(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Filtro fantasma (mismo patrón que query_scoutings, 11e54b9): "cuándo
    // vacuné contra aftosa" sin nombrar lote debe buscar en TODOS los lotes —
    // heredar el lote del context_stack hacía que el bot NEGARA registros
    // existentes (QA agentes Ago 2026). El fallback de contexto solo corre si
    // el usuario referenció un lote por nombre o pronombre.
    const loc = await this.resolveEventLocation(cmd, userId, {
      allowContextStackFallback: userExplicitlyReferencedPlot(cmd.originalText as string | null),
    });
    if ('error' in loc) return { messages: [loc.error] };

    const rows = await queryLivestockEvents(userId, 'weighing', {
      plotId: loc.plotId,
      corralId: loc.corralId,
      category: cmd.category as string | null,
      desde: cmd.desde as string | null,
      hasta: cmd.hasta as string | null,
    });

    if (rows.length === 0) {
      return { messages: ['⚖️ No hay pesajes registrados con esos filtros.'] };
    }

    const lines = rows.map((r: Record<string, unknown>) => {
      const date = formatDateAR(r.event_date as string);
      const weight = r.quantity ? `${r.quantity} kg` : '—';
      const count = r.animals_affected ? ` (${r.animals_affected} ${r.animal_category || 'animales'})` : '';
      const location = r.corral_name
        ? `Corral ${r.corral_name}`
        : r.plot_name
        ? formatPlotLocation(r.field_name, r.plot_name)
        : '';
      return `  📅 ${date}: ${weight}${count}${location ? ` — 📍 ${location}` : ''}`;
    });

    // Calculate GDPV if 2+ weighings for same category+location
    let gdpvLine = '';
    if (rows.length >= 2) {
      const latest = rows[0] as Record<string, unknown>;
      const previous = rows[1] as Record<string, unknown>;
      const w1 = Number(latest.quantity);
      const w2 = Number(previous.quantity);
      if (w1 > 0 && w2 > 0) {
        const d1 = new Date(latest.event_date as string);
        const d2 = new Date(previous.event_date as string);
        const daysBetween = Math.abs(Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));
        if (daysBetween > 0) {
          const gdpv = ((w1 - w2) / daysBetween).toFixed(2);
          gdpvLine = `\n\n  📈 GDPV (últimos 2 pesajes): *${gdpv} kg/día* (${daysBetween} días)`;
        }
      }
    }

    return { messages: [`⚖️ *Pesajes*\n\n${lines.join('\n')}${gdpvLine}`] };
  }

  // ========================
  // LIST / HISTORY (existing)
  // ========================

  /**
   * livestock_history unificada (Ago 2026).
   *
   * Antes exigía categoría Y ubicación juntas: si faltaba una, caía a un volcado
   * de TODOS los movimientos sin filtrar. Eso hacía imposible responder "cuándo
   * nacieron terneros en el lote 1C" o "cuándo moví los novillos al Sur" — el
   * dato estaba en la base, pero la respuesta traía todo mezclado.
   *
   * Ahora los filtros (tipo de movimiento, categoría, lote, campo, período) se
   * aplican siempre, y hay vistas: detail / last / aggregate.
   */
  private async livestockHistory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    // Multi-turno: heredar la consulta previa de MOVIMIENTOS (columna propia,
    // separada de la de inventario — son preguntas distintas).
    if (cmd.inherit) {
      try {
        const { pool } = await import('../../config/db.js');
        const { rows } = await pool.query(
          'SELECT last_livestock_history_query, updated_at FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_livestock_history_query;
        const { isFreshMultiTurnEntry } = await import('../../middleware/multi-turn-state.js');
        if (prev && typeof prev === 'object' && isFreshMultiTurnEntry(rows[0]?.updated_at)) {
          for (const [k, v] of Object.entries(prev)) if (cmd[k] == null) cmd[k] = v as never;
        }
      } catch { /* no fatal */ }
    }

    const category = cmd.category as string;
    const plot = cmd.plotName as string;
    const corral = cmd.corralName as string;

    // La ficha por grupo (con stock actual) sólo tiene sentido cuando se pide
    // UN grupo concreto y sin filtro por tipo: en cualquier otro caso manda la
    // consulta de movimientos, que ahora sí filtra.
    const wantsGroupCard = !!category && (!!plot || !!corral)
      && !cmd.movementType && !cmd.view && !cmd.period && !cmd.desde && !cmd.hasta;
    if (!wantsGroupCard) {
      return this.aggregateLivestockMovements(cmd, userId);
    }

    const { group, movements } = await this.service.getHistory(userId, {
      category,
      fieldName: cmd.fieldName as string,
      plotName: plot || undefined,
      corralName: corral || undefined,
      breed: cmd.breed as string,
    });

    if (movements.length === 0) {
      return { messages: [`No hay movimientos de *${LIVESTOCK_CATEGORY_LABEL[group.category]}* en ${fmtLoc(group)}.`] };
    }

    const lines = movements.map(m => {
      const mv = LIVESTOCK_MOVEMENT_LABEL[m.movement_type];
      const date = formatDateAR(m.movement_date);
      const sign = ['entrada', 'nacimiento'].includes(m.movement_type)
        ? '+'
        : ['salida', 'muerte'].includes(m.movement_type)
        ? '-'
        : '↔';
      const weight = m.avg_weight_kg ? ` (${m.avg_weight_kg}kg)` : '';
      const price = m.unit_price_ars
        ? ` — $${Number(m.unit_price_ars).toLocaleString('es-AR')}/cab`
        : m.unit_price_usd
        ? ` — US$${Number(m.unit_price_usd).toLocaleString('es-AR')}/cab`
        : '';
      const reason = m.reason ? ` — ${m.reason}` : '';
      const notes = m.notes ? ` | ${m.notes}` : '';
      return `  ${mv.emoji} ${date}: ${sign}${m.count}${weight}${price}${reason}${notes}`;
    });

    const breed = group.breed ? ` ${group.breed}` : '';
    return {
      messages: [
        `🐄 *Historial ${LIVESTOCK_CATEGORY_LABEL[group.category]}${breed}*\n` +
        `  📍 ${fmtLoc(group)}\n` +
        `  📊 Stock actual: *${group.count}*\n\n` +
        lines.join('\n'),
      ],
    };
  }

  // --- FQR-3: aggregate livestock movements when no scope filter present ---
  private async aggregateLivestockMovements(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const params: unknown[] = [userId];
    const conds = ['lm.user_id = $1'];
    const labels: string[] = [];

    // Tipo de movimiento — el filtro que faltaba. Sin esto "cuándo nacieron"
    // devolvía ventas, muertes y entradas mezcladas.
    if (cmd.movementType) {
      conds.push(`lm.movement_type = $${params.length + 1}`);
      params.push(String(cmd.movementType));
      labels.push(MOVEMENT_FILTER_LABEL[String(cmd.movementType)] ?? String(cmd.movementType));
    }
    // Categoría y ubicación: se miran los DOS grupos (origen y destino) porque
    // una transferencia sale de uno y entra al otro.
    if (cmd.category) {
      conds.push(`COALESCE(sg.category::text, dg.category::text) = $${params.length + 1}`);
      params.push(String(cmd.category));
      labels.push(String(cmd.category));
    }
    if (cmd.plotName) {
      conds.push(`LOWER(COALESCE(sp.name, dp.name)) = LOWER($${params.length + 1})`);
      params.push(String(cmd.plotName));
      labels.push(`lote ${cmd.plotName}`);
    }
    if (cmd.fieldName) {
      conds.push(`LOWER(COALESCE(sf.name, df.name)) = LOWER($${params.length + 1})`);
      params.push(String(cmd.fieldName));
      labels.push(`campo ${cmd.fieldName}`);
    }
    // Período calendario (query-period.ts, la misma fuente que el resto).
    let periodRange: { desde: string; hasta: string; label: string } | null = null;
    if (!cmd.desde && !cmd.hasta && cmd.period && cmd.period !== 'all') {
      const { resolvePeriodRange } = await import('../../utils/query-period.js');
      periodRange = resolvePeriodRange(String(cmd.period));
    }
    const desde = (cmd.desde as string) ?? periodRange?.desde;
    const hasta = (cmd.hasta as string) ?? periodRange?.hasta;
    if (desde) { conds.push(`lm.movement_date >= $${params.length + 1}::date`); params.push(desde); }
    if (hasta) { conds.push(`lm.movement_date <= $${params.length + 1}::date`); params.push(hasta); }

    const view = String(cmd.view ?? 'detail');
    const limit = view === 'last'
      ? Math.max(1, Math.min(10, Number(cmd.topN ?? 1)))
      : Math.max(1, Math.min(100, Number(cmd.topN ?? 30)));

    const result = await pool.query(
      `SELECT lm.movement_type, lm.count, lm.movement_date,
              COALESCE(sg.category, dg.category) AS category,
              COALESCE(sg.breed, dg.breed) AS breed,
              COALESCE(sp.name, dp.name) AS plot_name,
              COALESCE(sf.name, df.name) AS field_name,
              lm.unit_price_ars, lm.unit_price_usd, lm.reason
       FROM livestock_movements lm
       LEFT JOIN livestock_groups sg ON lm.source_group_id = sg.id
       LEFT JOIN plots sp ON sg.plot_id = sp.id
       LEFT JOIN fields sf ON sp.field_id = sf.id
       LEFT JOIN livestock_groups dg ON lm.dest_group_id = dg.id
       LEFT JOIN plots dp ON dg.plot_id = dp.id
       LEFT JOIN fields df ON dp.field_id = df.id
       WHERE ${conds.join(' AND ')}
       ORDER BY lm.movement_date DESC, lm.created_at DESC
       LIMIT ${limit}`,
      params,
    );
    const rows = result.rows;
    const period = periodRange?.label
      ?? (cmd.desde || cmd.hasta ? `${cmd.desde || '...'} — ${cmd.hasta || 'hoy'}` : 'todo el historial');
    const scope = labels.length ? ` — ${labels.join(', ')}` : '';

    await this.persistLivestockHistoryQuery(cmd, userId);

    if (rows.length === 0) {
      return { messages: [`🐄 No encontré movimientos de hacienda${scope} (${period}).`] };
    }

    // view='last': la pregunta es CUÁNDO, así que la respuesta es la fecha, no
    // un listado. Es lo que destraba "cuándo nacieron" / "cuándo los moví".
    if (view === 'last') {
      const lines = rows.map(r => {
        const d = formatDateAR(r.movement_date);
        const loc = r.plot_name ? ` en ${formatPlotLocation(r.field_name, r.plot_name)}` : '';
        const mv = MOVEMENT_FILTER_LABEL[String(r.movement_type)] ?? String(r.movement_type);
        return `  📅 *${d}* — ${mv}: ${r.count} ${r.category || 'hacienda'}${loc}`;
      });
      const titulo = rows.length === 1 ? 'Último movimiento' : `Últimos ${rows.length} movimientos`;
      const dias = Math.floor((Date.now() - new Date(rows[0].movement_date).getTime()) / 86400000);
      const hace = dias === 0 ? '\n\n⏱️ Fue hoy' : `\n\n⏱️ Hace ${dias} día${dias === 1 ? '' : 's'}`;
      return { messages: [`🐄 *${titulo}${scope}*\n${lines.join('\n')}${hace}`] };
    }
    // Aggregate counts by type
    const totals: Record<string, number> = {};
    for (const r of rows) {
      const type = String(r.movement_type);
      totals[type] = (totals[type] || 0) + Number(r.count);
    }
    const typeLabels: Record<string, string> = {
      entrada: '➕ Entradas', salida: '➖ Ventas/salidas', muerte: '💀 Muertes',
      nacimiento: '🐣 Nacimientos', transferencia: '↔️ Transferencias',
      recategorizacion: '🔄 Recategorizaciones', ajuste: '⚙️ Ajustes',
    };
    const summary = Object.entries(totals)
      .map(([t, n]) => `  • ${typeLabels[t] || t}: *${n}*`)
      .join('\n');
    const recent = rows.slice(0, 10).map(r => {
      const d = formatDateAR(r.movement_date);
      const sign = ['entrada', 'nacimiento'].includes(r.movement_type) ? '+' : ['salida', 'muerte'].includes(r.movement_type) ? '-' : '↔';
      const loc = r.plot_name ? ` (${formatPlotLocation(r.field_name, r.plot_name)})` : '';
      const cat = r.category || 'hacienda';
      const price = r.unit_price_usd ? ` · US$${Number(r.unit_price_usd).toLocaleString('es-AR')}/cab`
        : r.unit_price_ars ? ` · $${Number(r.unit_price_ars).toLocaleString('es-AR')}/cab` : '';
      const reason = r.reason ? ` · ${r.reason}` : '';
      return `  ${d}: ${sign}${r.count} ${cat}${loc}${price}${reason}`;
    });
    const more = rows.length > 10 ? `\n_…y ${rows.length - 10} más._` : '';
    // view='aggregate': sólo los totales, sin el listado.
    if (view === 'aggregate') {
      return { messages: [`🐄 *Movimientos de hacienda${scope}* (${period})\n\n*Totales:*\n${summary}`] };
    }
    return {
      messages: [
        `🐄 *Movimientos de hacienda${scope}* (${period})\n\n*Totales:*\n${summary}\n\n*Últimos:*\n${recent.join('\n')}${more}`,
      ],
    };
  }

  /** Guarda los filtros para que el próximo turno pueda refinar con inherit. */
  private async persistLivestockHistoryQuery(cmd: ParsedCommand, userId: UserId): Promise<void> {
    const KEEP = ['category', 'breed', 'fieldName', 'plotName', 'corralName',
      'movementType', 'period', 'desde', 'hasta', 'view', 'topN'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    try {
      const { pool } = await import('../../config/db.js');
      await pool.query(
        `INSERT INTO conversation_state (user_id, last_livestock_history_query, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_livestock_history_query = $2::jsonb, updated_at = NOW()`,
        [userId, JSON.stringify(persistable)],
      );
    } catch { /* no fatal: la consulta ya se respondió */ }
  }

  // --- Unified inventory query (groups + view dispatch) ---
  private async handleQueryInventory(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const renderers = await import('./livestock-renderers.js');

    // ── 1. Multi-turn inherit (exclude transient flags) ──
    const TRANSIENT_KEYS = new Set(['view', 'top_n', 'compareCategory', 'compareField', 'compareCorral']);
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_livestock_query, updated_at FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_livestock_query;
        const { isFreshMultiTurnEntry } = await import('../../middleware/multi-turn-state.js');
        if (prev && typeof prev === 'object' && isFreshMultiTurnEntry(rows[0]?.updated_at)) {
          for (const [k, v] of Object.entries(prev)) {
            if (TRANSIENT_KEYS.has(k)) continue;
            if (cmd[k] == null) cmd[k] = v as never;
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── 2. Query base groups (uses existing listInventory for plot/field/corral resolution) ──
    let baseGroups: import('./livestock-renderers.js').LivestockGroupRow[] = [];
    try {
      const r = await this.service.listInventory(userId, {
        fieldName: cmd.fieldName as string,
        plotName: cmd.plotName as string,
        corralName: cmd.corralName as string,
        category: cmd.category as string,
      });
      baseGroups = r.groups as unknown as import('./livestock-renderers.js').LivestockGroupRow[];
    } catch { /* swallow not-found */ }

    // ── 3. Apply in-memory filters not supported by listInventory ──
    const applyFilters = (rows: import('./livestock-renderers.js').LivestockGroupRow[]): import('./livestock-renderers.js').LivestockGroupRow[] => {
      let out = rows.filter(r => r.count > 0);
      if (cmd.inFeedlot === true) out = out.filter(r => r.corral_name != null);
      if (cmd.inFeedlot === false) out = out.filter(r => r.corral_name == null);
      if (cmd.breed) {
        const needle = String(cmd.breed).toLowerCase();
        out = out.filter(r => (r.breed || '').toLowerCase().includes(needle));
      }
      if (cmd.weightMinKg != null) out = out.filter(r => (r.avg_weight_kg || 0) >= Number(cmd.weightMinKg));
      if (cmd.weightMaxKg != null) out = out.filter(r => (r.avg_weight_kg || 0) <= Number(cmd.weightMaxKg));
      if (cmd.countMin != null) out = out.filter(r => r.count >= Number(cmd.countMin));
      if (cmd.countMax != null) out = out.filter(r => r.count <= Number(cmd.countMax));
      return out;
    };
    const rows = applyFilters(baseGroups);

    // ── 4. Persist for multi-turn ──
    void this.saveLivestockQuery(userId, cmd).catch(() => {});

    // ── 5. Scope label ──
    const scopeBits: string[] = [];
    if (cmd.fieldName) scopeBits.push(`campo ${cmd.fieldName}`);
    if (cmd.plotName) scopeBits.push(`lote ${cmd.plotName}`);
    if (cmd.corralName) scopeBits.push(`corral ${cmd.corralName}`);
    if (cmd.category) scopeBits.push(String(cmd.category));
    if (cmd.breed) scopeBits.push(String(cmd.breed));
    if (cmd.inFeedlot === true) scopeBits.push('feedlot');
    if (cmd.inFeedlot === false) scopeBits.push('a campo');
    if (cmd.weightMinKg != null) scopeBits.push(`peso ≥${cmd.weightMinKg}kg`);
    if (cmd.weightMaxKg != null) scopeBits.push(`peso ≤${cmd.weightMaxKg}kg`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: import('./livestock-renderers.js').LivestockRenderCtx = {
      scope,
      filters: {
        fieldName: cmd.fieldName as string | null,
        plotName: cmd.plotName as string | null,
        corralName: cmd.corralName as string | null,
        category: cmd.category as string | null,
        breed: cmd.breed as string | null,
        inFeedlot: cmd.inFeedlot as boolean | null,
        aggregateMetric: cmd.aggregateMetric as string | null,
        groupBy: cmd.group_by as string | null,
        sortDesc: cmd.sort_desc != null ? !!cmd.sort_desc : true,
      },
    };

    const view = (cmd.view as string)
      || (cmd.compareCategory || cmd.compareField || cmd.compareCorral ? 'compare'
        : cmd.group_by ? 'top_locations'
        : 'detail');

    // ── 6. Compare ──
    if (view === 'compare') {
      let rowsB = baseGroups;
      if (cmd.compareCategory) {
        try {
          const r = await this.service.listInventory(userId, {
            fieldName: cmd.fieldName as string,
            plotName: cmd.plotName as string,
            corralName: cmd.corralName as string,
            category: cmd.compareCategory as string,
          });
          rowsB = r.groups as unknown as import('./livestock-renderers.js').LivestockGroupRow[];
        } catch { rowsB = []; }
      } else if (cmd.compareField) {
        try {
          const r = await this.service.listInventory(userId, {
            fieldName: cmd.compareField as string,
            category: cmd.category as string,
          });
          rowsB = r.groups as unknown as import('./livestock-renderers.js').LivestockGroupRow[];
        } catch { rowsB = []; }
      } else if (cmd.compareCorral) {
        try {
          const r = await this.service.listInventory(userId, {
            corralName: cmd.compareCorral as string,
            category: cmd.category as string,
          });
          rowsB = r.groups as unknown as import('./livestock-renderers.js').LivestockGroupRow[];
        } catch { rowsB = []; }
      }
      const labelA = (cmd.category as string) || (cmd.fieldName as string) || (cmd.corralName as string) || 'A';
      const labelB = (cmd.compareCategory as string) || (cmd.compareField as string) || (cmd.compareCorral as string) || 'B';
      return renderers.renderLivestockCompare(applyFilters(rows), applyFilters(rowsB), labelA, labelB);
    }

    // ── 7. Empty ──
    if (rows.length === 0) {
      const all = baseGroups.length > 0 ? baseGroups : (await this.service.listInventory(userId, {})).groups as unknown as import('./livestock-renderers.js').LivestockGroupRow[];
      const cats = new Set<string>(); const flds = new Set<string>(); const corrs = new Set<string>();
      for (const r of all) { cats.add(r.category); if (r.field_name) flds.add(r.field_name); if (r.corral_name) corrs.add(r.corral_name); }
      return renderers.renderEmpty(ctx, { categories: [...cats], fields: [...flds], corrals: [...corrs] });
    }

    // ── 8. Dispatch ──
    switch (view) {
      case 'aggregate': return renderers.renderLivestockAggregate(rows, ctx);
      case 'max': return renderers.renderLivestockExtreme(rows, ctx, 'max');
      case 'min': return renderers.renderLivestockExtreme(rows, ctx, 'min');
      case 'avg': return renderers.renderLivestockAvg(rows, ctx);
      case 'rank': return renderers.renderLivestockRank(rows, ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderLivestockTopLocations(rows, ctx);
      case 'detail':
      default: return renderers.renderLivestockDetail(rows, ctx);
    }
  }

  private async saveLivestockQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'plotName', 'corralName', 'category', 'breed', 'inFeedlot',
      'weightMinKg', 'weightMaxKg', 'countMin', 'countMax',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_livestock_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_livestock_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }
}

/** Category coercion helper — exported for tests */
export function coerceCategory(raw: unknown): LivestockCategory | null {
  if (typeof raw !== 'string') return null;
  return LivestockService.normalizeCategory(raw);
}
