import fs from 'fs';
import { AgronomyRepository, RAINFALL_REJECTED_DUPLICATE } from './agronomy.repository.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { CropService, detectCropFromText, formatSeasonLabel, getSeasonTypeForCrop, getCampaignStateLabel, getCampaignState } from '../plots/crop.service.js';
import { CampaignStatsService } from './campaign-stats.service.js';
import type { CampaignStats, CampaignComparison } from './campaign-stats.service.js';
import { FeedlotService } from '../feedlot/feedlot.service.js';
import { inferCrop, getActivityLabel, formatActivityConfirmation } from './activity.service.js';
import {
  getCurrentWeather,
  getForecast,
  formatCurrentWeather,
  formatForecast,
  checkRainAlert,
} from '../../services/weather.js';
import { generateWeeklyReport } from '../../services/agro-report.js';
import { saveObservation, SAVE_REJECTED_FINANCIAL, SAVE_REJECTED_DUPLICATE, SAVE_REJECTED_NO_PLOT, detectObservationCategory, getCurrentWeekObservations, getCurrentWeekObservationsByPlot, getObservationsByDateRange, getObservationsByDateRangeAndPlot, deduplicateObservations } from '../../services/observations.js';
import { formatObservationResponse, formatAgroReportResponse } from '../../middleware/response-formatter.js';
import { logError } from '../../services/error-logger.js';
import { isDuplicate, recordAlert, recordDeduped } from '../../services/alert.service.js';
import { formatHistoryResponse } from './plot-query.service.js';
import { formatDateAR } from '../../utils/date.js';
import { formatQuantityHuman } from '../../utils/format-quantity.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { isPlaceholder } from '../../utils/guards.js';
import { validateStageCode } from './stage-code-validator.js';
import type { UserId, User, ParsedCommand, UserSettings, HandlerResponse, ActivityType, PlotDiscoveryResult } from '../../types/index.js';
import type { PendingActivity } from '../../middleware/pending-activities.js';
import { formatPlotListGrouped } from '../../middleware/flows/field-step-helpers.js';

// --- AI intent → DB event_type normalization ---
const ACTIVITY_FILTER_MAP: Record<string, string> = {
  sow_crop: 'planting',
  harvest_crop: 'harvest',
};

function normalizeActivityFilter(raw: string | null): string | null {
  if (!raw) return null;
  const stripped = raw.replace(/^log_/, '');
  return ACTIVITY_FILTER_MAP[stripped] ?? ACTIVITY_FILTER_MAP[raw] ?? stripped;
}

/**
 * Resolve a weather query to a concrete city name using localidadLookup.
 * Returns { city } when unambiguous, { clarify } when the user needs to specify a province.
 * Falls back to user.city when no explicit city was provided.
 */
function resolveWeatherCity(
  cmd: ParsedCommand,
  user: User,
): { city: string | null; clarify?: string } {
  const rawCity = typeof cmd.city === 'string' ? cmd.city.trim() : '';
  if (!rawCity) return { city: user.city ?? null };

  const province = typeof cmd.province === 'string' ? cmd.province.trim() : '';
  const input = province ? `${rawCity}, ${province}` : rawCity;
  const result = localidadLookup.lookup(input);

  if (result.status === 'exact') {
    return { city: result.matches[0].nombre };
  }
  if (result.status === 'disambiguate') {
    const options = result.matches.slice(0, 6).map(m => `• ${m.nombre}, ${m.provincia}`).join('\n');
    return {
      city: null,
      clarify:
        `🤔 Hay varias localidades con ese nombre:\n${options}\n\n` +
        `Decime otra vez aclarando la provincia, ej: *clima en ${result.matches[0].nombre} ${result.matches[0].provincia}*`,
    };
  }
  if (result.status === 'suggestions' && result.matches.length > 0) {
    const options = result.matches.slice(0, 4).map(m => `• ${m.nombre}, ${m.provincia}`).join('\n');
    return {
      city: null,
      clarify: `🤔 No encontré "${rawCity}" exacto. ¿Querías decir?\n${options}`,
    };
  }
  // not_found → try OpenWeather with the raw name anyway (it's tolerant)
  return { city: rawCity };
}

// --- Observation safety guard ---
// Prevents accidental persistence of questions/follow-ups as observations.

const QUESTION_STARTS = /^(?:que|qué|cuando|cuándo|donde|dónde|como|cómo|cual|cuál|cuanto|cuánto|por\s+que|por\s+qué|quien|quién)/i;
const FOLLOWUP_STARTS = /^(?:y\s|del\s|eso|ese|esa|ah[ií])/i;
// Analytical/query keywords — when present anywhere, the message is a QUERY, never an observation.
// Catches things like "Evolución del lote A1", "Promedio de cobertura", "Relacioná humedad con plagas",
// "Cantidad de monitoreos", "Resumen sanitario", "Comparar A1 vs B1", "Buscar 'orug'".
const ANALYTICAL_KEYWORDS = /\b(evoluci[oó]n|promedio|m[aá]ximo|m[aá]xima|m[ií]nimo|m[ií]nima|cantidad\b|porcentaje|relacion[aá]r?|comparar?|compar[aá]|ranking|estad[ií]stica|resumen|total\s+de|aumentando|disminuyendo|tendencia|histor[ií]al)\b/i;
// Imperative query verbs at start ("mostrame", "ver", "filtrá") — the user is asking, not registering.
const QUERY_VERB_STARTS = /^(?:mostr[aá]r?(?:me)?|ver\s|listar?(?:me)?|filtr[aá]r?(?:me)?|filtrar|buscar?(?:me)?|busc[aá](?:me)?|cont[aá](?:me)?|sum[aá](?:me)?|sac[aá](?:me)?|dame|traem?e)/i;
// Argentine agronomic terms — when present, the message is treated as an
// observation even if it's very short (e.g. "rama negra" is a known weed,
// "vaquita" is a known pest). Without this bypass the wordCount<=2 guard
// would block legitimate observations after the agent strips the verb
// (e.g. "vi rama negra" → agent sends observation="rama negra").
const STRONG_OBS_SIGNALS = /(?:observaci[oó]n|hay\s|se\s+detect|se\s+observ|presencia\s+de|se\s+ve|plaga|maleza|hongo|roya|helada|granizo|chinche|oruga|gramilla|amarill|seco|seca|sequ[ií]a|encharcam|mancha|yuyo|cardo|isoca|pulgon|pulg[oó]n|trips|bicho|clorosis|deficiencia|carencia|rama\s+negra|rama|alepo|cap[ií]n|gram[oó]n|gorgojo|vaquita|diabrotica|ara[nñ]uela|mosca\s+blanca|chicharrita|taladro|tiz[oó]n|septoria|fusarium|bacteriosis|virosis|nabo|mostaza|amaranthus|cebadilla|broca|alquiche|gata\s+peluda|nematod[oa]|esclerotinia|antracnosis|carb[oó]n)/i;

// Livestock guard: if the text looks like a livestock operation
// (category + quantity), reject as observation — the agent should have
// classified this as a livestock tool instead
const LIVESTOCK_CATEGORY_WORDS = /\b(?:vacas?|vaquillonas?|vaquillas?|terneros?|terneras?|novillos?|novillitos?|toros?|toritos?|bueyes?|hacienda|ganado)\b/i;
const LIVESTOCK_VERB_HINTS = /\b(?:agregar|agregu[eé]|a[nñ]adir|a[nñ]ad[ií]|meter|met[ií]|cargar|cargu[eé]|sumar|sum[eé]|entrar|entraron|vender|vend[ií]|sacar|saqu[eé]|salieron|mover|mov[eé]|pasar|pas[eé]|transferir|transfer[ií]|morir|muri[oó]|murieron|nacer|naci[oó]|nacieron|parir|parieron)\b/i;

function isLikelyLivestockMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!LIVESTOCK_CATEGORY_WORDS.test(trimmed)) return false;
  // Has a numeric quantity (e.g. "20 vacas") OR a livestock verb hint
  const hasNumber = /\d/.test(trimmed);
  return hasNumber || LIVESTOCK_VERB_HINTS.test(trimmed);
}

function isLikelyQuestionOrFollowUp(text: string, prefixDetected?: boolean): boolean {
  // If observation prefix was explicitly detected, NEVER block
  if (prefixDetected) return false;

  const trimmed = text.trim();

  // Question marks → ALWAYS block
  if (trimmed.includes('?') || trimmed.includes('¿')) return true;

  // Analytical/statistical keywords or imperative query verbs → ALWAYS block
  // (Catches "Evolución del lote A1", "Promedio de X", "Mostrame Y", "Filtrá Z" — these are
  // queries about scoutings, not new observations to persist.)
  if (ANALYTICAL_KEYWORDS.test(trimmed)) return true;
  if (QUERY_VERB_STARTS.test(trimmed)) return true;

  // Livestock messages are never observations — block
  if (isLikelyLivestockMessage(trimmed)) return true;

  // Strong observation signals → allow persistence (even short messages)
  if (STRONG_OBS_SIGNALS.test(trimmed)) return false;

  // Very short messages (2 words or fewer) without agro signals → block
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 2) return true;

  // Starts with question words
  if (QUESTION_STARTS.test(trimmed)) return true;

  // Starts with follow-up connectors
  if (FOLLOWUP_STARTS.test(trimmed)) return true;

  return false;
}

export class AgronomyHandler {
  private plotDiscovery = new PlotDiscoveryService();
  private cropService = new CropService();
  private campaignStatsService = new CampaignStatsService();

  constructor(private repo: AgronomyRepository) {}

  /**
   * Hybrid plot resolution: resolve → auto-assign single → ask user for multiple → block if none.
   */
  private async resolveActivityPlot(
    userId: UserId,
    resolved: PlotDiscoveryResult,
  ): Promise<
    | { type: 'resolved'; plotId: number; fieldId: number | null; plotName: string | null; fieldName: string | null }
    | { type: 'no_plots' }
    | { type: 'ask_user'; plots: Array<{ id: number; name: string; field_name: string }> }
  > {
    if (resolved.plotId) {
      return { type: 'resolved', plotId: resolved.plotId, fieldId: resolved.fieldId, plotName: resolved.plotName, fieldName: resolved.fieldName };
    }

    const userPlots = await this.repo.findAllUserPlots(userId);

    if (userPlots.length === 0) {
      return { type: 'no_plots' };
    }

    if (userPlots.length === 1) {
      const p = userPlots[0];
      const field = await this.repo.getFieldByName(userId, p.field_name);
      return {
        type: 'resolved',
        plotId: p.id,
        fieldId: field?.id ?? null,
        plotName: p.name,
        fieldName: p.field_name,
      };
    }

    return { type: 'ask_user', plots: userPlots };
  }

  /**
   * Tailored response for "you tried to log activity X but have no plots".
   * Distinguishes between (a) no fields at all (the original case), (b) one
   * field already created, and (c) multiple fields. When the user mentioned
   * hectares in the same message, surface them in the suggested command.
   */
  private async buildNoPlotsResponse(
    userId: UserId,
    activityLabel: string,
    cmd: ParsedCommand,
  ): Promise<HandlerResponse> {
    const fields = await this.repo.getUserFields(userId);
    const haNum = cmd.hectares != null ? Number(cmd.hectares) : null;
    const haHint = haNum && haNum > 0 ? ` de ${haNum} ha` : '';

    if (fields.length === 0) {
      return {
        messages: [`Para registrar ${activityLabel} primero necesitás crear un campo y un lote.\n\n📍 Escribí *agregar campo [nombre]*`],
        interactive: {
          type: 'buttons',
          body: `Necesitás un campo para registrar ${activityLabel}.`,
          buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
        },
      };
    }

    if (fields.length === 1) {
      const f = fields[0];
      return {
        messages: [
          `El campo *${f.name}* todavía no tiene lotes cargados.\n\n` +
          `Creá uno con:\n📍 *agregar lote [nombre] en campo ${f.name}${haHint}*\n\n` +
          `Después reintentá la ${activityLabel}.`,
        ],
      };
    }

    const someFields = fields.slice(0, 3).map(f => `*${f.name}*`).join(', ');
    const more = fields.length > 3 ? '…' : '';
    return {
      messages: [
        `Tus campos (${someFields}${more}) todavía no tienen lotes cargados.\n\n` +
        `Creá uno con:\n📍 *agregar lote [nombre] en campo [cuál]${haHint}*\n\n` +
        `Después reintentá la ${activityLabel}.`,
      ],
    };
  }

  /**
   * Build "which plot?" response for activity pending pattern.
   */
  private buildAskPlotResponse(
    activityLabel: string,
    plots: Array<{ id: number; name: string; field_name: string }>,
    cmd: ParsedCommand,
  ): HandlerResponse {
    return {
      messages: [`¿En qué lote?\n\n${formatPlotListGrouped(plots)}`],
      suggestionKey: 'default_menu',
      sideEffects: {
        setPendingActivity: { command: cmd.command, data: { ...cmd } },
      },
    };
  }

  /**
   * Resolve a pending activity after the user specifies a plot.
   * Called by controllers when user answers the "which plot?" prompt.
   */
  async savePendingActivity(
    userId: UserId,
    pending: PendingActivity,
    plotId: number,
    fieldId: number | null,
    plotName: string | null,
    fieldName: string | null,
  ): Promise<HandlerResponse> {
    const plotLabel = fieldName ? `${fieldName} > ${plotName}` : plotName;
    const cmd = pending.data;

    const EVENT_TYPE_MAP: Record<string, ActivityType> = {
      log_spraying: 'spraying',
      log_fertilization: 'fertilization',
      log_tillage: 'tillage',
      log_irrigation: 'irrigation',
      sow_crop: 'planting',
      harvest_crop: 'harvest',
      log_tacto: 'tacto',
    };

    if (pending.command === 'sow_crop') {
      const crop = cmd.crop as string;
      if (isPlaceholder(crop)) {
        return { messages: ['🌱 ¿Qué cultivo sembraste? (ej: soja, maíz, trigo, girasol)'] };
      }
      const sowedHa = cmd.hectares != null ? Number(cmd.hectares) : null;
      const { cropRow, closedPrevious } = await this.cropService.startCrop(userId, plotId, crop, undefined, sowedHa);
      const label = formatSeasonLabel(cropRow.season_year, cropRow.season_type);

      await this.repo.saveDomainEvent(userId, {
        plotId,
        plotCropId: cropRow.id,
        eventType: 'planting',
        eventDate: cmd.eventDate as Date | null,
        crop,
      });

      const msgs: string[] = [];
      if (closedPrevious) {
        msgs.push(`📋 Se cerró la campaña anterior de *${closedPrevious.crop}* en ${plotLabel}.`);
      }
      let sowMsg = `🌱 *${crop}* sembrado en *${plotLabel}*\n📅 Campaña ${label}`;
      if (sowedHa) sowMsg += `\n📐 Sembradas: ${sowedHa.toLocaleString('es-AR')} ha`;
      msgs.push(sowMsg);
      return { messages: msgs };
    }

    if (pending.command === 'harvest_crop') {
      const crop = cmd.crop as string;
      if (isPlaceholder(crop)) {
        return { messages: ['🌾 ¿Qué cultivo cosechaste? (ej: soja, maíz, trigo, girasol)'] };
      }
      const yieldKg = cmd.yieldKg != null ? Number(cmd.yieldKg) : null;
      const yieldNotes = (cmd.yieldNotes as string) || null;
      const harvested = await this.cropService.harvestCrop(plotId, crop, cmd.eventDate as Date | undefined, yieldKg, yieldNotes);

      if (!harvested) {
        const active = await this.cropService.getActive(plotId);
        if (active) {
          return { messages: [`En *${plotLabel}* hay *${active.crop}* sembrado, no ${crop}.\nSi querés cosechar ${active.crop}, escribí:\n🌾 *cosechamos ${active.crop.toLowerCase()} en el lote ${plotName}*`] };
        }
        return { messages: [`No hay cultivo activo en *${plotLabel}* para cosechar.`] };
      }

      await this.repo.saveDomainEvent(userId, {
        plotId,
        plotCropId: harvested.id,
        eventType: 'harvest',
        eventDate: cmd.eventDate as Date | null,
        crop,
      });

      const label = formatSeasonLabel(harvested.season_year, harvested.season_type);
      let msg = `🌾 *${crop}* cosechado en *${plotLabel}*\n📅 Campaña ${label}`;
      msg += `\n\nLa campaña sigue abierta. Cuando quieras cerrarla, decime "cerrar campaña".`;
      return { messages: [msg] };
    }

    if (pending.command === 'log_tacto') {
      let pregnantCount = typeof cmd.pregnantCount === 'number' ? cmd.pregnantCount : null;
      let openCount = typeof cmd.openCount === 'number' ? cmd.openCount : null;
      let uncertainCount = typeof cmd.uncertainCount === 'number' ? cmd.uncertainCount : null;
      let totalChecked = typeof cmd.totalChecked === 'number' ? cmd.totalChecked : null;
      if (totalChecked == null && pregnantCount != null) {
        totalChecked = (pregnantCount || 0) + (openCount || 0) + (uncertainCount || 0);
      }
      if (openCount == null && totalChecked != null && pregnantCount != null) {
        openCount = totalChecked - pregnantCount - (uncertainCount || 0);
        if (openCount < 0) openCount = 0;
      }
      const category = typeof cmd.category === 'string' ? cmd.category : null;
      await this.repo.saveDomainEvent(userId, {
        plotId,
        eventType: 'tacto',
        eventDate: cmd.eventDate as Date | null,
        quantity: totalChecked,
        product: category,
        implement: cmd.implement as string | null,
        notes: cmd.notes as string | null,
        pregnantCount,
        openCount,
        uncertainCount,
      });
      const lines: string[] = ['🩺 *Tacto* registrado'];
      lines.push(`📍 ${plotLabel}`);
      if (totalChecked != null) {
        const catLabel = category ? ` ${category}s` : '';
        lines.push(`🐄 ${totalChecked}${catLabel} revisadas`);
      }
      if (pregnantCount != null) lines.push(`✅ Preñadas: *${pregnantCount}*`);
      if (openCount != null && openCount > 0) lines.push(`❌ Vacías: *${openCount}*`);
      if (uncertainCount != null && uncertainCount > 0) lines.push(`❓ Dudosas: *${uncertainCount}*`);
      if (pregnantCount != null && totalChecked != null && totalChecked > 0) {
        const rate = Math.round((pregnantCount / totalChecked) * 100);
        lines.push(`📊 Tasa de preñez: *${rate}%*`);
      }
      if (cmd.implement) lines.push(`👨‍⚕️ Veterinario: ${cmd.implement}`);
      return { messages: [lines.join('\n')] };
    }

    // log_crop_scouting — save scouting with the resolved plot
    if (pending.command === 'log_crop_scouting') {
      const stageCode = cmd.stageCode ? String(cmd.stageCode).toUpperCase() : null;
      const weedSpecies = Array.isArray(cmd.weedSpecies) ? cmd.weedSpecies as string[] : null;
      const activeCropForScouting = await this.cropService.getActive(plotId);

      const { saveCropScouting } = await import('../../services/expenses.js');
      const saved = await saveCropScouting(userId, {
        fieldId: fieldId ?? undefined,
        plotId,
        plotCropId: activeCropForScouting?.id ?? null,
        scoutingDate: cmd.eventDate as string | undefined,
        stageCode,
        weedCoveragePct: cmd.weedCoveragePct as number | undefined,
        weedSpecies,
        pestSpecies: cmd.pestSpecies as string | undefined,
        pestSeverity: cmd.pestSeverity as number | undefined,
        pestAffectedPct: cmd.pestAffectedPct as number | undefined,
        soilMoisture: cmd.soilMoisture as number | undefined,
        emergencePct: cmd.emergencePct as number | undefined,
        plantDensityM2: cmd.plantDensityM2 as number | undefined,
        notes: cmd.notes as string | undefined,
      });

      const lines: string[] = [];
      lines.push(`🔍 *Monitoreo registrado* en *${plotLabel}*`);
      if (saved.stage_code) lines.push(`  📐 Estadio: *${saved.stage_code}*`);
      if (saved.weed_coverage_pct != null) {
        const sp = weedSpecies && weedSpecies.length ? ` (${weedSpecies.join(', ')})` : '';
        lines.push(`  🌿 Malezas: ${saved.weed_coverage_pct}%${sp}`);
      } else if (weedSpecies && weedSpecies.length) {
        lines.push(`  🌿 Malezas: ${weedSpecies.join(', ')}`);
      }
      if (saved.pest_species) {
        const sevLabels = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
        const sevLbl = saved.pest_severity_1_5 ? ` (${sevLabels[saved.pest_severity_1_5]} ${saved.pest_severity_1_5}/5)` : '';
        const aff = saved.pest_affected_pct != null ? `, ${saved.pest_affected_pct}% afectado` : '';
        lines.push(`  🐛 Plaga: ${saved.pest_species}${sevLbl}${aff}`);
      }
      return { messages: [lines.join('\n')] };
    }

    // log_spraying / log_fertilization / log_tillage / log_irrigation
    const eventType = EVENT_TYPE_MAP[pending.command];
    if (!eventType) {
      return { messages: ['No pude procesar esa actividad. Intentá de nuevo.'] };
    }

    const activeCrop = await this.cropService.getActive(plotId);
    const crop = inferCrop(
      cmd.crop as string | null,
      activeCrop,
      cmd.product as string | null,
    );

    await this.repo.saveDomainEvent(userId, {
      plotId,
      plotCropId: activeCrop?.id || null,
      eventType,
      eventDate: cmd.eventDate as Date | null,
      crop,
      product: cmd.product as string | null,
      productType: cmd.productType as string | null,
      quantity: cmd.quantity as number | null,
      unit: cmd.unit as string | null,
      implement: cmd.implement as string | null,
    });

    const confirmation = formatActivityConfirmation(eventType, plotLabel, {
      product: cmd.product as string | null,
      productType: cmd.productType as string | null,
      quantity: cmd.quantity as number | null,
      unit: cmd.unit as string | null,
      crop,
      implement: cmd.implement as string | null,
      eventDate: cmd.eventDate as Date | null,
    });

    return { messages: [confirmation] };
  }

  // --- Unified query_scoutings: filter + view dispatcher (same shape as financial_report) ---
  private async handleQueryScoutings(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const { queryScoutings } = await import('../../services/expenses.js');
    const renderers = await import('./scouting-renderers.js');

    // ── 1. Multi-turn: inherit prior scouting query when agent flags it ──
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_scouting_query FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_scouting_query;
        if (prev && typeof prev === 'object') {
          for (const [k, v] of Object.entries(prev)) if (cmd[k] == null) cmd[k] = v as never;
        }
      } catch { /* non-fatal */ }
    }

    // ── 2. Resolve scope (plot/field) ──
    const resolved = await this.plotDiscovery.resolveFromNames(userId, cmd.fieldName as string | null, cmd.plotName as string | null);

    // ── 3. Date range (similar to financial: analytical queries default to all-history) ──
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const nowAR = new Date();
    const currentMonthStart = `${nowAR.getFullYear()}-${String(nowAR.getMonth() + 1).padStart(2, '0')}-01`;
    const currentMonthLastDay = new Date(nowAR.getFullYear(), nowAR.getMonth() + 1, 0).toISOString().slice(0, 10);
    let desde = (cmd.desde as string) || null;
    let hasta = (cmd.hasta as string) || null;
    let rangeLabel = '';
    let isAll = false;

    // Heuristic: when the agent sends EXACTLY current-month boundaries AND no explicit cmd.period,
    // it's almost certainly defaulting (not user-explicit). With narrowing filters present, widening
    // to all-history avoids silently dropping data from other months (e.g. "estados V" should include
    // V2 from April, not just May).
    const hasNarrowingFilter = !!(cmd.stagePrefix || cmd.stageCode || cmd.pestSpeciesQuery
      || (cmd.weedSpeciesAny as string[] | undefined)?.length
      || cmd.hasPest != null || cmd.hasWeeds != null
      || cmd.weedMinPct != null || cmd.weedMaxPct != null
      || cmd.emergenceMinPct != null || cmd.emergenceMaxPct != null
      || cmd.densityMin != null || cmd.densityMax != null
      || cmd.soilMoistureMin != null || cmd.soilMoistureMax != null
      || cmd.pestSeverityMin != null);
    const agentDefaultedToCurrentMonth = desde === currentMonthStart
      && (hasta === todayISO || hasta === currentMonthLastDay)
      && !cmd.period;
    if (hasNarrowingFilter && agentDefaultedToCurrentMonth) {
      desde = null;
      hasta = null;
    }

    if (cmd.period === 'all' || (!desde && !hasta)) {
      desde = '2000-01-01';
      hasta = todayISO;
      isAll = true;
      rangeLabel = 'Todo el historial';
    } else if (cmd.period === 'month' && !desde && !hasta) {
      desde = currentMonthStart;
      hasta = todayISO;
      rangeLabel = nowAR.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    } else {
      rangeLabel = `${desde || '...'} — ${hasta || todayISO}`;
    }
    if (desde && hasta && desde > hasta) {
      return { messages: [`Rango inválido: ${desde} es posterior a ${hasta}.`] };
    }

    // ── 4. Build filters ──
    const aggregateMetric = (cmd.aggregateMetric as string) || null;
    // Default sort: when picking max/min/rank, sort by the chosen metric
    const sortBy = (cmd.sort_by as string) || (cmd.view === 'max' || cmd.view === 'min' || cmd.view === 'rank' ? (aggregateMetric || 'date') : 'date');
    const sortDescDefault = cmd.view === 'min' ? false : true;
    const sortDesc = cmd.sort_desc != null ? !!cmd.sort_desc : sortDescDefault;

    const queryOpts = {
      userId: Number(userId),
      plotId: resolved.plotId ?? null,
      fieldId: resolved.fieldId ?? null,
      dateFrom: desde,
      dateTo: hasta,
      stageCode: (cmd.stageCode as string) ?? null,
      stagePrefix: (cmd.stagePrefix as string) ?? null,
      pestSpecies: (cmd.pestSpeciesQuery as string) ?? null,
      pestSeverityMin: (cmd.pestSeverityMin as number) ?? (cmd.minSeverity as number) ?? null,
      hasPest: cmd.hasPest as boolean | null | undefined,
      weedSpeciesAny: (cmd.weedSpeciesAny as string[]) ?? null,
      weedMinPct: (cmd.weedMinPct as number) ?? null,
      weedMaxPct: (cmd.weedMaxPct as number) ?? null,
      hasWeeds: cmd.hasWeeds as boolean | null | undefined,
      emergenceMinPct: (cmd.emergenceMinPct as number) ?? null,
      emergenceMaxPct: (cmd.emergenceMaxPct as number) ?? null,
      densityMin: (cmd.densityMin as number) ?? null,
      densityMax: (cmd.densityMax as number) ?? null,
      soilMoistureMin: (cmd.soilMoistureMin as number) ?? null,
      soilMoistureMax: (cmd.soilMoistureMax as number) ?? null,
      sortBy,
      sortDesc,
      limit: 100,
    };

    // ── 5. Determine view ──
    const view = (cmd.view as string)
      || (cmd.comparePlot || cmd.compareField ? 'compare'
        : aggregateMetric ? 'rank'
        : 'detail');

    // ── 6. Fetch ──
    const rows = await queryScoutings(queryOpts);

    // ── 7. Persist last query for multi-turn inheritance ──
    void this.saveScoutingQuery(userId, cmd).catch(() => {});

    const scopeBits: string[] = [];
    if (resolved.plotName) scopeBits.push(`lote ${resolved.plotName}`);
    else if (resolved.fieldName) scopeBits.push(`campo ${resolved.fieldName}`);
    if (cmd.pestSpeciesQuery) scopeBits.push(cmd.pestSpeciesQuery as string);
    if (Array.isArray(cmd.weedSpeciesAny) && (cmd.weedSpeciesAny as string[]).length > 0) scopeBits.push((cmd.weedSpeciesAny as string[]).join('/'));
    if (cmd.stageCode) scopeBits.push(cmd.stageCode as string);
    else if (cmd.stagePrefix) scopeBits.push(`estados ${cmd.stagePrefix as string}`);
    if (cmd.hasPest === true) scopeBits.push('con plagas');
    // Collapse to "=N%" when min==max, OR when min is at the hard ceiling (100% can't be exceeded)
    const isExactWeedPct =
      (cmd.weedMinPct != null && cmd.weedMaxPct != null && cmd.weedMinPct === cmd.weedMaxPct)
      || (cmd.weedMinPct != null && cmd.weedMaxPct == null && Number(cmd.weedMinPct) >= 100)
      || (cmd.weedMaxPct != null && cmd.weedMinPct == null && Number(cmd.weedMaxPct) <= 0);
    if (isExactWeedPct) {
      const v = cmd.weedMinPct != null ? cmd.weedMinPct : cmd.weedMaxPct;
      scopeBits.push(`=${v}% malezas`);
    } else {
      if (cmd.weedMinPct != null) scopeBits.push(`>${cmd.weedMinPct}% malezas`);
      if (cmd.weedMaxPct != null) scopeBits.push(`<${cmd.weedMaxPct}% malezas`);
    }
    if (cmd.emergenceMinPct != null) scopeBits.push(`emerg ≥${cmd.emergenceMinPct}%`);
    if (cmd.emergenceMaxPct != null) scopeBits.push(`emerg ≤${cmd.emergenceMaxPct}%`);
    if (cmd.soilMoistureMax != null) scopeBits.push(`hum ≤${cmd.soilMoistureMax}/5`);
    if (cmd.soilMoistureMin != null) scopeBits.push(`hum ≥${cmd.soilMoistureMin}/5`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: renderers.ScoutingRenderCtx = {
      rangeLabel: isAll ? 'Todo el historial' : rangeLabel,
      scope,
      isAll,
      filters: {
        plotName: resolved.plotName,
        fieldName: resolved.fieldName,
        aggregateMetric,
        sortBy,
        sortDesc,
        weedSpeciesAny: cmd.weedSpeciesAny as string[] | null,
        pestSpecies: cmd.pestSpeciesQuery as string | null,
        stageCode: cmd.stageCode as string | null,
        stagePrefix: cmd.stagePrefix as string | null,
        hasPest: cmd.hasPest as boolean | null | undefined ?? null,
        hasWeeds: cmd.hasWeeds as boolean | null | undefined ?? null,
      },
    };

    // ── 8. Dispatch ──
    if (view === 'compare') {
      const optsB = { ...queryOpts };
      if (cmd.comparePlot) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, null, cmd.comparePlot as string);
        optsB.plotId = rB.plotId ?? null;
        optsB.fieldId = rB.fieldId ?? null;
      } else if (cmd.compareField) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, cmd.compareField as string, null);
        optsB.fieldId = rB.fieldId ?? null;
        optsB.plotId = null;
      }
      const rowsB = await queryScoutings(optsB);
      const labelA = resolved.plotName || resolved.fieldName || 'A';
      const labelB = (cmd.comparePlot as string) || (cmd.compareField as string) || 'B';
      return renderers.renderScoutingCompare(rows as renderers.ScoutingRow[], rowsB as renderers.ScoutingRow[], labelA, labelB);
    }

    // Empty: fetch available species/stages for a proactive hint
    if (rows.length === 0) {
      const hintsRes = await queryScoutings({ userId: Number(userId), dateFrom: '2000-01-01', dateTo: todayISO, limit: 100 });
      const weeds = new Set<string>();
      const pests = new Set<string>();
      const stages = new Set<string>();
      for (const r of hintsRes) {
        for (const w of (r.weed_species || [])) weeds.add(w);
        if (r.pest_species) pests.add(r.pest_species);
        if (r.stage_code) stages.add(r.stage_code);
      }
      return renderers.renderEmpty(ctx, { weeds: [...weeds], pests: [...pests], stages: [...stages] });
    }

    switch (view) {
      case 'aggregate': return renderers.renderScoutingAggregate(rows as renderers.ScoutingRow[], ctx);
      case 'max': return renderers.renderScoutingExtreme(rows as renderers.ScoutingRow[], ctx, 'max');
      case 'min': return renderers.renderScoutingExtreme(rows as renderers.ScoutingRow[], ctx, 'min');
      case 'avg': return renderers.renderScoutingAvg(rows as renderers.ScoutingRow[], ctx);
      case 'rank': return renderers.renderScoutingRank(rows as renderers.ScoutingRow[], ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderScoutingTopLocations(rows as renderers.ScoutingRow[], ctx, (cmd.group_by as 'plot' | 'field') === 'field' ? 'field' : 'plot');
      case 'detail':
      default: return renderers.renderScoutingDetail(rows as renderers.ScoutingRow[], ctx);
    }
  }

  // --- Unified query_plot_history (activities) dispatcher ---
  private async handleQueryActivities(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const { queryActivities } = await import('../../services/expenses.js');
    const renderers = await import('./activity-renderers.js');

    // ── 1. Multi-turn inherit (exclude transient flags) ──
    const TRANSIENT_KEYS = new Set(['view', 'top_n', 'compareCrop', 'comparePlot', 'compareField', 'compareActivityType']);
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_activity_query FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_activity_query;
        if (prev && typeof prev === 'object') {
          for (const [k, v] of Object.entries(prev)) {
            if (TRANSIENT_KEYS.has(k)) continue;
            if (cmd[k] == null) cmd[k] = v as never;
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── 2. Resolve scope ──
    const resolved = await this.plotDiscovery.resolveFromNames(userId, cmd.fieldName as string | null, cmd.plotName as string | null);

    // ── 3. Date range (analytical → all-history default) ──
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const nowAR = new Date();
    const currentMonthStart = `${nowAR.getFullYear()}-${String(nowAR.getMonth() + 1).padStart(2, '0')}-01`;
    let desde = (cmd.desde as string) || null;
    let hasta = (cmd.hasta as string) || null;
    let rangeLabel = '';
    let isAll = false;

    // Heuristic: agent default to current-month with narrowing filter → widen
    const hasNarrowing = !!(cmd.activityTypes || cmd.crop || cmd.productSearch || cmd.activityFilter
      || cmd.quantityMin != null || cmd.quantityMax != null);
    const agentDefaultedMonth = desde === currentMonthStart && (hasta === todayISO) && !cmd.period;
    if (hasNarrowing && agentDefaultedMonth) { desde = null; hasta = null; }

    if (cmd.period === 'all' || (!desde && !hasta)) {
      desde = '2000-01-01'; hasta = todayISO; isAll = true; rangeLabel = 'Todo el historial';
    } else {
      rangeLabel = `${desde || '...'} — ${hasta || todayISO}`;
    }
    if (desde && hasta && desde > hasta) {
      return { messages: [`Rango inválido: ${desde} es posterior a ${hasta}.`] };
    }

    // Map legacy activityFilter → activityTypes
    const legacyMap: Record<string, string> = {
      'log_spraying': 'spraying', 'log_fertilization': 'fertilization',
      'sow_crop': 'planting', 'harvest_crop': 'harvest',
      'log_tillage': 'tillage', 'log_irrigation': 'irrigation',
      'spraying': 'spraying', 'fertilization': 'fertilization', 'planting': 'planting',
      'harvest': 'harvest', 'tillage': 'tillage', 'irrigation': 'irrigation',
    };
    let activityTypes = (cmd.activityTypes as string[]) || null;
    if (!activityTypes && cmd.activityFilter) {
      const legacy = legacyMap[cmd.activityFilter as string];
      if (legacy) activityTypes = [legacy];
    }

    const sortBy = (cmd.sort_by as 'date' | 'quantity' | 'type') || 'date';
    const sortDesc = cmd.sort_desc != null ? !!cmd.sort_desc : true;

    // ── 4. Query ──
    const rows = await queryActivities({
      userId: Number(userId),
      plotId: resolved.plotId ?? null,
      fieldId: resolved.fieldId ?? null,
      crop: (cmd.crop as string) ?? null,
      activityTypes,
      productSearch: (cmd.productSearch as string) ?? null,
      desde, hasta,
      quantityMin: (cmd.quantityMin as number) ?? null,
      quantityMax: (cmd.quantityMax as number) ?? null,
      sortBy, sortDesc, limit: 200,
    });

    // ── 5. Persist for multi-turn ──
    void this.saveActivityQuery(userId, cmd).catch(() => {});

    // ── 6. Scope label ──
    const scopeBits: string[] = [];
    if (resolved.plotName) scopeBits.push(`lote ${resolved.plotName}`);
    else if (resolved.fieldName) scopeBits.push(`campo ${resolved.fieldName}`);
    if (cmd.crop) scopeBits.push(String(cmd.crop));
    if (activityTypes && activityTypes.length > 0) {
      const labels: Record<string, string> = { planting:'siembras', spraying:'fumigaciones', fertilization:'fertilizaciones', harvest:'cosechas', tillage:'labranza', irrigation:'riegos' };
      scopeBits.push(activityTypes.map(t => labels[t] || t).join('/'));
    }
    if (cmd.productSearch) scopeBits.push(String(cmd.productSearch));
    if (cmd.quantityMin != null) scopeBits.push(`>${cmd.quantityMin}`);
    if (cmd.quantityMax != null) scopeBits.push(`<${cmd.quantityMax}`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: import('./activity-renderers.js').ActivityRenderCtx = {
      scope, rangeLabel: isAll ? 'Todo el historial' : rangeLabel, isAll,
      filters: {
        plotName: resolved.plotName,
        fieldName: resolved.fieldName,
        crop: cmd.crop as string | null,
        activityTypes,
        productSearch: cmd.productSearch as string | null,
        aggregateMetric: cmd.aggregateMetric as string | null,
        groupBy: cmd.group_by as string | null,
        sortDesc,
      },
    };

    // ── 7. Determine view ──
    const view = (cmd.view as string)
      || (cmd.compareCrop || cmd.comparePlot || cmd.compareField || cmd.compareActivityType ? 'compare'
        : cmd.group_by ? 'top_locations'
        : cmd.isUltimaVez ? 'last'
        : 'detail');

    // ── 8. Compare ──
    if (view === 'compare') {
      const optsB: Parameters<typeof queryActivities>[0] = {
        userId: Number(userId),
        plotId: null, fieldId: null,
        crop: (cmd.compareCrop as string) ?? (cmd.crop as string) ?? null,
        activityTypes: cmd.compareActivityType ? [cmd.compareActivityType as string] : activityTypes,
        desde, hasta, sortBy, sortDesc, limit: 200,
      };
      if (cmd.comparePlot) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, null, cmd.comparePlot as string);
        optsB.plotId = rB.plotId ?? null;
        optsB.fieldId = rB.fieldId ?? null;
      } else if (cmd.compareField) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, cmd.compareField as string, null);
        optsB.fieldId = rB.fieldId ?? null;
      }
      const rowsB = await queryActivities(optsB);
      const labelA = (cmd.crop as string) || (resolved.plotName as string) || (resolved.fieldName as string) || (activityTypes?.[0] as string) || 'A';
      const labelB = (cmd.compareCrop as string) || (cmd.comparePlot as string) || (cmd.compareField as string) || (cmd.compareActivityType as string) || 'B';
      return renderers.renderActivityCompare(rows as import('./activity-renderers.js').ActivityRow[], rowsB as import('./activity-renderers.js').ActivityRow[], labelA, labelB);
    }

    // ── 9. Empty + proactive hint ──
    if (rows.length === 0) {
      const allRows = await queryActivities({ userId: Number(userId), sortDesc: true, limit: 200 });
      const types = new Set<string>(); const crops = new Set<string>(); const plots = new Set<string>(); const products = new Set<string>();
      for (const r of allRows) { types.add(r.event_type); if (r.crop) crops.add(r.crop); if (r.plot_name) plots.add(r.plot_name); if (r.product) products.add(r.product); }
      return renderers.renderEmpty(ctx, { types: [...types], crops: [...crops], plots: [...plots], products: [...products] });
    }

    // ── 10. Dispatch ──
    switch (view) {
      case 'aggregate': return renderers.renderActivityAggregate(rows as import('./activity-renderers.js').ActivityRow[], ctx);
      case 'max': return renderers.renderActivityExtreme(rows as import('./activity-renderers.js').ActivityRow[], ctx, 'max');
      case 'min': return renderers.renderActivityExtreme(rows as import('./activity-renderers.js').ActivityRow[], ctx, 'min');
      case 'avg': return renderers.renderActivityAvg(rows as import('./activity-renderers.js').ActivityRow[], ctx);
      case 'rank': return renderers.renderActivityRank(rows as import('./activity-renderers.js').ActivityRow[], ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderActivityTopLocations(rows as import('./activity-renderers.js').ActivityRow[], ctx);
      case 'last': return renderers.renderActivityLast(rows as import('./activity-renderers.js').ActivityRow[], ctx, (cmd.top_n as number) || (cmd.isUltimaVez ? 1 : 10));
      case 'timeline': return renderers.renderActivityTimeline(rows as import('./activity-renderers.js').ActivityRow[], ctx);
      case 'detail':
      default: return renderers.renderActivityDetail(rows as import('./activity-renderers.js').ActivityRow[], ctx);
    }
  }

  // --- Unified rainfall_report dispatcher ---
  private async handleQueryRainfall(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const { queryRainfall } = await import('../../services/expenses.js');
    const renderers = await import('./rainfall-renderers.js');

    // ── 1. Inherit ──
    const TRANSIENT_KEYS = new Set(['view', 'top_n', 'compareField', 'comparePlot', 'compare_desde', 'compare_hasta']);
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_rainfall_query FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_rainfall_query;
        if (prev && typeof prev === 'object') {
          for (const [k, v] of Object.entries(prev)) {
            if (TRANSIENT_KEYS.has(k)) continue;
            if (cmd[k] == null) cmd[k] = v as never;
          }
        }
      } catch { /* non-fatal */ }
    }

    // ── 2. Resolve scope ──
    const resolved = await this.plotDiscovery.resolveFromNames(userId, cmd.fieldName as string | null, cmd.plotName as string | null);

    // ── 3. Date range ──
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const nowAR = new Date();
    let desde = (cmd.desde as string) || null;
    let hasta = (cmd.hasta as string) || null;
    let rangeLabel = '';
    let isAll = false;
    const period = cmd.period as string | undefined;

    if (period === 'all') {
      desde = '2000-01-01'; hasta = todayISO; isAll = true; rangeLabel = 'Todo el historial';
    } else if (cmd.days != null) {
      const d = new Date(); d.setDate(d.getDate() - Number(cmd.days));
      desde = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      hasta = todayISO;
      rangeLabel = `últimos ${cmd.days} días`;
    } else if (period === 'week' || period === 'last_week') {
      const d = new Date(); d.setDate(d.getDate() - (period === 'last_week' ? 14 : 7));
      desde = d.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
      hasta = todayISO;
      rangeLabel = period === 'last_week' ? 'semana pasada' : 'esta semana';
    } else if (period === 'month') {
      desde = `${nowAR.getFullYear()}-${String(nowAR.getMonth() + 1).padStart(2, '0')}-01`;
      hasta = todayISO;
      rangeLabel = nowAR.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    } else if (period === 'last_month') {
      const lastM = new Date(nowAR.getFullYear(), nowAR.getMonth() - 1, 1);
      desde = lastM.toISOString().slice(0, 10);
      hasta = new Date(nowAR.getFullYear(), nowAR.getMonth(), 0).toISOString().slice(0, 10);
      rangeLabel = lastM.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
    } else if (period === 'year') {
      desde = `${nowAR.getFullYear()}-01-01`;
      hasta = todayISO;
      rangeLabel = `Año ${nowAR.getFullYear()}`;
    } else if (!desde && !hasta) {
      // Default: all-history for analytical queries (no narrowing → don't default to current month)
      desde = '2000-01-01'; hasta = todayISO; isAll = true; rangeLabel = 'Todo el historial';
    } else {
      rangeLabel = `${desde || '...'} — ${hasta || todayISO}`;
    }
    if (desde && hasta && desde > hasta) {
      return { messages: [`Rango inválido: ${desde} es posterior a ${hasta}.`] };
    }

    const sortBy = (cmd.sort_by as 'date' | 'mm') || 'date';
    const sortDesc = cmd.sort_desc != null ? !!cmd.sort_desc : true;

    // ── 4. Query ──
    const rows = await queryRainfall({
      userId: Number(userId),
      fieldId: resolved.fieldId ?? null,
      plotId: resolved.plotId ?? null,
      desde, hasta,
      mmMin: (cmd.mmMin as number) ?? null,
      mmMax: (cmd.mmMax as number) ?? null,
      sortBy, sortDesc, limit: 365,
    });

    void this.saveRainfallQuery(userId, cmd).catch(() => {});

    // ── 5. Scope label ──
    const scopeBits: string[] = [];
    if (resolved.plotName) scopeBits.push(`lote ${resolved.plotName}`);
    else if (resolved.fieldName) scopeBits.push(`campo ${resolved.fieldName}`);
    if (cmd.mmMin != null) scopeBits.push(`>${cmd.mmMin}mm`);
    if (cmd.mmMax != null) scopeBits.push(`<${cmd.mmMax}mm`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: import('./rainfall-renderers.js').RainfallRenderCtx = {
      scope, rangeLabel: isAll ? 'Todo el historial' : rangeLabel, isAll,
      filters: {
        fieldName: resolved.fieldName,
        plotName: resolved.plotName,
        mmMin: cmd.mmMin as number | null,
        mmMax: cmd.mmMax as number | null,
        aggregateMetric: cmd.aggregateMetric as string | null,
        groupBy: cmd.group_by as string | null,
        sortDesc,
      },
    };

    const view = (cmd.view as string)
      || (cmd.compareField || cmd.comparePlot || cmd.compare_desde ? 'compare'
        : cmd.group_by ? 'top_locations'
        : 'detail');

    // ── 6. Compare ──
    if (view === 'compare') {
      let rowsB = rows;
      let labelA = (resolved.fieldName as string) || (resolved.plotName as string) || 'A';
      let labelB = 'B';
      if (cmd.compareField) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, cmd.compareField as string, null);
        rowsB = await queryRainfall({ userId: Number(userId), fieldId: rB.fieldId ?? null, desde, hasta, sortBy, sortDesc, limit: 365 });
        labelB = cmd.compareField as string;
      } else if (cmd.comparePlot) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, null, cmd.comparePlot as string);
        rowsB = await queryRainfall({ userId: Number(userId), plotId: rB.plotId ?? null, desde, hasta, sortBy, sortDesc, limit: 365 });
        labelB = cmd.comparePlot as string;
      } else if (cmd.compare_desde || cmd.compare_hasta) {
        rowsB = await queryRainfall({
          userId: Number(userId),
          fieldId: resolved.fieldId ?? null,
          plotId: resolved.plotId ?? null,
          desde: (cmd.compare_desde as string) ?? null,
          hasta: (cmd.compare_hasta as string) ?? null,
          sortBy, sortDesc, limit: 365,
        });
        labelA = rangeLabel;
        labelB = `${cmd.compare_desde || '...'} — ${cmd.compare_hasta || '...'}`;
      }
      return renderers.renderRainfallCompare(rows as import('./rainfall-renderers.js').RainfallRow[], rowsB as import('./rainfall-renderers.js').RainfallRow[], labelA, labelB);
    }

    // ── 7. Empty ──
    if (rows.length === 0) {
      const all = await queryRainfall({ userId: Number(userId), limit: 365 });
      const fields = new Set<string>(); const plots = new Set<string>();
      for (const r of all) { if (r.field_name) fields.add(r.field_name); if (r.plot_name) plots.add(r.plot_name); }
      return renderers.renderEmpty(ctx, { fields: [...fields], plots: [...plots] });
    }

    // ── 8. Dispatch ──
    switch (view) {
      case 'aggregate': return renderers.renderRainfallAggregate(rows as import('./rainfall-renderers.js').RainfallRow[], ctx);
      case 'max': return renderers.renderRainfallExtreme(rows as import('./rainfall-renderers.js').RainfallRow[], ctx, 'max');
      case 'min': return renderers.renderRainfallExtreme(rows as import('./rainfall-renderers.js').RainfallRow[], ctx, 'min');
      case 'avg': return renderers.renderRainfallAvg(rows as import('./rainfall-renderers.js').RainfallRow[], ctx);
      case 'rank': return renderers.renderRainfallRank(rows as import('./rainfall-renderers.js').RainfallRow[], ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderRainfallTopLocations(rows as import('./rainfall-renderers.js').RainfallRow[], ctx);
      case 'last': return renderers.renderRainfallLast(rows as import('./rainfall-renderers.js').RainfallRow[], ctx, (cmd.top_n as number) || 1);
      case 'monthly': return renderers.renderRainfallMonthly(rows as import('./rainfall-renderers.js').RainfallRow[], ctx);
      case 'detail':
      default: return renderers.renderRainfallDetail(rows as import('./rainfall-renderers.js').RainfallRow[], ctx);
    }
  }

  private async saveRainfallQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'plotName', 'period', 'desde', 'hasta', 'days', 'mmMin', 'mmMax',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_rainfall_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_rainfall_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }

  private async saveActivityQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'plotName', 'crop', 'period', 'desde', 'hasta',
      'activityTypes', 'activityFilter', 'productSearch',
      'quantityMin', 'quantityMax', 'isUltimaVez',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_activity_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_activity_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }

  private async saveScoutingQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'plotName', 'period', 'desde', 'hasta', 'stageCode', 'stagePrefix',
      'pestSpeciesQuery', 'pestSeverityMin', 'hasPest', 'weedSpeciesAny', 'weedMinPct', 'weedMaxPct', 'hasWeeds',
      'emergenceMinPct', 'emergenceMaxPct', 'densityMin', 'densityMax', 'soilMoistureMin', 'soilMoistureMax',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_scouting_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_scouting_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }

  // --- Unified query_harvest_loads: filter + view dispatcher ---
  private async handleQueryHarvestLoads(cmd: ParsedCommand, userId: UserId): Promise<HandlerResponse> {
    const { pool } = await import('../../config/db.js');
    const renderers = await import('./harvest-renderers.js');

    // ── 1. Multi-turn inherit ──
    if (cmd.inherit) {
      try {
        const { rows } = await pool.query('SELECT last_harvest_query FROM conversation_state WHERE user_id = $1', [userId]);
        const prev = rows[0]?.last_harvest_query;
        if (prev && typeof prev === 'object') {
          for (const [k, v] of Object.entries(prev)) if (cmd[k] == null) cmd[k] = v as never;
        }
      } catch { /* non-fatal */ }
    }

    // ── 2. Resolve scope ──
    let plotId: number | null = null;
    let fieldId: number | null = null;
    let plotName: string | null = null;
    let fieldName: string | null = null;
    if (cmd.plotName || cmd.fieldName) {
      const resolved = await this.plotDiscovery.resolveFromNames(userId, cmd.fieldName as string | null, cmd.plotName as string | null);
      plotId = resolved.plotId ?? null;
      fieldId = resolved.fieldId ?? null;
      plotName = resolved.plotName;
      fieldName = resolved.fieldName;
    }

    // ── 3. Date range (analytical default → all-history) ──
    const todayISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
    const nowAR = new Date();
    const currentMonthStart = `${nowAR.getFullYear()}-${String(nowAR.getMonth() + 1).padStart(2, '0')}-01`;
    const currentMonthLastDay = new Date(nowAR.getFullYear(), nowAR.getMonth() + 1, 0).toISOString().slice(0, 10);
    let desde = (cmd.desde as string) || null;
    let hasta = (cmd.hasta as string) || null;
    let rangeLabel = '';
    let isAll = false;

    // Heuristic: if agent set EXACTLY current-month boundaries without explicit cmd.period, widen.
    const hasNarrowingFilter = !!(cmd.driverName || cmd.destinatario || cmd.truckPlate || cmd.crop
      || cmd.weightMinKg != null || cmd.weightMaxKg != null
      || cmd.humidityMinPct != null || cmd.humidityMaxPct != null
      || cmd.proteinMinPct != null || cmd.proteinMaxPct != null
      || cmd.oilMinPct != null || cmd.oilMaxPct != null
      || cmd.glutenMinPct != null || cmd.glutenMaxPct != null
      || cmd.eventDate);
    const agentDefaultedToCurrentMonth = desde === currentMonthStart
      && (hasta === todayISO || hasta === currentMonthLastDay)
      && !cmd.period;
    if (hasNarrowingFilter && agentDefaultedToCurrentMonth) {
      desde = null;
      hasta = null;
    }

    if (cmd.period === 'all' || (!desde && !hasta && !cmd.eventDate)) {
      desde = '2000-01-01';
      hasta = todayISO;
      isAll = true;
      rangeLabel = 'Todo el historial';
    } else if (cmd.eventDate) {
      rangeLabel = String(cmd.eventDate);
    } else {
      rangeLabel = `${desde || '...'} — ${hasta || todayISO}`;
    }
    if (desde && hasta && desde > hasta) {
      return { messages: [`Rango inválido: ${desde} es posterior a ${hasta}.`] };
    }

    // ── 4. Sort defaults ──
    const aggregateMetric = (cmd.aggregateMetric as string) || null;
    const sortBy = (cmd.sort_by as string) || (cmd.view === 'max' || cmd.view === 'min' || cmd.view === 'rank' ? (aggregateMetric === 'weight_kg' ? 'weight' : aggregateMetric === 'humidity_pct' ? 'humidity' : aggregateMetric === 'protein_pct' ? 'protein' : aggregateMetric === 'oil_pct' ? 'oil' : aggregateMetric === 'gluten_pct' ? 'gluten' : 'date') : 'date');
    const sortDescDefault = cmd.view === 'min' ? false : true;
    const sortDesc = cmd.sort_desc != null ? !!cmd.sort_desc : sortDescDefault;

    // ── 5. Query ──
    const rows = await this.repo.queryHarvestLoads(userId, {
      plotId, fieldId,
      crop: (cmd.crop as string) ?? null,
      eventDate: (cmd.eventDate as string) ?? null,
      desde, hasta,
      driverName: (cmd.driverName as string) ?? null,
      destinatario: (cmd.destinatario as string) ?? null,
      truckPlate: (cmd.truckPlate as string) ?? null,
      weightMinKg: (cmd.weightMinKg as number) ?? null,
      weightMaxKg: (cmd.weightMaxKg as number) ?? null,
      humidityMinPct: (cmd.humidityMinPct as number) ?? null,
      humidityMaxPct: (cmd.humidityMaxPct as number) ?? null,
      proteinMinPct: (cmd.proteinMinPct as number) ?? null,
      proteinMaxPct: (cmd.proteinMaxPct as number) ?? null,
      oilMinPct: (cmd.oilMinPct as number) ?? null,
      oilMaxPct: (cmd.oilMaxPct as number) ?? null,
      glutenMinPct: (cmd.glutenMinPct as number) ?? null,
      glutenMaxPct: (cmd.glutenMaxPct as number) ?? null,
      sortBy, sortDesc, limit: 200,
    } as Parameters<typeof this.repo.queryHarvestLoads>[1]);

    // ── 6. Persist for multi-turn ──
    void this.saveHarvestQuery(userId, cmd).catch(() => {});

    // ── 7. Build scope ──
    const scopeBits: string[] = [];
    if (plotName) scopeBits.push(`lote ${plotName}`);
    else if (fieldName) scopeBits.push(`campo ${fieldName}`);
    if (cmd.crop) scopeBits.push(String(cmd.crop));
    if (cmd.driverName) scopeBits.push(`chofer ${cmd.driverName}`);
    if (cmd.destinatario) scopeBits.push(`→ ${cmd.destinatario}`);
    if (cmd.truckPlate) scopeBits.push(`patente ${cmd.truckPlate}`);
    if (cmd.weightMinKg != null) scopeBits.push(`>${(Number(cmd.weightMinKg) / 1000)} tn`);
    if (cmd.weightMaxKg != null) scopeBits.push(`<${(Number(cmd.weightMaxKg) / 1000)} tn`);
    if (cmd.humidityMinPct != null) scopeBits.push(`hum >${cmd.humidityMinPct}%`);
    if (cmd.humidityMaxPct != null) scopeBits.push(`hum <${cmd.humidityMaxPct}%`);
    if (cmd.proteinMinPct != null) scopeBits.push(`prot >${cmd.proteinMinPct}%`);
    if (cmd.oilMinPct != null) scopeBits.push(`aceite >${cmd.oilMinPct}%`);
    const scope = scopeBits.length > 0 ? ` — ${scopeBits.join(', ')}` : '';

    const ctx: renderers.HarvestRenderCtx = {
      rangeLabel: isAll ? 'Todo el historial' : rangeLabel,
      scope, isAll,
      filters: {
        plotName, fieldName,
        crop: cmd.crop as string | null,
        driverName: cmd.driverName as string | null,
        destinatario: cmd.destinatario as string | null,
        truckPlate: cmd.truckPlate as string | null,
        aggregateMetric,
        groupBy: cmd.group_by as string | null,
        sortDesc,
      },
    };

    // ── 8. Determine view ──
    const view = (cmd.view as string)
      || (cmd.compareCrop || cmd.compareDriver || cmd.compareDestinatario || cmd.comparePlot ? 'compare'
        : cmd.group_by ? 'top_locations'
        : 'detail');

    // ── 9. Compare view ──
    if (view === 'compare') {
      const queryB = { ...arguments[0] };
      // Build B params: swap the compared dimension
      const optsB: Record<string, unknown> = {
        plotId, fieldId,
        crop: cmd.compareCrop ?? cmd.crop,
        desde, hasta,
        driverName: cmd.compareDriver ?? cmd.driverName,
        destinatario: cmd.compareDestinatario ?? cmd.destinatario,
        truckPlate: cmd.truckPlate,
        sortBy, sortDesc, limit: 200,
      };
      // If comparing by plot, resolve plot B
      if (cmd.comparePlot) {
        const rB = await this.plotDiscovery.resolveFromNames(userId, null, cmd.comparePlot as string);
        optsB.plotId = rB.plotId ?? null;
        optsB.fieldId = rB.fieldId ?? null;
        optsB.crop = cmd.crop;
      }
      const rowsB = await this.repo.queryHarvestLoads(userId, optsB as Parameters<typeof this.repo.queryHarvestLoads>[1]);
      void queryB;
      const labelA = (cmd.crop as string) || (cmd.driverName as string) || (cmd.destinatario as string) || (plotName ?? 'A');
      const labelB = (cmd.compareCrop as string) || (cmd.compareDriver as string) || (cmd.compareDestinatario as string) || (cmd.comparePlot as string) || 'B';
      return renderers.renderHarvestCompare(rows as renderers.HarvestRow[], rowsB as renderers.HarvestRow[], String(labelA), String(labelB));
    }

    // ── 10. Empty: proactive hint with available species ──
    if (rows.length === 0) {
      const hints = await this.repo.queryHarvestLoads(userId, { sortBy: 'date', sortDesc: true, limit: 200 } as Parameters<typeof this.repo.queryHarvestLoads>[1]);
      const crops = new Set<string>(); const drivers = new Set<string>(); const dests = new Set<string>(); const plots = new Set<string>();
      for (const r of hints) {
        if (r.crop) crops.add(r.crop);
        if (r.driver_name) drivers.add(r.driver_name);
        if (r.destinatario) dests.add(r.destinatario); else if (r.destination) dests.add(r.destination);
        if (r.plot_name) plots.add(r.plot_name);
      }
      return renderers.renderEmpty(ctx, { crops: [...crops], drivers: [...drivers], destinatarios: [...dests], plots: [...plots] });
    }

    // ── 11. Dispatch ──
    switch (view) {
      case 'aggregate': return renderers.renderHarvestAggregate(rows as renderers.HarvestRow[], ctx);
      case 'max': return renderers.renderHarvestExtreme(rows as renderers.HarvestRow[], ctx, 'max');
      case 'min': return renderers.renderHarvestExtreme(rows as renderers.HarvestRow[], ctx, 'min');
      case 'avg': return renderers.renderHarvestAvg(rows as renderers.HarvestRow[], ctx);
      case 'rank': return renderers.renderHarvestRank(rows as renderers.HarvestRow[], ctx, (cmd.top_n as number) || 5);
      case 'top_locations': return renderers.renderHarvestTopLocations(rows as renderers.HarvestRow[], ctx);
      case 'volume': return renderers.renderHarvestVolume(rows as renderers.HarvestRow[], ctx);
      case 'detail':
      default: return renderers.renderHarvestDetail(rows as renderers.HarvestRow[], ctx);
    }
  }

  private async saveHarvestQuery(userId: UserId, cmd: ParsedCommand): Promise<void> {
    const { pool } = await import('../../config/db.js');
    const KEEP = ['fieldName', 'plotName', 'crop', 'period', 'desde', 'hasta', 'eventDate',
      'driverName', 'destinatario', 'truckPlate',
      'weightMinKg', 'weightMaxKg', 'humidityMinPct', 'humidityMaxPct',
      'proteinMinPct', 'proteinMaxPct', 'oilMinPct', 'oilMaxPct', 'glutenMinPct', 'glutenMaxPct',
      'view', 'aggregateMetric', 'sort_by', 'sort_desc', 'top_n', 'group_by'];
    const persistable: Record<string, unknown> = {};
    for (const k of KEEP) if (cmd[k] !== undefined && cmd[k] !== null) persistable[k] = cmd[k];
    await pool.query(
      `INSERT INTO conversation_state (user_id, last_harvest_query, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_harvest_query = $2::jsonb, updated_at = NOW()`,
      [userId, JSON.stringify(persistable)],
    );
  }

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      // --- Weather ---

      case 'weather_full': {
        if (!process.env.OPENWEATHER_API_KEY) {
          return { messages: ['El clima no est\u00e1 configurado todav\u00eda.'] };
        }
        const resolved = resolveWeatherCity(cmd, user);
        if (resolved.clarify) return { messages: [resolved.clarify] };
        const weatherCity = resolved.city;
        if (!weatherCity && !process.env.WEATHER_CITY) {
          return { messages: ['No tengo tu ubicaci\u00f3n. Escrib\u00ed algo como:\n\ud83d\udccd *estoy en Jun\u00edn*\n\nO ped\u00ed el clima de una ciudad:\n\ud83c\udf24\ufe0f *clima en Pergamino*'] };
        }
        try {
          const [current, forecastData] = await Promise.all([
            getCurrentWeather(weatherCity),
            getForecast(weatherCity, 3),
          ]);
          let msg = formatCurrentWeather(current) + '\n\n' + formatForecast(forecastData);
          const rainAlert = checkRainAlert(forecastData, settings.rain_alert_mm);
          if (rainAlert) msg += '\n\n' + rainAlert;
          return { messages: [msg], suggestionKey: 'weather_shown' };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
          logError('agronomy', 'WEATHER_CURRENT', e as Error, { userId });
          return { messages: ['No pude obtener el clima. Verific\u00e1 la ciudad o intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      case 'weather_forecast': {
        if (!process.env.OPENWEATHER_API_KEY) {
          return { messages: ['El clima no est\u00e1 configurado todav\u00eda.'] };
        }
        const resolved = resolveWeatherCity(cmd, user);
        if (resolved.clarify) return { messages: [resolved.clarify] };
        const fcCity = resolved.city;
        if (!fcCity && !process.env.WEATHER_CITY) {
          return { messages: ['No tengo tu ubicaci\u00f3n. Escrib\u00ed algo como:\n\ud83d\udccd *estoy en Jun\u00edn*\n\nO ped\u00ed el clima de una ciudad:\n\ud83c\udf24\ufe0f *clima en Pergamino*'] };
        }
        try {
          const forecastData = await getForecast(fcCity, cmd.days as number);
          let msg = formatForecast(forecastData);
          const rainAlert = checkRainAlert(forecastData, settings.rain_alert_mm);
          if (rainAlert) msg += '\n\n' + rainAlert;
          return { messages: [msg], suggestionKey: 'weather_shown' };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
          logError('agronomy', 'WEATHER_FORECAST', e as Error, { userId });
          return { messages: ['No pude obtener el pron\u00f3stico. Verific\u00e1 la ciudad o intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      case 'weather_field': {
        if (!process.env.OPENWEATHER_API_KEY) {
          return { messages: ['El clima no est\u00e1 configurado todav\u00eda.'] };
        }
        const field = await this.repo.getFieldByName(userId, cmd.fieldName as string);
        const fieldCity = field?.city || user.city || null;
        if (!fieldCity) {
          return { messages: [`No tengo la ubicaci\u00f3n del lote ${cmd.fieldName}.\nEscrib\u00ed: *lote ${cmd.fieldName} est\u00e1 en [ciudad]*`] };
        }
        try {
          const [current, forecastData] = await Promise.all([
            getCurrentWeather(fieldCity),
            getForecast(fieldCity, 3),
          ]);
          let msg = `\ud83d\udccd *Lote ${cmd.fieldName}* (${fieldCity})\n\n`;
          msg += formatCurrentWeather(current) + '\n\n' + formatForecast(forecastData);
          const rainAlert = checkRainAlert(forecastData, settings.rain_alert_mm);
          if (rainAlert) msg += '\n\n' + rainAlert;
          return { messages: [msg], suggestionKey: 'weather_shown' };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
          logError('agronomy', 'WEATHER_FIELD', e as Error, { userId });
          return { messages: ['No pude obtener el clima. Verific\u00e1 la ciudad o intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      case 'weather_all': {
        if (!process.env.OPENWEATHER_API_KEY) {
          return { messages: ['El clima no est\u00e1 configurado todav\u00eda.'] };
        }
        const fieldsWithCity = await this.repo.getUserFieldsWithCity(userId);
        const locations: { label: string; city: string }[] = [];
        const seenCities = new Set<string>();

        if (user.city) {
          locations.push({ label: '\ud83d\udccd Tu ubicaci\u00f3n', city: user.city });
          seenCities.add(user.city.toLowerCase());
        }
        for (const f of fieldsWithCity) {
          if (!seenCities.has(f.city.toLowerCase())) {
            locations.push({ label: `\ud83d\udccd Lote ${f.name}`, city: f.city });
            seenCities.add(f.city.toLowerCase());
          } else {
            const existing = locations.find((l) => l.city.toLowerCase() === f.city.toLowerCase());
            if (existing) existing.label += `, ${f.name}`;
          }
        }

        if (locations.length === 0) {
          return { messages: ['No tengo ubicaciones configuradas.\n\nEscrib\u00ed:\n\ud83d\udccd *estoy en Jun\u00edn*\n\ud83d\udccd *lote 3 est\u00e1 en Pergamino*'] };
        }

        try {
          let msg = '\ud83c\udf24\ufe0f *Clima en todas tus ubicaciones*\n';
          const alerts: string[] = [];

          for (const loc of locations) {
            const current = await getCurrentWeather(loc.city);
            const forecast = await getForecast(loc.city, 1);
            msg += `\n${loc.label} \u2014 *${loc.city}*\n`;
            msg += `${current.icon} ${current.temp}\u00b0C | \ud83d\udca7${current.humidity}% | \ud83d\udca8${current.wind}km/h\n`;

            const rainAlert = checkRainAlert(forecast, settings.rain_alert_mm);
            if (rainAlert) alerts.push(`${loc.label} (${loc.city}): ${rainAlert}`);
          }

          if (alerts.length > 0) {
            msg += '\n\u26a0\ufe0f *Alertas de lluvia:*\n' + alerts.join('\n');
          }

          return { messages: [msg], suggestionKey: 'weather_shown' };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
          logError('agronomy', 'WEATHER_ALL', e as Error, { userId });
          return { messages: ['No pude obtener el clima. Intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      // --- Rainfall ---

      case 'log_rainfall': {
        const mm = cmd.mm as number;

        // Validate mm range
        if (mm <= 0 || mm > 500) {
          return { messages: ['El valor debe estar entre 1 y 500mm.'] };
        }

        // Block if user has no fields
        const rainfallUserFields = await this.repo.getUserFields(userId);
        if (rainfallUserFields.length === 0) {
          return {
            messages: ['Para registrar lluvia primero necesitás crear un campo.\n\n📍 Escribí *agregar campo [nombre]*\nEj: *agregar campo La Esperanza*'],
            interactive: {
              type: 'buttons',
              body: 'Necesitás un campo para registrar lluvia.',
              buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
            },
          };
        }

        // Resolve field (field-level only, no plot_id)
        let fieldId: number | null = null;
        let fieldLabel: string | null = null;

        // Check if user explicitly mentioned a field/plot name in their message
        // If no originalText, it's from a button callback — trust the field/plot name
        const originalText = ((cmd.originalText as string) || '').toLowerCase();
        const fromCallback = !cmd.originalText;
        const fieldExplicit = cmd.fieldName
          ? (fromCallback || originalText.includes((cmd.fieldName as string).toLowerCase()))
          : false;
        const plotExplicit = cmd.plotName
          ? (fromCallback || originalText.includes((cmd.plotName as string).toLowerCase()))
          : false;

        if (cmd.fieldName && fieldExplicit) {
          // User explicitly mentioned a field name (or selected via button)
          const field = await this.repo.getFieldByName(userId, cmd.fieldName as string);
          if (field) {
            fieldId = field.id;
            fieldLabel = field.name;
          } else {
            return {
              messages: [`No encontré el campo *${cmd.fieldName}*.\nPara crearlo: *agregar campo ${cmd.fieldName}*`],
            };
          }
        } else if (cmd.plotName && plotExplicit) {
          // "lote X" → resolve to parent field
          const plots = await this.repo.findPlotByNameAcrossFields(userId, cmd.plotName as string);
          if (plots.length > 0) {
            fieldId = plots[0].field_id;
            fieldLabel = plots[0].field_name;
          }
        } else if (rainfallUserFields.length === 1) {
          // Auto-assign single field
          const singleField = await this.repo.getFieldByName(userId, rainfallUserFields[0].name);
          if (singleField) {
            fieldId = singleField.id;
            fieldLabel = singleField.name;
          }
        } else {
          // City fallback: when the user wrote "llovió X en {place}" but
          // {place} is NOT one of their campo names, check if it matches the
          // city of exactly one campo. If yes, auto-resolve to that campo
          // instead of asking. (Real user feedback: "Llovió 3mm en el dorado"
          // when "el dorado" was a city, not a campo name.)
          const placeMatch = originalText.match(/\ben\s+(?:el|la|los|las)?\s*([\wáéíóúñü .'-]{3,40})\b/i);
          const placeRaw = placeMatch?.[1]?.trim().toLowerCase() || '';
          if (placeRaw.length >= 3) {
            const norm = (s: string) => (s || '').toLowerCase()
              .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
            const placeNorm = norm(placeRaw);
            const fieldsWithCity = await this.repo.getUserFieldsWithCity(userId).catch(() => null);
            if (fieldsWithCity) {
              const cityMatches = fieldsWithCity.filter(f => f.city && norm(f.city).includes(placeNorm));
              if (cityMatches.length === 1) {
                const matched = await this.repo.getFieldByName(userId, cityMatches[0].name);
                if (matched) {
                  fieldId = matched.id;
                  fieldLabel = matched.name;
                }
              }
            }
          }
        }

        // If we still don't have a fieldId after auto-assign + city fallback,
        // ask the user which campo (buttons ≤3, list otherwise).
        if (!fieldId) {
          // Buttons cap at 3 on WhatsApp; switch to a list (max 10 rows) so
          // users with many campos see all options.
          const askMsg = `Llovieron *${mm}mm* 🌧️ ¿En qué campo?`;
          if (rainfallUserFields.length <= 3) {
            const buttons = rainfallUserFields.map(f => ({
              id: `rain_field_${f.name}_${mm}`,
              title: f.name.slice(0, 20),
            }));
            return {
              messages: [askMsg],
              interactive: { type: 'buttons' as const, body: 'Elegí el campo:', buttons },
            };
          }
          return {
            messages: [askMsg],
            interactive: {
              type: 'list' as const,
              body: askMsg,
              buttonText: 'Elegir campo',
              sections: [{
                title: 'Tus campos',
                rows: rainfallUserFields.slice(0, 10).map(f => ({
                  id: `rain_field_${f.name}_${mm}`,
                  title: f.name.substring(0, 24),
                })),
              }],
            },
          };
        }

        const rainfallDate = cmd.eventDate ? String(cmd.eventDate) : null;
        const saved = await this.repo.saveRainfall(userId, mm, fieldId, rainfallDate);

        // Handle dedup rejection
        if (saved === RAINFALL_REJECTED_DUPLICATE) {
          const dupLabel = fieldLabel || 'tu campo';
          const dateLabel = rainfallDate
            ? new Date(rainfallDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' })
            : 'hoy';
          return { messages: [`🌧️ *${mm}mm* en *${dupLabel}* (${dateLabel}) — _ya estaba cargado, omitido_. Si querés corregir el monto, decime "borrar lluvia" y volvé a registrarla.`] };
        }

        let msg = `\ud83c\udf27\ufe0f Lluvia registrada: *${mm}mm*`;
        if (fieldLabel) msg += `\n\ud83d\udccd ${fieldLabel}`;
        if (rainfallDate) {
          const dateLabel = new Date(rainfallDate + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'long', timeZone: 'America/Argentina/Buenos_Aires' });
          msg += `\n\ud83d\udcc5 ${dateLabel}`;
        }

        // Check cumulative daily rain threshold alert
        if (settings.rain_alerts !== false) {
          const threshold = settings.rain_alert_mm ?? 10;
          const dailyTotal = await this.repo.getDailyRainfallTotal(userId, fieldId);
          if (dailyTotal >= threshold) {
            const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
            const dedupKey = `field_${fieldId ?? 0}_${today}`;
            const dup = await isDuplicate(userId, 'rain_observed', dedupKey, 24);
            if (!dup) {
              msg += `\n\n\u26a0\ufe0f *Alerta:* Acumulado hoy *${dailyTotal}mm* \u2265 umbral configurado (${threshold}mm)`;
              recordAlert(userId, 'rain_observed', msg, {
                fieldId,
                dedupKey,
                payload: { mm, dailyTotal, threshold, fieldLabel },
              }).catch(() => {});
            } else {
              recordDeduped(userId, 'rain_observed', dedupKey, msg).catch(() => {});
            }
          }
        }

        return { messages: [msg] };
      }

      case 'log_rainfall_batch': {
        // Batched rainfall save from a "rain_batch_<field>_<b64>" callback —
        // applies the chosen field to all queued mm/date pairs at once.
        const fieldName = cmd.fieldName as string;
        const items = (cmd.items as Array<{ mm: number; date: string | null }>) || [];
        if (!fieldName || items.length === 0) {
          return { messages: ['No pude resolver las lluvias pendientes. Probá registrarlas de nuevo.'] };
        }
        const field = await this.repo.getFieldByName(userId, fieldName);
        if (!field) {
          return { messages: [`No encontré el campo *${fieldName}*.`] };
        }
        const lines: string[] = [`🌧️ Lluvias registradas en *${field.name}*:`];
        let total = 0;
        let saved = 0;
        for (const it of items) {
          const result = await this.repo.saveRainfall(userId, it.mm, field.id, it.date);
          if (result === RAINFALL_REJECTED_DUPLICATE) {
            const dateLabel = it.date
              ? new Date(it.date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' })
              : 'hoy';
            lines.push(`  • ${it.mm}mm el ${dateLabel} — _ya estaba cargado, omitido_`);
            continue;
          }
          const dateLabel = it.date
            ? new Date(it.date + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' })
            : 'hoy';
          lines.push(`  • ${it.mm}mm el ${dateLabel}`);
          total += it.mm;
          saved += 1;
        }
        if (saved > 0) lines.push(`📊 Total: *${total}mm* (${saved} registros)`);
        return { messages: [lines.join('\n')] };
      }

      case 'delete_last_rainfall': {
        const deleted = await this.repo.deleteLastRainfall(userId);
        if (!deleted) {
          return { messages: ['No hay registros de lluvia para borrar.'] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Registro de lluvia eliminado: ${deleted.millimeters}mm`] };
      }

      case 'rainfall_report': {
        // Unified dispatch: when ANY new analytical param is present, route to new handler
        const hasNewParam = cmd.view != null || cmd.mmMin != null || cmd.mmMax != null
          || cmd.aggregateMetric != null || cmd.group_by != null || cmd.sort_by != null
          || cmd.sort_desc != null || cmd.top_n != null || cmd.inherit != null
          || cmd.compareField != null || cmd.comparePlot != null || cmd.compare_desde != null
          || cmd.days != null || cmd.desde != null || cmd.hasta != null
          || cmd.plotName != null || cmd.period === 'all';
        if (hasNewParam) return this.handleQueryRainfall(cmd, userId);

        const periodLabel: Record<string, string> = {
          week: 'esta semana', month: 'este mes', year: 'este año',
          day: 'hoy', today: 'hoy',
          last_week: 'la semana pasada', last_month: 'el mes pasado',
        };
        const rawPeriod = (cmd.period as string) || 'month';
        // Normalize: day/today → week (DB doesn't have daily filter, week is closest)
        const period = (rawPeriod === 'day' || rawPeriod === 'today') ? 'week' : rawPeriod;
        const displayPeriod = periodLabel[rawPeriod] || periodLabel[period] || 'este mes';

        // Only filter by field if user explicitly mentioned it (not AI-inferred)
        const rrOriginal = ((cmd.originalText as string) || '').toLowerCase();
        const rrFromCallback = !cmd.originalText;
        const rrFieldExplicit = cmd.fieldName
          ? (rrFromCallback || rrOriginal.includes((cmd.fieldName as string).toLowerCase()))
          : false;

        if (cmd.fieldName && rrFieldExplicit) {
          const field = await this.repo.getFieldByName(userId, cmd.fieldName as string);
          let data = await this.repo.getRainfallPeriod(userId, period, field?.id || null);
          if (data.registros === 0 && field) {
            const nullData = await this.repo.getRainfallPeriod(userId, period, null);
            if (nullData.registros > 0) data = nullData;
          }
          if (data.registros === 0) {
            return { messages: [`No hay registros de lluvia en ${cmd.fieldName} (${displayPeriod}).`], suggestionKey: 'rainfall_logged' };
          }
          return { messages: [`🌧️ *Resumen de lluvias — ${cmd.fieldName}* (${displayPeriod})\n\nTotal: *${data.total}mm*\nRegistros: ${data.registros}`], suggestionKey: 'rainfall_logged' };
        }

        const allData = await this.repo.getRainfallAllLocations(userId, period);
        if (allData.length === 0) {
          return { messages: [`No hay registros de lluvia (${displayPeriod}).`], suggestionKey: 'rainfall_logged' };
        }
        let totalGlobal = 0;
        let msg = `🌧️ *Resumen de lluvias* (${displayPeriod})\n`;
        for (const row of allData) {
          const label = row.field_name || 'Sin campo';
          totalGlobal += row.total;
          msg += `\n📍 ${label}: *${row.total}mm* (${row.registros} reg.)`;
        }
        if (allData.length > 1) msg += `\n\n💧 Total: *${totalGlobal}mm*`;
        return { messages: [msg], suggestionKey: 'rainfall_logged' };
      }

      case 'rainfall_range': {
        const desde = cmd.desde as Date;
        const hasta = cmd.hasta as Date;
        const desdeStr = desde.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const hastaStr = hasta.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
        const data = await this.repo.getRainfallRange(userId, desde, hasta);
        if (data.registros === 0) {
          return { messages: [`No hay registros de lluvia (${desdeStr} — ${hastaStr}).`], suggestionKey: 'rainfall_logged' };
        }
        return { messages: [`🌧️ *Resumen de lluvias* (${desdeStr} — ${hastaStr})\n\nTotal: *${data.total}mm*\nRegistros: ${data.registros}`], suggestionKey: 'rainfall_logged' };
      }

      case 'compare_rainfall_months': {
        const now = new Date();
        const year = now.getFullYear();
        const [d1, d2] = await Promise.all([
          this.repo.getRainfallForMonth(userId, cmd.mes1 as number, year),
          this.repo.getRainfallForMonth(userId, cmd.mes2 as number, year),
        ]);
        const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
        const mes1Name = cmd.mes1Name as string;
        const mes2Name = cmd.mes2Name as string;
        let msg = `🌧️ *Comparación de lluvias — ${cap(mes1Name)} vs ${cap(mes2Name)}* (${year})\n\n`;
        msg += `${cap(mes1Name)}: *${d1.total}mm* (${d1.registros} reg.)\n`;
        msg += `${cap(mes2Name)}: *${d2.total}mm* (${d2.registros} reg.)\n`;
        if (d2.total > 0) {
          const diff = d1.total - d2.total;
          const sign = diff >= 0 ? '+' : '';
          const pct = Math.round((diff / d2.total) * 100);
          msg += `\nDiferencia: ${sign}${diff}mm (${sign}${pct}%)`;
        }
        return { messages: [msg], suggestionKey: 'rainfall_logged' };
      }

      case 'compare_rainfall_years': {
        const [d1, d2] = await Promise.all([
          this.repo.getRainfallForYear(userId, cmd.year1 as number),
          this.repo.getRainfallForYear(userId, cmd.year2 as number),
        ]);
        let msg = `🌧️ *Comparación de lluvias — ${cmd.year1} vs ${cmd.year2}*\n\n`;
        msg += `${cmd.year1}: *${d1.total}mm* (${d1.registros} reg.)\n`;
        msg += `${cmd.year2}: *${d2.total}mm* (${d2.registros} reg.)\n`;
        if (d2.total > 0) {
          const diff = d1.total - d2.total;
          const sign = diff >= 0 ? '+' : '';
          const pct = Math.round((diff / d2.total) * 100);
          msg += `\nDiferencia: ${sign}${diff}mm (${sign}${pct}%)`;
        }
        return { messages: [msg], suggestionKey: 'rainfall_logged' };
      }

      // --- Crops ---

      case 'sow_crop': {
        if (isPlaceholder(cmd.crop)) {
          return {
            messages: ['🌱 ¿Qué cultivo sembraste? (ej: soja, maíz, trigo, girasol)'],
            sideEffects: {
              setPendingActivity: { command: 'sow_crop', data: { ...cmd, _needs: 'crop' } },
            },
          };
        }
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        const plotResult = await this.resolveActivityPlot(userId, resolved);

        if (plotResult.type === 'no_plots') {
          return this.buildNoPlotsResponse(userId, 'siembra', cmd);
        }

        if (plotResult.type === 'ask_user') {
          return this.buildAskPlotResponse('siembra', plotResult.plots, cmd);
        }

        const crop = cmd.crop as string;
        const sowedHa = cmd.hectares != null ? Number(cmd.hectares) : null;
        if (sowedHa != null && sowedHa <= 0) {
          return { messages: ['⚠️ La superficie sembrada debe ser mayor a 0 ha.'] };
        }
        const { cropRow, closedPrevious } = await this.cropService.startCrop(userId, plotResult.plotId, crop, undefined, sowedHa);
        const label = formatSeasonLabel(cropRow.season_year, cropRow.season_type);
        const plotLabel = plotResult.fieldName ? `${plotResult.fieldName} > ${plotResult.plotName}` : plotResult.plotName;

        // Save domain event for planting
        await this.repo.saveDomainEvent(userId, {
          plotId: plotResult.plotId,
          plotCropId: cropRow.id,
          eventType: 'planting',
          eventDate: cmd.eventDate as Date | null,
          crop,
        });

        const msgs: string[] = [];
        if (closedPrevious) {
          msgs.push(`📋 Se cerró la campaña anterior de *${closedPrevious.crop}* en ${plotLabel}.`);
        }
        let sowMsg = `🌱 *${crop}* sembrado en *${plotLabel}*\n📅 Campaña ${label}`;
        if (sowedHa) sowMsg += `\n📐 Sembradas: ${sowedHa.toLocaleString('es-AR')} ha`;

        // Warn if sowed hectares exceed plot area
        if (sowedHa) {
          try {
            const { getPlotById } = await import('../../services/expenses.js');
            const plotInfo = await getPlotById(plotResult.plotId, userId);
            const areaHa = plotInfo?.area_hectares ? Number(plotInfo.area_hectares) : null;
            if (areaHa && sowedHa > areaHa) {
              sowMsg += `\n\n⚠️ El lote tiene *${areaHa} ha* registradas pero la siembra indica *${sowedHa} ha*. Verificá la superficie.`;
            }
          } catch { /* non-critical */ }
        }

        msgs.push(sowMsg);
        return { messages: msgs };
      }

      case 'harvest_crop': {
        // Resolve plot FIRST so we can infer crop from the plot's active or
        // recently-harvested campaign before deciding to ask the user.
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        let plotResult = await this.resolveActivityPlot(userId, resolved);

        // Per-truck loads disambiguation: when the user fires "Pedro 30tn"
        // right after harvesting, the agent emits loads[] without plot. The
        // intent is to attach to a TODAY's harvest. Prefer that over
        // last_plot_id (which could be any activity).
        const hasLoads = Array.isArray(cmd.loads) && (cmd.loads as unknown[]).length > 0;
        if (plotResult.type === 'ask_user' && hasLoads && !cmd.plotName && !cmd.fieldName) {
          const harvestsToday = await this.repo.findHarvestsToday(userId);

          if (harvestsToday.length === 1) {
            const h = harvestsToday[0];
            const field = await this.repo.getFieldByName(userId, h.field_name);
            plotResult = {
              type: 'resolved',
              plotId: h.plot_id,
              fieldId: field?.id ?? null,
              plotName: h.plot_name,
              fieldName: h.field_name,
            };
          } else if (harvestsToday.length >= 2) {
            // Multiple cosechas hoy — ask which one with crop hint
            const lines = harvestsToday.map(h => {
              const cropLabel = h.crop ? ` (${h.crop})` : '';
              return `  • *${h.plot_name}*${cropLabel} en ${h.field_name}`;
            }).join('\n');
            return {
              messages: [
                `🚛 Hoy cosechaste en *${harvestsToday.length} lotes*. ¿A cuál asigno estas cargas?\n\n${lines}\n\n_Repetí el mensaje aclarando el lote, ej: "Pedro 30 tn al silo en lote ${harvestsToday[0].plot_name}"._`,
              ],
            };
          }
          // 0 harvests today → fall through to ask_user (existing behavior)
        }

        if (plotResult.type === 'no_plots') {
          return this.buildNoPlotsResponse(userId, 'cosecha', cmd);
        }

        if (plotResult.type === 'ask_user') {
          return this.buildAskPlotResponse('cosecha', plotResult.plots, cmd);
        }

        // Crop inference: when the agent didn't pass a crop, try active first,
        // then a recently-harvested-but-no-yield campaign (so "cosechamos X kg
        // en lote Y" works even when the campaign was already closed without a
        // yield, which is exactly how users follow our "cargá el rinde" hint).
        let crop = (cmd.crop as string) ?? null;
        let retroYieldOnExisting: { id: number; crop: string } | null = null;
        if (isPlaceholder(crop)) {
          const active = await this.cropService.getActive(plotResult.plotId);
          if (active) {
            crop = active.crop;
          } else {
            const recentNoYield = await this.cropService.findRecentHarvestedNoYield(plotResult.plotId);
            if (recentNoYield) {
              crop = recentNoYield.crop;
              retroYieldOnExisting = { id: recentNoYield.id, crop: recentNoYield.crop };
            }
          }
        }

        if (isPlaceholder(crop)) {
          return {
            messages: ['🌾 ¿Qué cultivo cosechaste? (ej: soja, maíz, trigo, girasol)'],
            sideEffects: {
              setPendingActivity: { command: 'harvest_crop', data: { ...cmd, _needs: 'crop' } },
            },
          };
        }
        const yieldKgRaw = cmd.yieldKg != null ? Number(cmd.yieldKg) : null;
        const yieldKgPerHa = cmd.yieldKgPerHa != null ? Number(cmd.yieldKgPerHa) : null;
        const yieldNotes = (cmd.yieldNotes as string) || null;
        const plotLabel = plotResult.fieldName ? `${plotResult.fieldName} > ${plotResult.plotName}` : plotResult.plotName;

        // Resolve effective yield: if user gave rate (kg/ha), compute total; if total, use as-is
        let yieldKg = yieldKgRaw;
        let computedKgPerHa: number | null = null;
        if (yieldKgPerHa != null || yieldKgRaw != null) {
          const { getPlotById: getPlotForYield } = await import('../../services/expenses.js');
          const plotForYield = await getPlotForYield(plotResult.plotId, userId);
          const areaHa = plotForYield?.area_hectares ? Number(plotForYield.area_hectares) : null;

          if (yieldKgPerHa != null) {
            computedKgPerHa = yieldKgPerHa;
            yieldKg = areaHa ? Math.round(yieldKgPerHa * areaHa) : null;
          } else if (yieldKgRaw != null && areaHa) {
            computedKgPerHa = Math.round(yieldKgRaw / areaHa);
          }
        }

        // Retroactive yield-load on a recently-harvested-but-no-yield campaign
        // (active or closed). The user said "cosechamos X kg en lote Y" without
        // a crop and we matched a no-yield campaign earlier — load the yield
        // there and return, instead of trying to register a new harvest (which
        // would fail because the campaign may already be closed).
        if (retroYieldOnExisting && yieldKg != null && yieldKg > 0) {
          const updated = await this.cropService.updateYield(retroYieldOnExisting.id, yieldKg, yieldNotes);
          if (updated) {
            const kgLabel = yieldKg.toLocaleString('es-AR');
            const perHa = computedKgPerHa ? ` (${computedKgPerHa.toLocaleString('es-AR')} kg/ha)` : '';
            return { messages: [`✅ Rinde de *${retroYieldOnExisting.crop}* cargado en *${plotLabel}*: ${kgLabel} kg${perHa}`] };
          }
        }

        // Dedup: check if there's already a harvest event for this plot today
        const loads = Array.isArray(cmd.loads) ? cmd.loads as Array<{ driver_name: string; weight_kg: number; destination?: string; destinatario?: string; truck_plate?: string; humidity_pct?: number; quality_metrics?: Record<string, unknown> }> : null;
        const existingEvent = await this.repo.findTodayHarvestEvent(userId, plotResult.plotId);

        let savedEvent: { id: number; plot_crop_id?: number | null; [key: string]: unknown };
        let harvested: { id: number; season_year: number; season_type: string } | null = null;
        let isAppend = false;

        if (existingEvent) {
          // Validate crop matches before reusing existing event
          if (existingEvent.plot_crop_id) {
            const activeCrop = await this.cropService.getActive(plotResult.plotId);
            if (activeCrop && activeCrop.crop.toLowerCase() !== crop.toLowerCase()) {
              return { messages: [`En *${plotLabel}* hay *${activeCrop.crop}* sembrado, no ${crop}.\nSi querés cosechar ${activeCrop.crop}, escribí:\n🌾 *cosechamos ${activeCrop.crop.toLowerCase()} en el lote ${plotResult.plotName}*`] };
            }
            if (activeCrop) harvested = activeCrop;
          }
          // Reuse existing event — just append loads
          savedEvent = existingEvent;
          isAppend = true;
        } else {
          // Normal flow: register harvest
          const harvestedResult = await this.cropService.harvestCrop(plotResult.plotId, crop, cmd.eventDate as Date | undefined, yieldKg, yieldNotes);

          if (!harvestedResult) {
            const active = await this.cropService.getActive(plotResult.plotId);
            const lostLoadsNote = loads && loads.length > 0
              ? `\n\n⚠️ Las *${loads.length} carga${loads.length > 1 ? 's' : ''}* no se guardaron (necesitás un cultivo activo primero). Sembrá el lote y volvé a mandar el mensaje completo con las cargas.`
              : '';
            if (active) {
              return { messages: [`En *${plotLabel}* hay *${active.crop}* sembrado, no ${crop}.\nSi querés cosechar ${active.crop}, escribí:\n🌾 *cosechamos ${active.crop.toLowerCase()} en el lote ${plotResult.plotName}*${lostLoadsNote}`] };
            }
            // No active campaign. If there's a recent no-yield campaign with
            // the same crop, treat this as a retroactive yield-load instead of
            // rejecting outright. Mirrors the no-crop path above.
            if (yieldKg != null && yieldKg > 0) {
              const recentNoYield = await this.cropService.findRecentHarvestedNoYield(plotResult.plotId);
              if (recentNoYield && recentNoYield.crop.toLowerCase() === crop.toLowerCase()) {
                const updated = await this.cropService.updateYield(recentNoYield.id, yieldKg, yieldNotes);
                if (updated) {
                  const kgLabel = yieldKg.toLocaleString('es-AR');
                  const perHa = computedKgPerHa ? ` (${computedKgPerHa.toLocaleString('es-AR')} kg/ha)` : '';
                  return { messages: [`✅ Rinde de *${recentNoYield.crop}* cargado en *${plotLabel}*: ${kgLabel} kg${perHa}`] };
                }
              }
            }
            return { messages: [`No hay cultivo activo en *${plotLabel}* para cosechar.${lostLoadsNote}`] };
          }

          harvested = harvestedResult;

          // Save domain event for harvest. The agent may pass the kg total via
          // either `quantity` (older path) or `yieldKg` (the typical harvest schema);
          // fall back to the resolved yieldKg so the silo prompt still surfaces.
          const harvestQuantity = cmd.quantity ? Number(cmd.quantity) : (yieldKg ?? null);
          const harvestUnit = cmd.quantity ? ((cmd.unit as string) || 'tn') : 'kg';
          savedEvent = await this.repo.saveDomainEvent(userId, {
            plotId: plotResult.plotId,
            plotCropId: harvestedResult.id,
            eventType: 'harvest',
            eventDate: cmd.eventDate as Date | null,
            crop,
            quantity: harvestQuantity,
            unit: harvestQuantity ? harvestUnit : null,
          });
        }

        // Save loads if provided
        if (loads && loads.length > 0) {
          const plotCropId = (savedEvent.plot_crop_id as number) || null;
          await this.repo.saveHarvestLoads(savedEvent.id, plotCropId, loads);
          if (plotCropId) {
            await this.repo.updateYieldFromLoads(plotCropId);
          }

          // Build per-truck response
          const totalKg = loads.reduce((sum, l) => sum + Number(l.weight_kg), 0);
          const loadLines = loads.map(l => {
            let line = `• ${l.driver_name} — ${Number(l.weight_kg).toLocaleString('es-AR')} kg`;
            if (l.humidity_pct != null) line += ` (${l.humidity_pct}% hum)`;
            if (l.destinatario) line += ` → ${l.destinatario}`;
            else if (l.destination) line += ` → ${l.destination}`;
            return line;
          });

          // Quality summary (if any load has metrics, surface them in the response)
          const withQuality = loads.filter(l => l.quality_metrics && Object.keys(l.quality_metrics).length > 0);
          const qualityLine = withQuality.length > 0
            ? `\n\n🏷️ *Calidad:* ${withQuality.map(l => {
                const metrics = Object.entries(l.quality_metrics!)
                  .map(([k, v]) => `${k.replace(/_pct$/, '%').replace(/_/g, ' ')}: ${v}`)
                  .join(', ');
                return `${l.driver_name} → ${metrics}`;
              }).join(' · ')}`
            : '';

          const header = isAppend
            ? `🚛 *${loads.length} carga${loads.length > 1 ? 's' : ''} agregada${loads.length > 1 ? 's' : ''} en ${plotLabel}:*`
            : `🚛 *${loads.length} carga${loads.length > 1 ? 's' : ''} registrada${loads.length > 1 ? 's' : ''} en ${plotLabel}:*`;
          // Average humidity if at least one load reports it
          const humidityLoads = loads.filter(l => l.humidity_pct != null);
          const avgHumidity = humidityLoads.length > 0
            ? Math.round(humidityLoads.reduce((a, l) => a + Number(l.humidity_pct), 0) / humidityLoads.length * 10) / 10
            : null;
          const humLine = avgHumidity != null
            ? `\n💧 *Humedad promedio:* ${avgHumidity}% (${humidityLoads.length}/${loads.length} cargas)`
            : '';

          let loadsMsg = `${header}\n${loadLines.join('\n')}\n\n📊 *Total: ${totalKg.toLocaleString('es-AR')} kg*${humLine}${qualityLine}`;

          if (harvested && !isAppend) {
            const label = formatSeasonLabel(harvested.season_year, harvested.season_type);
            loadsMsg += `\n📅 Campaña ${label}`;
          }
          loadsMsg += `\n\nLa campaña sigue abierta. Cuando quieras cerrarla, decime "cerrar campaña".`;
          return { messages: [loadsMsg] };
        }

        // No loads — original behavior
        if (!harvested) {
          return { messages: [`Cosecha registrada en *${plotLabel}*.`] };
        }

        const label = formatSeasonLabel(harvested.season_year, harvested.season_type);
        let harvestMsg = `🌾 *${crop}* cosechado en *${plotLabel}*\n📅 Campaña ${label}`;
        if (yieldKg || computedKgPerHa) {
          if (yieldKg) harvestMsg += `\n📊 Rendimiento: ${yieldKg.toLocaleString('es-AR')} kg`;
          if (computedKgPerHa) harvestMsg += yieldKg ? ` (${computedKgPerHa.toLocaleString('es-AR')} kg/ha)` : `\n📊 Rendimiento: ${computedKgPerHa.toLocaleString('es-AR')} kg/ha`;
        }

        // If plot_crop has existing loads (from prior messages), surface them so the user
        // knows the info is stored and doesn't think it got lost.
        try {
          const plotCropId = (savedEvent.plot_crop_id as number) || harvested.id || null;
          if (plotCropId) {
            const existingLoads = await this.repo.getHarvestLoadsByCampaign(plotCropId);
            if (existingLoads.length > 0) {
              const totalKg = existingLoads.reduce((sum, l) => sum + Number(l.weight_kg), 0);
              harvestMsg += `\n\n📦 *${existingLoads.length} carga${existingLoads.length > 1 ? 's' : ''} registrada${existingLoads.length > 1 ? 's' : ''}* (total: ${totalKg.toLocaleString('es-AR')} kg)\nEscribí *cargas del lote ${plotResult.plotName}* para ver el detalle.`;
            }
          }
        } catch {
          // Non-critical: swallow errors so the main harvest message still goes through
        }

        harvestMsg += `\n\nLa campaña sigue abierta. Cuando quieras cerrarla, decime "cerrar campaña".`;
        const messages = [harvestMsg];

        // If quantity provided, suggest loading grain to stock/silo. Same
        // fallback as the saveDomainEvent block above.
        const harvestQuantity = cmd.quantity ? Number(cmd.quantity) : (yieldKg ?? null);
        const harvestUnit = cmd.quantity ? ((cmd.unit as string) || 'tn') : 'kg';
        if (harvestQuantity && harvestQuantity > 0) {
          try {
            const { FeatureGate } = await import('../billing/feature-gate.js');
            const fg = new FeatureGate();
            const hasStock = await fg.hasFeature(userId, 'stock');
            if (hasStock) {
              const warehouseName = (cmd.warehouseName as string) || undefined;
              const fmtQty = formatQuantityHuman(harvestQuantity, harvestUnit);
              messages.push(`\n📦 ¿Querés cargar *${fmtQty}* de *${crop}* al ${warehouseName ? `silo *${warehouseName}*` : 'stock'}?`);
              return {
                messages,
                interactive: {
                  type: 'buttons',
                  body: `Cargar ${fmtQty} de ${crop} al stock?`,
                  buttons: [
                    { id: `stock_grain_yes_${savedEvent.id}`, title: 'Sí, cargar' },
                    { id: `stock_grain_no_${savedEvent.id}`, title: 'No' },
                  ],
                },
                sideEffects: {
                  setPendingStockEntry: {
                    type: 'grain',
                    domainEventId: savedEvent.id,
                    crop,
                    quantity: harvestQuantity,
                    unit: harvestUnit,
                    fieldId: plotResult.fieldId || 0,
                    warehouseName: warehouseName || undefined,
                  },
                },
              };
            }
          } catch (stockErr) { console.error('[agronomy] Stock grain suggestion failed:', stockErr); logError('agronomy', 'STOCK_GRAIN_SUGGEST', stockErr as Error, { userId }); }
        }

        return { messages };
      }

      case 'active_crop': {
        // If plot specified → show that plot's active crop detail
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );

        if (resolved.plotId) {
          const active = await this.cropService.getActive(resolved.plotId);
          const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

          if (!active) {
            // Helpful hint so the user has a path forward — the chaos persona
            // hit "No hay campañas activas" repeated 4+ times without knowing
            // how to start one.
            return { messages: [`No hay cultivo activo en *${plotLabel}*.\n\n_Para sembrar: "sembré soja en ${resolved.plotName}" (o cambiá el cultivo)._`] };
          }

          const label = formatSeasonLabel(active.season_year, active.season_type);
          const stateLabel = getCampaignStateLabel(active);
          const lines: string[] = [`🌱 *${active.crop}* en *${plotLabel}*`];
          lines.push(`📅 Campaña ${label} — ${stateLabel}`);

          const { getPlotById } = await import('../../services/expenses.js');
          const plotInfo = await getPlotById(resolved.plotId);
          const sowedHa = active.sowed_hectares ? Number(active.sowed_hectares) : null;
          const plotHa = plotInfo?.area_hectares ? Number(plotInfo.area_hectares) : null;
          const effectiveHa = sowedHa ?? plotHa;
          if (sowedHa && plotHa && sowedHa < plotHa) {
            lines.push(`📐 Sembradas: ${sowedHa.toLocaleString('es-AR')} ha (de ${plotHa.toLocaleString('es-AR')} ha totales)`);
          } else if (effectiveHa) {
            lines.push(`📐 Superficie: ${effectiveHa.toLocaleString('es-AR')} ha`);
          }
          if (active.start_date) {
            lines.push(`🗓️ Siembra: ${formatDateAR(active.start_date)}`);
          }
          if (active.harvested_at) {
            lines.push(`🌾 Cosecha: ${formatDateAR(active.harvested_at)}`);
          }
          if (active.yield_kg) {
            const yieldStr = Number(active.yield_kg).toLocaleString('es-AR');
            const kgPerHa = effectiveHa ? Math.round(Number(active.yield_kg) / effectiveHa) : null;
            let yieldLine = `📊 Rendimiento: ${yieldStr} kg`;
            if (kgPerHa) yieldLine += ` (${kgPerHa.toLocaleString('es-AR')} kg/ha)`;
            lines.push(yieldLine);
          }
          return { messages: [lines.join('\n')] };
        }

        // No plot specified → list all active crops, optionally filtered by crop name and/or grupo
        const rawCrop = cmd.crop as string | null;
        const cropFilter = rawCrop ? (detectCropFromText(rawCrop) || rawCrop) : null;
        const grupoFilter = cmd.grupo as string | null;
        const allActive = await this.cropService.listActiveCrops(userId, cropFilter, grupoFilter);

        if (allActive.length === 0) {
          const filterMsg = cropFilter ? ` de *${cropFilter}*` : '';
          const grupoMsg = grupoFilter ? ` en grupo *${grupoFilter}*` : '';
          return {
            messages: [`No hay campañas activas${filterMsg}${grupoMsg}.\n\n_Para sembrar: "sembré ${cropFilter || 'soja'} en lote X". Para ver historial: "historial del lote X"._`],
            suggestionKey: 'crop_empty',
          };
        }

        // Compute totals — prefer sowed_hectares, fallback to area_hectares
        let totalHa = 0;
        let totalYieldKg = 0;
        let totalActivities = 0;
        for (const row of allActive) {
          const ha = row.sowed_hectares ? Number(row.sowed_hectares) : (row.area_hectares ? Number(row.area_hectares) : 0);
          totalHa += ha;
          if (row.yield_kg) totalYieldKg += Number(row.yield_kg);
          if (row.activity_count) totalActivities += Number(row.activity_count);
        }

        // Header with summary
        const cropLabel = cropFilter ? `${cropFilter}` : 'Cultivos activos';
        const lines: string[] = [`🌱 *${cropLabel}*`];

        // Summary line
        const summaryParts: string[] = [];
        summaryParts.push(`${allActive.length} lote${allActive.length > 1 ? 's' : ''}`);
        if (totalHa > 0) summaryParts.push(`${totalHa.toLocaleString('es-AR')} ha`);
        lines.push(summaryParts.join(' · '));

        // Default to detail when few results; regex fallback for large lists
        const acOriginal = ((cmd.originalText as string) || '').toLowerCase();
        const wantDetail = allActive.length <= 15 || /qu?[eé]?\s*(lotes|cultivos|son|hay)|en\s*qu[eé]|d[oó]nde|detalle|desglose|cu[aá]les/.test(acOriginal);

        if (wantDetail) {
          if (totalYieldKg > 0) {
            let yieldSummary = `📊 Rinde total: ${totalYieldKg.toLocaleString('es-AR')} kg`;
            if (totalHa > 0) yieldSummary += ` (${Math.round(totalYieldKg / totalHa).toLocaleString('es-AR')} kg/ha)`;
            lines.push(yieldSummary);
          }

          lines.push('');
          for (const row of allActive) {
            const label = formatSeasonLabel(row.season_year, row.season_type);
            const stateLabel = getCampaignStateLabel(row);
            const plotLabel = `${row.field_name} > ${row.plot_name}`;
            const sowedHa = row.sowed_hectares ? Number(row.sowed_hectares) : null;
            const plotHa = row.area_hectares ? Number(row.area_hectares) : null;
            const effectiveHa = sowedHa ?? plotHa;
            const haStr = effectiveHa ? `${effectiveHa.toLocaleString('es-AR')} ha` : '';

            let detailLine = `${stateLabel} *${row.crop}* en *${plotLabel}*`;
            if (haStr) detailLine += ` — ${haStr}`;
            detailLine += ` — ${label}`;

            const extras: string[] = [];
            if (row.yield_kg) {
              const kgPerHa = effectiveHa ? Math.round(Number(row.yield_kg) / effectiveHa) : null;
              extras.push(`rinde: ${Number(row.yield_kg).toLocaleString('es-AR')} kg${kgPerHa ? ` (${kgPerHa.toLocaleString('es-AR')} kg/ha)` : ''}`);
            }
            if (row.last_activity_date && row.last_activity_type) {
              const { label: actLabel } = getActivityLabel(row.last_activity_type);
              extras.push(`últ: ${actLabel} ${formatDateAR(row.last_activity_date)}`);
            }
            if (extras.length > 0) detailLine += `\n    ${extras.join(' · ')}`;

            lines.push(detailLine);
          }
        }

        return { messages: [lines.join('\n')] };
      }

      case 'crop_history': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Escribí algo como:\n📋 *historial lote 3*'] };
        }

        const history = await this.cropService.getHistory(resolved.plotId);
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

        if (history.length === 0) {
          return { messages: [`No hay historial de cultivos en *${plotLabel}*.`] };
        }

        let msg = `📋 *Historial de cultivos — ${plotLabel}*\n`;
        for (const row of history) {
          const label = formatSeasonLabel(row.season_year, row.season_type);
          const stateLabel = getCampaignStateLabel(row);
          msg += `\n${stateLabel} *${row.crop}* — Campaña ${label}`;
        }
        return { messages: [msg] };
      }

      case 'close_campaign': {
        const resolved = await this.plotDiscovery.resolveFromNamesWithContext(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Indicá el lote de la campaña que querés cerrar.'] };
        }

        const active = await this.cropService.getActive(resolved.plotId);
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

        if (!active) {
          return { messages: [`No hay campaña abierta en *${plotLabel}*.`] };
        }

        // If crop specified, verify match
        if (cmd.crop && active.crop.toLowerCase() !== (cmd.crop as string).toLowerCase()) {
          return { messages: [`La campaña activa en *${plotLabel}* es de *${active.crop}*, no de ${cmd.crop}.`] };
        }

        const closed = await this.cropService.closeCampaign(active.id);
        if (!closed) {
          return { messages: ['No se pudo cerrar la campaña.'] };
        }

        const label = formatSeasonLabel(closed.season_year, closed.season_type);
        const startDate = new Date(closed.start_date);
        const endDate = new Date(closed.end_date!);
        const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        return { messages: [`✅ Campaña de *${closed.crop}* en *${plotLabel}* cerrada.\n📅 Campaña ${label} — ${days} días`] };
      }

      case 'campaign_stats': {
        const stats = await this.campaignStatsService.getCampaignStats(
          userId,
          cmd.plotName as string | null,
          cmd.fieldName as string | null,
          cmd.crop as string | null,
          cmd.seasonYear as string | null,
        );

        if (typeof stats === 'string') {
          return { messages: [stats] };
        }

        return { messages: [this.formatCampaignStats(stats)] };
      }

      case 'compare_campaigns': {
        const comparison = await this.campaignStatsService.compareCampaigns(
          userId,
          cmd.plotName as string | null,
          cmd.fieldName as string | null,
          cmd.crop as string | null,
          cmd.seasonYear1 as string | null,
          cmd.seasonYear2 as string | null,
        );

        if (typeof comparison === 'string') {
          return { messages: [comparison] };
        }

        return { messages: [this.formatCampaignComparison(comparison)] };
      }

      case 'activity_stats': {
        // Redirect to the unified handler — activity_stats becomes a view='aggregate' on activities.
        // Map legacy activityFilter to the new activityTypes shape, then dispatch.
        if (cmd.activityFilter && !cmd.activityTypes) {
          const legacyMap: Record<string, string> = {
            'log_spraying': 'spraying', 'log_fertilization': 'fertilization',
            'sow_crop': 'planting', 'harvest_crop': 'harvest',
            'log_tillage': 'tillage', 'log_irrigation': 'irrigation',
            'spraying': 'spraying', 'fertilization': 'fertilization', 'planting': 'planting',
            'harvest': 'harvest', 'tillage': 'tillage', 'irrigation': 'irrigation',
          };
          const t = legacyMap[cmd.activityFilter as string];
          if (t) cmd.activityTypes = [t];
        }
        if (cmd.view == null) cmd.view = 'aggregate';
        return this.handleQueryActivities(cmd, userId);
      }

      case '_activity_stats_legacy_disabled': {
        let statsFieldId: number | null = null;
        let statsPlotId: number | null = null;
        let statsLocationLabel: string | null = null;

        if (cmd.plotName || cmd.fieldName) {
          const resolved = await this.plotDiscovery.resolveFromNames(
            userId,
            cmd.fieldName as string | null,
            cmd.plotName as string | null,
          );
          statsFieldId = resolved.fieldId ?? null;
          statsPlotId = resolved.plotId ?? null;
          statsLocationLabel = resolved.plotName
            ? (resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName)
            : resolved.fieldName ?? null;
        }

        if (cmd.grupo && !statsLocationLabel) {
          statsLocationLabel = `grupo ${cmd.grupo}`;
        }

        const actFilter = normalizeActivityFilter(cmd.activityFilter as string | null);

        const rows = await this.repo.getActivityStats(userId, {
          fieldId: statsFieldId,
          plotId: statsPlotId,
          activityFilter: actFilter,
          desde: cmd.desde as string | null,
          hasta: cmd.hasta as string | null,
          grupo: cmd.grupo as string | null,
        });

        if (rows.length === 0) {
          let emptyMsg = 'No hay actividades registradas';
          if (statsLocationLabel) emptyMsg += ` en *${statsLocationLabel}*`;
          if (cmd.desde || cmd.hasta) emptyMsg += ' en el período indicado';
          emptyMsg += '.';
          return { messages: [emptyMsg] };
        }

        // Aggregate by event_type (rows may have per-plot breakdown)
        const byType = new Map<string, { count: number; earliest: string; latest: string }>();
        let totalCount = 0;
        let globalEarliest: string | null = null;
        let globalLatest: string | null = null;

        for (const row of rows) {
          totalCount += row.count;
          const existing = byType.get(row.event_type);
          if (existing) {
            existing.count += row.count;
            if (row.earliest < existing.earliest) existing.earliest = row.earliest;
            if (row.latest > existing.latest) existing.latest = row.latest;
          } else {
            byType.set(row.event_type, { count: row.count, earliest: row.earliest, latest: row.latest });
          }
          if (!globalEarliest || row.earliest < globalEarliest) globalEarliest = row.earliest;
          if (!globalLatest || row.latest > globalLatest) globalLatest = row.latest;
        }

        const lines: string[] = [];
        let title = '📊 *Resumen de actividades*';
        if (statsLocationLabel) title += ` — ${statsLocationLabel}`;
        lines.push(title);

        if (globalEarliest && globalLatest) {
          lines.push(`📅 ${formatDateAR(globalEarliest)} — ${formatDateAR(globalLatest)}`);
        }
        lines.push('');

        for (const [type, data] of byType) {
          const { emoji, label } = getActivityLabel(type);
          lines.push(`${emoji} ${label}: *${data.count}*`);
        }

        lines.push('');
        lines.push(`*Total: ${totalCount} actividades*`);

        return { messages: [lines.join('\n')] };
      }

      case 'query_harvest_loads': {
        return this.handleQueryHarvestLoads(cmd, userId);
      }

      case 'delete_harvest_loads': {
        if (!cmd.plotName) {
          return { messages: ['Necesito saber de qué lote eliminar las cargas.'] };
        }

        const delResolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null,
        );
        if (!delResolved.plotId) {
          return { messages: [`No encontré el lote *${cmd.plotName}*.`] };
        }

        const delOpts: { eventDate?: string; driverNames?: string[]; onlyWithoutDestination?: boolean } = {};
        if (cmd.eventDate) delOpts.eventDate = cmd.eventDate as string;
        if (cmd.driverNames && Array.isArray(cmd.driverNames)) delOpts.driverNames = cmd.driverNames as string[];
        if (cmd.onlyWithoutDestination) delOpts.onlyWithoutDestination = true;

        const deleted = await this.repo.deleteHarvestLoads(userId, delResolved.plotId, delOpts);

        if (deleted.length === 0) {
          return { messages: ['No se encontraron cargas que coincidan con los criterios para eliminar.'] };
        }

        const delTotal = deleted.reduce((sum, r) => sum + Number(r.weight_kg), 0);
        const delLines: string[] = [];
        const delLabel = delResolved.fieldName
          ? `${delResolved.fieldName} > ${delResolved.plotName}`
          : delResolved.plotName;
        delLines.push(`🗑️ *${deleted.length} carga${deleted.length > 1 ? 's' : ''} eliminada${deleted.length > 1 ? 's' : ''} de ${delLabel}:*`);
        for (const r of deleted) {
          let line = `• ${r.driver_name} — ${Number(r.weight_kg).toLocaleString('es-AR')} kg`;
          if (r.destinatario) line += ` → ${r.destinatario}`;
          delLines.push(line);
        }
        delLines.push('');
        delLines.push(`📊 *Total eliminado: ${delTotal.toLocaleString('es-AR')} kg*`);

        return { messages: [delLines.join('\n')] };
      }

      // --- Agronomic activities ---

      case 'log_spraying':
      case 'log_fertilization':
      case 'log_tillage':
      case 'log_irrigation': {
        const eventTypeMap: Record<string, ActivityType> = {
          log_spraying: 'spraying',
          log_fertilization: 'fertilization',
          log_tillage: 'tillage',
          log_irrigation: 'irrigation',
        };
        const eventType = eventTypeMap[cmd.command];
        const { label: actLabel } = getActivityLabel(eventType);

        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        const plotResult = await this.resolveActivityPlot(userId, resolved);

        if (plotResult.type === 'no_plots') {
          return this.buildNoPlotsResponse(userId, actLabel.toLowerCase(), cmd);
        }

        if (plotResult.type === 'ask_user') {
          return this.buildAskPlotResponse(actLabel.toLowerCase(), plotResult.plots, cmd);
        }

        const activeCrop = await this.cropService.getActive(plotResult.plotId);
        const crop = inferCrop(
          cmd.crop as string | null,
          activeCrop,
          cmd.product as string | null,
        );

        const savedEvent = await this.repo.saveDomainEvent(userId, {
          plotId: plotResult.plotId,
          plotCropId: activeCrop?.id || null,
          eventType,
          eventDate: cmd.eventDate as Date | null,
          crop,
          product: cmd.product as string | null,
          productType: cmd.productType as string | null,
          quantity: cmd.quantity as number | null,
          unit: cmd.unit as string | null,
          implement: cmd.implement as string | null,
        });

        const plotLabel = plotResult.fieldName
          ? `${plotResult.fieldName} > ${plotResult.plotName}`
          : plotResult.plotName;

        const confirmation = formatActivityConfirmation(eventType, plotLabel, {
          product: cmd.product as string | null,
          productType: cmd.productType as string | null,
          quantity: cmd.quantity as number | null,
          unit: cmd.unit as string | null,
          crop,
          implement: cmd.implement as string | null,
          eventDate: cmd.eventDate as Date | null,
        });

        // Suggest stock deduction for spraying/fertilization with product
        if ((eventType === 'spraying' || eventType === 'fertilization') && cmd.product && savedEvent?.id) {
          try {
            const { StockDeductionService } = await import('../stock/stock-deduction.service.js');
            const deductionService = new StockDeductionService();

            // Get plot hectares for dose calculation
            let plotHectares: number | undefined;
            if (plotResult.plotId) {
              const { getPlotById } = await import('../../services/expenses.js');
              const plotInfo = await getPlotById(plotResult.plotId);
              plotHectares = plotInfo?.area_hectares || undefined;
            }

            const dosePerHa = cmd.unit && typeof cmd.unit === 'string' && (cmd.unit as string).includes('/ha')
              ? (cmd.quantity as number) : undefined;

            const suggestion = await deductionService.suggestDeduction(
              userId,
              savedEvent.id,
              cmd.product as string,
              dosePerHa && plotHectares ? dosePerHa * plotHectares : cmd.quantity as number | undefined,
              (cmd.unit as string || '').replace('/ha', '') || undefined,
              plotResult.fieldId || undefined,
              plotHectares,
              dosePerHa,
            );

            if (suggestion) {
              const messages = [confirmation];
              const stockMsg = suggestion.totalQuantity > 0
                ? `\n📦 Tenés ${suggestion.currentStock} ${suggestion.unit} de *${suggestion.product}* en ${suggestion.warehouseName}.\n¿Descontar *${suggestion.totalQuantity} ${suggestion.unit}*?`
                : `\n📦 Tenés ${suggestion.currentStock} ${suggestion.unit} de *${suggestion.product}* en ${suggestion.warehouseName}.\n¿Descontar del stock?`;
              messages.push(stockMsg);
              return {
                messages,
                interactive: {
                  type: 'buttons' as const,
                  body: messages.join('\n'),
                  buttons: [
                    { id: `stock_deduct_yes_${savedEvent.id}`, title: 'Sí, descontar' },
                    { id: `stock_deduct_no_${savedEvent.id}`, title: 'No' },
                  ],
                },
                sideEffects: {
                  setPendingStockDeduction: suggestion,
                } as any,
              };
            }
          } catch (stockErr) {
            console.error('[stock-deduction] Error suggesting deduction:', stockErr);
            logError('agronomy', 'STOCK_DEDUCTION_SUGGEST', stockErr as Error, { userId });
          }
        }

        return { messages: [confirmation] };
      }

      case 'log_tacto': {
        // Corral path: if corralName is provided, resolve via FeedlotService
        const corralName = cmd.corralName as string | null;
        let tactoPlotId: number | null = null;
        let tactoCorralId: number | null = null;
        let tactoLabel: string | null = null;

        if (corralName) {
          try {
            const feedlotService = new FeedlotService();
            const corralRef = await feedlotService.resolveCorral(userId, corralName, cmd.fieldName as string | null);
            tactoCorralId = corralRef.corralId;
            tactoLabel = `Feedlot ${corralRef.feedlotName} > ${corralRef.corralName}`;
          } catch (err: unknown) {
            return { messages: [(err as Error).message] };
          }
        } else {
          // Standard plot resolution path
          const resolved = await this.plotDiscovery.resolveFromNames(
            userId,
            cmd.fieldName as string | null,
            cmd.plotName as string | null
          );
          const plotResult = await this.resolveActivityPlot(userId, resolved);

          if (plotResult.type === 'no_plots') {
            return this.buildNoPlotsResponse(userId, 'tacto', cmd);
          }

          if (plotResult.type === 'ask_user') {
            return this.buildAskPlotResponse('tacto', plotResult.plots, cmd);
          }

          tactoPlotId = plotResult.plotId;
          tactoLabel = plotResult.fieldName
            ? `${plotResult.fieldName} > ${plotResult.plotName}`
            : plotResult.plotName;
        }

        // Extract counts
        let pregnantCount = typeof cmd.pregnantCount === 'number' ? cmd.pregnantCount : null;
        let openCount = typeof cmd.openCount === 'number' ? cmd.openCount : null;
        let uncertainCount = typeof cmd.uncertainCount === 'number' ? cmd.uncertainCount : null;
        let totalChecked = typeof cmd.totalChecked === 'number' ? cmd.totalChecked : null;

        // Auto-compute total from parts if not provided
        if (totalChecked == null && pregnantCount != null) {
          totalChecked = (pregnantCount || 0) + (openCount || 0) + (uncertainCount || 0);
        }

        // Auto-compute open from total - pregnant - uncertain when open not provided
        if (openCount == null && totalChecked != null && pregnantCount != null) {
          openCount = totalChecked - pregnantCount - (uncertainCount || 0);
          if (openCount < 0) openCount = 0;
        }

        const category = typeof cmd.category === 'string' ? cmd.category : null;

        await this.repo.saveDomainEvent(userId, {
          plotId: tactoPlotId,
          corralId: tactoCorralId,
          eventType: 'tacto',
          eventDate: cmd.eventDate as Date | null,
          quantity: totalChecked,
          product: category, // vaca/vaquillona stored in product field
          implement: cmd.implement as string | null,
          notes: cmd.notes as string | null,
          pregnantCount,
          openCount,
          uncertainCount,
        });

        // Build confirmation message
        const lines: string[] = ['🩺 *Tacto* registrado'];
        lines.push(`📍 ${tactoLabel}`);
        if (totalChecked != null) {
          const catLabel = category ? ` ${category}s` : '';
          lines.push(`🐄 ${totalChecked}${catLabel} revisadas`);
        }
        if (pregnantCount != null) lines.push(`✅ Preñadas: *${pregnantCount}*`);
        if (openCount != null && openCount > 0) lines.push(`❌ Vacías: *${openCount}*`);
        if (uncertainCount != null && uncertainCount > 0) lines.push(`❓ Dudosas: *${uncertainCount}*`);

        // Pregnancy rate
        if (pregnantCount != null && totalChecked != null && totalChecked > 0) {
          const rate = Math.round((pregnantCount / totalChecked) * 100);
          lines.push(`📊 Tasa de preñez: *${rate}%*`);
        }

        if (cmd.implement) lines.push(`👨‍⚕️ Veterinario: ${cmd.implement}`);
        if (cmd.notes) lines.push(`📝 ${cmd.notes}`);

        // Show date if not today
        if (cmd.eventDate) {
          const dateStr = new Date(cmd.eventDate as string).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          lines.push(`📅 ${dateStr}`);
        }

        return { messages: [lines.join('\n')] };
      }

      case 'tacto_summary': {
        // Resolve optional field/plot/corral
        let summaryFieldId: number | null = null;
        let summaryPlotId: number | null = null;
        let summaryCorralId: number | null = null;
        let summaryLocationName: string | null = null;

        const summaryCorralName = cmd.corralName as string | null;

        if (summaryCorralName) {
          try {
            const feedlotService = new FeedlotService();
            const corralRef = await feedlotService.resolveCorral(userId, summaryCorralName, cmd.fieldName as string | null);
            summaryCorralId = corralRef.corralId;
            summaryFieldId = corralRef.fieldId;
            summaryLocationName = `Feedlot ${corralRef.feedlotName} > ${corralRef.corralName}`;
          } catch (err: unknown) {
            return { messages: [(err as Error).message] };
          }
        } else if (cmd.plotName || cmd.fieldName) {
          const resolved = await this.plotDiscovery.resolveFromNames(
            userId,
            cmd.fieldName as string | null,
            cmd.plotName as string | null,
          );
          summaryFieldId = resolved.fieldId ?? null;
          summaryPlotId = resolved.plotId ?? null;
          summaryLocationName = resolved.plotName ?? null;
        }

        const rows = await this.repo.getTactoSummary(userId, {
          fieldId: summaryFieldId,
          plotId: summaryPlotId,
          corralId: summaryCorralId,
          desde: cmd.desde as string | null,
          hasta: cmd.hasta as string | null,
        });

        if (rows.length === 0) {
          return { messages: ['No hay registros de tacto' + (summaryLocationName ? ` en *${summaryLocationName}*` : '') + '.'] };
        }

        // Aggregate totals across all rows
        let grandPregnant = 0;
        let grandOpen = 0;
        let grandUncertain = 0;
        let grandChecked = 0;
        let minDate: string | null = null;
        let maxDate: string | null = null;

        for (const row of rows) {
          grandPregnant += row.total_pregnant;
          grandOpen += row.total_open;
          grandUncertain += row.total_uncertain;
          grandChecked += row.total_checked;
          const d = row.event_date;
          if (!minDate || d < minDate) minDate = d;
          if (!maxDate || d > maxDate) maxDate = d;
        }

        const rate = grandChecked > 0 ? Math.round((grandPregnant / grandChecked) * 100) : 0;

        // Date label
        let dateLabel: string;
        if (cmd.desde && cmd.hasta) {
          dateLabel = `${formatDateAR(cmd.desde as string)} — ${formatDateAR(cmd.hasta as string)}`;
        } else if (minDate === maxDate) {
          dateLabel = `último tacto (${formatDateAR(minDate!)})`;
        } else {
          dateLabel = `${formatDateAR(minDate!)} — ${formatDateAR(maxDate!)}`;
        }

        // Single-location view (specific plot or corral)
        if (summaryPlotId || summaryCorralId) {
          const lines: string[] = [
            `🩺 *Tacto — ${summaryLocationName}*`,
            `📅 ${dateLabel}`,
            '',
            `🐄 ${grandChecked} revisadas`,
            `✅ Preñadas: ${grandPregnant}`,
            `❌ Vacías: ${grandOpen}`,
          ];
          if (grandUncertain > 0) lines.push(`❓ Dudosas: ${grandUncertain}`);
          lines.push(`📊 Tasa de preñez: *${rate}%*`);
          return { messages: [lines.join('\n')] };
        }

        // Global summary with per-location breakdown
        const lines: string[] = [
          '🩺 *Resumen de tacto*',
          `📅 Periodo: ${dateLabel}`,
          '',
          `🐄 ${grandChecked} vacas revisadas`,
          `✅ Preñadas: ${grandPregnant}`,
          `❌ Vacías: ${grandOpen}`,
        ];
        if (grandUncertain > 0) lines.push(`❓ Dudosas: ${grandUncertain}`);
        lines.push(`📊 Tasa de preñez: *${rate}%*`);

        // Group by location (plot or corral) for breakdown
        const locationMap = new Map<string, { checked: number; pregnant: number }>();
        for (const row of rows) {
          const key = row.corral_name
            ? `${row.feedlot_name || 'Feedlot'} > ${row.corral_name}`
            : (row.plot_name || 'Sin lote');
          const existing = locationMap.get(key) || { checked: 0, pregnant: 0 };
          existing.checked += row.total_checked;
          existing.pregnant += row.total_pregnant;
          locationMap.set(key, existing);
        }

        if (locationMap.size > 1) {
          lines.push('', '📍 *Por ubicación:*');
          for (const [name, data] of locationMap) {
            const locRate = data.checked > 0 ? Math.round((data.pregnant / data.checked) * 100) : 0;
            lines.push(`  • ${name}: ${data.checked} revisadas - ${data.pregnant} preñadas (${locRate}%)`);
          }
        }

        return { messages: [lines.join('\n')] };
      }

      case 'edit_last_activity': {
        // Normalize activity filter from AI tool enum to DB event_type
        const editFilter = normalizeActivityFilter(cmd.activityFilter as string | null);
        const editCropFilter = cmd.crop as string | null;
        const newPlotName = cmd.newPlotName as string | null;
        const newFieldName = cmd.newFieldName as string | null;
        const newCrop = cmd.newCrop as string | null;
        const newDate = cmd.newDate as string | null;
        const clearLot = !!cmd.clearLot;

        // At least one change must be specified — plot, crop, fecha, or clear_lot.
        if (!newPlotName && !newCrop && !newDate && !clearLot) {
          return { messages: ['¿Qué corregimos? Indicá el nuevo lote, cultivo o fecha. Ej:\n✏️ *la siembra era en lote B*\n✏️ *no, era maíz*\n✏️ *sin lote* (para sacar el lote)'] };
        }

        // Find last matching activity
        const lastEvent = await this.repo.findLastDomainEventFiltered(userId, {
          eventType: editFilter || undefined,
          crop: editCropFilter || undefined,
        });

        if (!lastEvent) {
          const filterDesc = editFilter ? ` de tipo ${editFilter}` : '';
          const cropDesc = editCropFilter ? ` de ${editCropFilter}` : '';
          return { messages: [`No encontré actividad reciente${filterDesc}${cropDesc} para editar.`] };
        }

        // Resolve new plot only when one was provided. Crop-only / date-only
        // edits keep the activity on its current plot. clear_lot wins → plotId=null.
        let newPlotId: number | null = null;
        let newPlotLabel: string | null = null;
        if (clearLot) {
          newPlotId = null;
          newPlotLabel = '(sin lote)';
        } else if (newPlotName) {
          const newResolved = await this.plotDiscovery.resolveFromNames(
            userId,
            newFieldName,
            newPlotName,
          );
          if (!newResolved.plotId) {
            return { messages: [`No encontré el lote *${newPlotName}*. Revisá el nombre o escribí *mis lotes*.`] };
          }
          newPlotId = newResolved.plotId;
          newPlotLabel = newResolved.fieldName
            ? `${newResolved.fieldName} > ${newResolved.plotName}`
            : newResolved.plotName;
        }

        // Build extra fields to update
        const extraFields: { crop?: string; eventDate?: string } = {};
        if (newCrop) extraFields.crop = newCrop;
        if (newDate) extraFields.eventDate = newDate;

        // Update the event (plotId may be null when the user only fixed crop/date)
        await this.repo.updateDomainEventPlot(lastEvent.id, newPlotId, userId, extraFields);

        const { label: editActLabel } = getActivityLabel(lastEvent.event_type);
        const oldPlotLabel = lastEvent.plot_name || 'sin lote';

        const editLines: string[] = [`✏️ Actividad corregida: *${editActLabel}*`];
        if (lastEvent.crop) editLines[0] += ` de *${lastEvent.crop}*`;
        if (newPlotLabel) {
          editLines.push(`📍 ${oldPlotLabel} → *${newPlotLabel}*`);
        }
        if (newCrop) editLines.push(`🌱 Cultivo: ${lastEvent.crop || '?'} → *${newCrop}*`);
        if (newDate) {
          const dateStr = new Date(newDate).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          editLines.push(`📅 Fecha: *${dateStr}*`);
        }

        return { messages: [editLines.join('\n')] };
      }

      case 'plot_activities': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Escribí algo como:\n📋 *actividades lote 3*'] };
        }

        const events = await this.repo.getDomainEventsByPlot(resolved.plotId);
        const plotLabel = resolved.fieldName
          ? `${resolved.fieldName} > ${resolved.plotName}`
          : resolved.plotName;

        if (events.length === 0) {
          return { messages: [`No hay actividades registradas en *${plotLabel}*.`] };
        }

        let msg = `📋 *Actividades — ${plotLabel}*\n`;
        for (const ev of events) {
          const { emoji, label } = getActivityLabel(ev.event_type);
          const dateStr = new Date(ev.event_date).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
          let line = `\n${emoji} *${label}* — ${dateStr}`;
          if (ev.product) line += ` — ${ev.product}`;
          if (ev.quantity && ev.unit) line += ` (${ev.quantity} ${ev.unit})`;
          if (ev.crop) line += ` — ${ev.crop}`;
          if (ev.implement) line += ` — ${ev.implement}`;
          msg += line;
        }
        return { messages: [msg], suggestionKey: 'activity_logged' };
      }

      case 'query_plot_history': {
        // Unified dispatch path: when ANY new analytical param is present, route to new handler
        const hasNewParam = cmd.view != null || cmd.activityTypes != null || cmd.productSearch != null
          || cmd.quantityMin != null || cmd.quantityMax != null || cmd.aggregateMetric != null
          || cmd.group_by != null || cmd.sort_by != null || cmd.sort_desc != null || cmd.top_n != null
          || cmd.inherit != null || cmd.compareCrop != null || cmd.comparePlot != null
          || cmd.compareField != null || cmd.compareActivityType != null;
        if (hasNewParam) return this.handleQueryActivities(cmd, userId);

        const hasFilter = !!(cmd.activityFilter || cmd.crop);
        // If no plot/field specified and no filter → ask user which lote
        // If there IS a filter (e.g. "en qué lote sembré maíz") → search all plots
        if (!cmd.plotName && !cmd.fieldName && !cmd.plotId && !hasFilter) {
          const userPlots = await this.repo.findAllUserPlots(userId);
          if (userPlots.length === 0) {
            return { messages: ['No tenés lotes creados. Primero creá un campo y un lote.'] };
          }
          if (userPlots.length === 1) {
            // Auto-select single plot
            cmd.plotName = userPlots[0].name;
          } else {
            const fieldNames = [...new Set(userPlots.map(p => p.field_name))];
            const sections = fieldNames.map(fn => ({
              title: fn,
              rows: userPlots.filter(p => p.field_name === fn).map(p => ({
                id: `cmd_historial_${p.id}`,
                title: p.name.slice(0, 24),
              })),
            }));
            return {
              messages: ['¿De qué lote querés ver el historial?'],
              interactive: { type: 'list' as const, body: 'Elegí un lote:', buttonText: 'Ver lotes', sections },
            };
          }
        }

        // If plotId provided directly (from button callback), resolve plot name
        if (cmd.plotId && !cmd.plotName) {
          const plot = await this.repo.getPlotById(cmd.plotId as number);
          if (plot) {
            cmd.plotName = plot.name;
          }
        }

        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );

        // If user specified a plot but it wasn't found, tell them instead of querying unfiltered
        if (cmd.plotName && !resolved.plotId) {
          return {
            messages: [`No encontré el lote *${cmd.plotName}*. Revisá el nombre o escribí *mis lotes* para ver los que tenés.`],
          };
        }

        const timeRef = cmd.timeRef as { desde: Date; hasta: Date } | null;
        const rawFilter = cmd.activityFilter as string | null;
        const activityFilter = normalizeActivityFilter(rawFilter);
        const cropFilter = cmd.crop as string | null;
        const isBinaryQuestion = !!(cmd.isBinaryQuestion);
        const isUltimaVez = !!(cmd.isUltimaVez);
        const hasNoFilters = !timeRef && !activityFilter && !cropFilter && !isUltimaVez && !isBinaryQuestion;

        // Smart limits: binary/última→small, no filters→recent, filtered→moderate
        const limit = (isBinaryQuestion || isUltimaVez) ? 5
          : hasNoFilters ? 10
          : 20;

        const rows = await this.repo.queryPlotHistory(userId, {
          plotId: resolved.plotId ?? null,
          fieldId: resolved.fieldId ?? null,
          desde: timeRef?.desde ?? null,
          hasta: timeRef?.hasta ?? null,
          activityFilter,
          crop: cropFilter,
          limit,
        });

        const plotLabel = resolved.plotName
          ? (resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName)
          : 'todos los lotes';

        // Derive time label from original text
        let timeLabel = '';
        if (timeRef) {
          const lower = ((cmd.originalText as string) || '').toLowerCase();
          if (/esta\s+semana/.test(lower)) timeLabel = 'esta semana';
          else if (/este\s+mes/.test(lower)) timeLabel = 'este mes';
          else if (/\bayer\b/.test(lower)) timeLabel = 'ayer';
          else if (/\bhoy\b/.test(lower)) timeLabel = 'hoy';
          else if (/semana\s+pasada/.test(lower)) timeLabel = 'la semana pasada';
          else if (/mes\s+pasado/.test(lower)) timeLabel = 'el mes pasado';
          else {
            const matchDias = lower.match(/(?:ultimos|últimos)\s+(\d+)\s+d[ií]as?/);
            if (matchDias) timeLabel = `últimos ${matchDias[1]} días`;
            const matchSemanas = lower.match(/(?:ultimas|últimas)\s+(\d+)\s+semanas?/);
            if (matchSemanas) timeLabel = `últimas ${matchSemanas[1]} semanas`;
            const matchMes = lower.match(/en\s+(\w+)/);
            if (matchMes) timeLabel = `en ${matchMes[1]}`;
          }
        }

        const crossPlot = !resolved.plotId && !resolved.fieldId;
        const msg = formatHistoryResponse(rows, {
          plotLabel,
          timeLabel,
          isUltimaVez,
          isBinaryQuestion,
          hasNoFilters,
          activityFilter,
          crossPlot,
        });

        return { messages: [msg], suggestionKey: 'query_result' };
      }

      // --- Agro Reports ---

      case 'generate_agro_report': {
        const fieldName = cmd.fieldName as string | null;
        const plotName = cmd.plotName as string | null;
        const desde = cmd.desde as string | null;
        const hasta = cmd.hasta as string | null;
        const hasDateRange = !!(desde && hasta);

        // Helper to render the user's plots inline so error messages are
        // actionable instead of "escribí mis lotes".
        const formatUserPlots = async (): Promise<string> => {
          const userPlots = await this.repo.findAllUserPlots(userId);
          if (userPlots.length === 0) return '';
          return formatPlotListGrouped(userPlots);
        };

        if (!fieldName && !plotName) {
          // Auto-resolve when the user has only 1 field with plots — no need
          // to ask which one. Otherwise list available fields/plots so the
          // user can pick.
          const userFields = await this.repo.getUserFields(userId);
          if (userFields.length === 0) {
            return { messages: ['Primero creá un campo. Ejemplo:\n📍 *agregar campo Norte en Pergamino*'] };
          }
          if (userFields.length === 1) {
            const f = await this.repo.getFieldByName(userId, userFields[0].name);
            if (f) {
              // Continue execution against this single field — proceed to the
              // body below by simulating the same path.
              cmd.fieldName = f.name;
            }
          } else {
            const fieldList = userFields.map(f => `• ${f.name}`).join('\n');
            return { messages: [`Indicá el campo o lote. Tenés ${userFields.length} campos:\n${fieldList}\n\nEjemplo:\n📋 *reporte agronómico campo ${userFields[0].name}*\n📋 *reporte agronómico lote A1*\n\nTambién podés filtrar por fecha: "reporte agro de enero a marzo".`] };
          }
        }

        const effectiveFieldName = (cmd.fieldName as string | null) ?? fieldName;
        const effectivePlotName = plotName;

        let field: { id: number; name: string } | null = null;
        let filterPlotId: number | null = null;
        let filterPlotName: string | null = null;

        if (effectivePlotName) {
          const resolved = await this.plotDiscovery.resolveFromNames(userId, effectiveFieldName, effectivePlotName);

          // Multi-field ambiguity: same plot name across 2+ fields → ask which campo
          if (resolved.needPlotSelection && resolved.needPlotSelection.plots.length > 1 && !effectiveFieldName) {
            const optList = resolved.needPlotSelection.plots.map(p => `• ${p.name}`).join('\n');
            return { messages: [`Tenés varios lotes "${effectivePlotName}". ¿De qué campo?\n${optList}\n\nEjemplo:\n📋 *reporte agro lote ${effectivePlotName} en [campo]*`] };
          }

          if (!resolved.plotId || resolved.autoCreated) {
            // Fallback: AI might have put a field name in the plot slot
            const fallbackField = await this.repo.getFieldByName(userId, effectivePlotName);
            if (fallbackField) {
              field = fallbackField;
            } else {
              const plotsList = await formatUserPlots();
              const tail = plotsList ? `\n\nTus lotes:\n${plotsList}` : '';
              return { messages: [`No encontré el lote *${effectivePlotName}*.${tail}`] };
            }
          } else {
            filterPlotId = resolved.plotId;
            filterPlotName = resolved.plotName;
            field = await this.repo.getFieldByName(userId, resolved.fieldName!);
          }
        } else if (effectiveFieldName) {
          field = await this.repo.getFieldByName(userId, effectiveFieldName);
        }

        if (!field) {
          const plotsList = await formatUserPlots();
          const tail = plotsList ? `\n\nTus lotes:\n${plotsList}` : '';
          return { messages: [`No encontré el campo *${effectiveFieldName || effectivePlotName}*.${tail}`] };
        }
        try {
          // Fetch raw activities — date-range or current week (no cap)
          let rawActivities;
          if (hasDateRange) {
            rawActivities = filterPlotId
              ? await this.repo.getDomainEventsByPlotDateRange(filterPlotId, desde!, hasta!)
              : await this.repo.getDomainEventsByFieldDateRange(field.id, desde!, hasta!);
          } else {
            rawActivities = filterPlotId
              ? await this.repo.getDomainEventsByPlot(filterPlotId)
              : await (async () => {
                  const fieldPlots = await this.repo.getPlotsByField(field!.id);
                  const plotIds = new Set(fieldPlots.map(p => p.id));
                  const allEvents = await this.repo.getDomainEventsByUser(userId);
                  return allEvents.filter(ev => ev.plot_id && plotIds.has(ev.plot_id));
                })();
          }

          const report = await generateWeeklyReport(userId, field.id, filterPlotId, {
            activities: rawActivities,
            desde: desde || undefined,
            hasta: hasta || undefined,
          });
          const pdfBuffer = fs.readFileSync(report.pdfPath);

          // Build per-plot observation breakdown
          let rawObservations;
          if (hasDateRange) {
            rawObservations = filterPlotId
              ? await getObservationsByDateRangeAndPlot(filterPlotId, desde!, hasta!)
              : await getObservationsByDateRange(field.id, desde!, hasta!);
          } else {
            rawObservations = filterPlotId
              ? await getCurrentWeekObservationsByPlot(filterPlotId)
              : await getCurrentWeekObservations(field.id);
          }

          // Deduplicate observations before rendering
          const observations = deduplicateObservations(rawObservations);

          const plotMap = new Map<string, string[]>();
          for (const obs of observations) {
            const key = obs.plot_name || 'General';
            if (!plotMap.has(key)) plotMap.set(key, []);
            plotMap.get(key)!.push(obs.observation_text);
          }
          const plotSummaries = [...plotMap.entries()].map(([pName, obs]) => ({ plotName: pName, observations: obs }));

          // Format activities for text summary (no cap)
          const recentActivities = rawActivities.map(ev => ({
            label: getActivityLabel(ev.event_type).label,
            detail: ev.product || ev.crop || '',
            plotName: ev.plot_name || 'General',
          }));

          const titleScope = filterPlotName
            ? `${field.name} > ${filterPlotName}`
            : field.name;
          const richMessage = formatAgroReportResponse({
            fieldName: field.name,
            filterPlotName,
            weekNumber: report.weekNumber,
            observationCount: observations.length,
            plotSummaries,
            recentActivities,
            desde: desde || undefined,
            hasta: hasta || undefined,
          });

          const captionPeriod = hasDateRange
            ? `${desde} a ${hasta}`
            : `Semana ${report.weekNumber}`;
          return {
            messages: [richMessage],
            attachment: {
              buffer: pdfBuffer,
              filename: report.filename,
              mime: 'application/pdf',
              caption: `Reporte Agronómico — ${titleScope} — ${captionPeriod}`,
            },
            suggestionKey: 'report_shown',
          };
        } catch (err: unknown) {
          console.error('AGRO REPORT ERROR:', (err as Error).message);
          logError('agronomy', 'AGRO_REPORT', err as Error, { userId });
          return { messages: [
            'No pude generar el PDF del reporte agronómico ahora. ' +
            'Mientras lo arreglo, podés pedir info sin PDF:\n' +
            '• *resumen del campo X* — gastos/ingresos del mes\n' +
            '• *info lote X* — cultivo + actividades + observaciones\n' +
            '• *historial del lote X* — últimas actividades',
          ] };
        }
      }

      // --- Crop scouting query ---

      case 'query_scoutings': {
        return this.handleQueryScoutings(cmd, userId);
      }

      // --- Crop scouting (structured monitoring) ---

      case 'log_crop_scouting': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );

        // Plot is required for scouting (analytics depend on it)
        if (!resolved.plotId) {
          const userPlots = await this.repo.findAllUserPlots(userId);
          if (userPlots.length === 0) return this.buildNoPlotsResponse(userId, 'monitoreo', cmd);
          if (userPlots.length === 1) {
            resolved.plotId = userPlots[0].id;
            resolved.fieldName = userPlots[0].field_name;
            resolved.plotName = userPlots[0].name;
            if (!resolved.fieldId) {
              const field = await this.repo.getFieldByName(userId, userPlots[0].field_name);
              if (field) resolved.fieldId = field.id;
            }
          } else {
            return this.buildAskPlotResponse('monitoreo', userPlots, cmd);
          }
        }

        const stageCode = cmd.stageCode ? String(cmd.stageCode).toUpperCase() : null;
        const weedSpecies = Array.isArray(cmd.weedSpecies) ? cmd.weedSpecies as string[] : null;

        // Validate stage_code against crop. Non-blocking warning so the user
        // sees a typo (e.g. soja R12) but the monitoreo still saves.
        const cropForStage = (cmd.crop as string | null) || (await this.cropService.getActive(resolved.plotId))?.crop || null;
        const stageValidation = validateStageCode(cropForStage, stageCode);

        // Derive plot_crop_id from the active campaign so analytics can filter by campaign
        const activeCrop = await this.cropService.getActive(resolved.plotId);

        const { saveCropScouting } = await import('../../services/expenses.js');
        const saved = await saveCropScouting(userId, {
          fieldId: resolved.fieldId,
          plotId: resolved.plotId,
          plotCropId: activeCrop?.id ?? null,
          scoutingDate: cmd.eventDate as string | undefined,
          stageCode,
          weedCoveragePct: cmd.weedCoveragePct as number | undefined,
          weedSpecies,
          pestSpecies: cmd.pestSpecies as string | undefined,
          pestSeverity: cmd.pestSeverity as number | undefined,
          pestAffectedPct: cmd.pestAffectedPct as number | undefined,
          soilMoisture: cmd.soilMoisture as number | undefined,
          emergencePct: cmd.emergencePct as number | undefined,
          plantDensityM2: cmd.plantDensityM2 as number | undefined,
          notes: cmd.notes as string | undefined,
        });

        // Build human-readable confirmation
        const lines: string[] = [];
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;
        lines.push(`🔍 *Monitoreo registrado* en *${plotLabel}*`);
        if (saved.stage_code) {
          lines.push(`  📐 Estadio: *${saved.stage_code}*`);
          if (!stageValidation.ok) {
            lines.push(`  ${stageValidation.warning}`);
            if (stageValidation.validRanges) lines.push(`  Estadios válidos: ${stageValidation.validRanges}`);
          }
        }
        if (saved.weed_coverage_pct != null) {
          const sp = weedSpecies && weedSpecies.length ? ` (${weedSpecies.join(', ')})` : '';
          lines.push(`  🌿 Malezas: ${saved.weed_coverage_pct}%${sp}`);
        } else if (weedSpecies && weedSpecies.length) {
          lines.push(`  🌿 Malezas: ${weedSpecies.join(', ')}`);
        }
        if (saved.pest_species) {
          const sevLabels = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
          const sevLbl = saved.pest_severity_1_5 ? ` (${sevLabels[saved.pest_severity_1_5]} ${saved.pest_severity_1_5}/5)` : '';
          const aff = saved.pest_affected_pct != null ? `, ${saved.pest_affected_pct}% afectado` : '';
          lines.push(`  🐛 Plaga: ${saved.pest_species}${sevLbl}${aff}`);
        }
        if (saved.soil_moisture_1_5 != null) {
          const moistLabels = ['', 'seco', 'algo seco', 'normal', 'húmedo', 'saturado'];
          lines.push(`  💧 Humedad suelo: ${moistLabels[saved.soil_moisture_1_5]} (${saved.soil_moisture_1_5}/5)`);
        }
        if (saved.emergence_pct != null) lines.push(`  🌱 Emergencia: ${saved.emergence_pct}%`);
        if (saved.plant_density_m2 != null) lines.push(`  🔢 Densidad: ${saved.plant_density_m2} pl/m²`);
        if (saved.notes) lines.push(`  📝 ${saved.notes}`);

        return { messages: [lines.join('\n')] };
      }

      // --- Observations ---

      case 'log_observation': {
        const obsFieldName = cmd.fieldName as string | null;
        const obsPlotName = cmd.plotName as string | null;
        const obsText = cmd.observation as string;
        const prefixDetected = !!(cmd as any).prefixDetected;

        if (!obsText) {
          return { messages: ['No pude detectar la observación. Ejemplo:\n🔍 *observación lote 3: hay presencia de rama negra*'] };
        }

        // Safety guard: don't persist questions or follow-ups as observations
        // Bypassed when observation prefix was explicitly detected
        if (isLikelyQuestionOrFollowUp(obsText, prefixDetected)) {
          // Livestock-looking text: point user at livestock commands directly
          if (!prefixDetected && isLikelyLivestockMessage(obsText)) {
            return {
              messages: [
                '🐄 ¿Querías registrar hacienda?\n\n' +
                'Ejemplos:\n' +
                '👉 *agregué 20 vacas al lote A1*\n' +
                '👉 *vendí 5 novillos del lote 1B*\n' +
                '👉 *cuántos animales tengo*',
              ],
              suggestionKey: 'default_menu',
            };
          }
          return {
            messages: [
              'No entendí si querías registrar una observación o consultar algo.\n\n' +
              'Podés escribir por ejemplo:\n' +
              '👉 "observación lote 3: malezas"\n\n' +
              'O preguntarme algo como:\n' +
              '👉 "qué pasó en el lote 3?"',
            ],
            suggestionKey: 'default_menu',
          };
        }

        const resolved = await this.plotDiscovery.resolveFromNames(userId, obsFieldName, obsPlotName);

        // HYBRID plot assignment: auto-assign if single plot, ask if multiple, block if none
        if (!resolved.plotId) {
          const userPlots = await this.repo.findAllUserPlots(userId);

          if (userPlots.length === 0) {
            console.log(`[HYBRID] No plots → blocking observation for user ${userId}`);
            return {
              messages: ['Primero necesitás crear un lote.\n\nEjemplo:\n👉 *agregar lote 1*'],
              suggestionKey: 'default_menu',
            };
          }

          if (userPlots.length === 1) {
            // Auto-assign: single plot, no ambiguity
            resolved.plotId = userPlots[0].id;
            resolved.fieldName = userPlots[0].field_name;
            resolved.plotName = userPlots[0].name;
            // Ensure fieldId is set
            if (!resolved.fieldId) {
              const field = await this.repo.getFieldByName(userId, userPlots[0].field_name);
              if (field) resolved.fieldId = field.id;
            }
            console.log(`[HYBRID] Auto-assigned plot_id=${resolved.plotId} (single plot) for user ${userId}`);
          } else {
            // Multiple plots: ask user to specify, save pending observation for follow-up
            console.log(`[HYBRID] Multiple plots (${userPlots.length}) → asking user ${userId}`);
            const category = detectObservationCategory(obsText);
            return {
              messages: [`¿En qué lote?\n\n${formatPlotListGrouped(userPlots)}\n\nEjemplo:\n👉 *observación lote 1: ${obsText}*`],
              suggestionKey: 'default_menu',
              sideEffects: {
                setPendingObservation: { text: obsText, category },
              },
            };
          }
        }

        const category = detectObservationCategory(obsText);

        const saved = await saveObservation(userId, {
          fieldId: resolved.fieldId,
          plotId: resolved.plotId,
          text: obsText,
          category,
          source: 'text',
          observationDate: cmd.eventDate as string | null,
        });

        // Typed rejection handling
        if (saved === SAVE_REJECTED_FINANCIAL) {
          return {
            messages: ['Eso parece un gasto o ingreso, no una observación agronómica.\n\nPara registrar un gasto escribí algo como:\n💰 *gasté 50mil en gasoil*'],
            suggestionKey: 'default_menu',
          };
        }
        if (saved === SAVE_REJECTED_DUPLICATE) {
          return {
            messages: ['Observación duplicada detectada'],
          };
        }
        if (saved === SAVE_REJECTED_NO_PLOT) {
          return {
            messages: ['No se pudo guardar la observación sin lote. Indicá el lote.\n\nEjemplo:\n👉 *observación lote 1: malezas*'],
            suggestionKey: 'default_menu',
          };
        }

        let locationLabel = 'General';
        if (resolved.plotName && resolved.fieldName) {
          locationLabel = `${resolved.fieldName} > ${resolved.plotName}`;
        } else if (resolved.fieldName) {
          locationLabel = resolved.fieldName;
        } else if (resolved.plotName) {
          locationLabel = resolved.plotName;
        }

        const message = formatObservationResponse({
          locationLabel,
          plotName: resolved.plotName,
          category,
          observationText: saved.observation_text,
        });
        return { messages: [message], suggestionKey: 'observation_logged' };
      }

      case 'share_report': {
        const { ReportShareService } = await import('../../services/report-share.service.js');
        const reportService = new ReportShareService();

        const reportType = cmd.reportType as string;
        let result;

        if (reportType === 'campaign') {
          result = await reportService.generateCampaignPDF(
            userId,
            cmd.plotName as string | null,
            cmd.fieldName as string | null,
            cmd.crop as string | null,
          );
        } else {
          result = await reportService.generateFinancialPDF(
            userId,
            cmd.fieldName as string | null,
            cmd.period as string | null,
          );
        }

        if (typeof result === 'string') {
          return { messages: [result] };
        }

        return {
          messages: [`📄 Reporte generado: *${result.filename}*`],
          attachment: {
            buffer: result.buffer,
            filename: result.filename,
            mime: result.mime,
            caption: `📄 ${reportType === 'campaign' ? 'Campaña' : 'Reporte Financiero'} — ${result.filename}`,
          },
        };
      }

      default:
        return { messages: ['No pude procesar ese comando agronómico. Escribí *menú agro* para ver las opciones.'] };
    }
  }

  private formatCampaignStats(s: CampaignStats): string {
    const stateMap = { active: '🌱 Activa', harvested: '🌾 Cosechada (abierta)', closed: '✅ Cerrada' };
    const lines: string[] = [];

    const header = `📊 *Campaña ${s.crop} ${s.seasonLabel}* — ${s.plot}${s.field ? ` (${s.field})` : ''}`;
    lines.push(header);
    lines.push(`Estado: ${stateMap[s.state]} | ${s.durationDays} días`);

    // Activities
    if (s.activities.total > 0) {
      const byTypeStr = Object.entries(s.activities.byType)
        .map(([type, count]) => {
          const { label } = getActivityLabel(type);
          return `${label}: ${count}`;
        })
        .join(' | ');
      lines.push(`\n*Actividades (${s.activities.total}):*\n${byTypeStr}`);
    }

    // Expenses
    if (s.expenses.count > 0) {
      const byCatStr = Object.entries(s.expenses.byCategory)
        .sort(([, a], [, b]) => b - a)
        .map(([cat, amt]) => `${cat}: $${amt.toLocaleString('es-AR')}`)
        .join(' | ');
      let expLine = `\n*Gastos:* $${s.expenses.totalARS.toLocaleString('es-AR')} ARS`;
      if (s.expenses.totalUSD > 0) expLine += ` + US$${s.expenses.totalUSD.toLocaleString('es-AR')}`;
      lines.push(expLine);
      lines.push(byCatStr);
    }

    // Incomes
    if (s.incomes.count > 0) {
      let incLine = `\n*Ingresos:* $${s.incomes.totalARS.toLocaleString('es-AR')} ARS`;
      if (s.incomes.totalUSD > 0) incLine += ` + US$${s.incomes.totalUSD.toLocaleString('es-AR')}`;
      lines.push(incLine);
    }

    // Yield — if recorded, show kg and kg/ha. If the campaign was harvested
    // but the user never logged the kg, surface that explicitly with a hint
    // instead of silently omitting the line (otherwise "promedio?" returns a
    // table that doesn't even mention the rinde).
    if (s.yield.kg) {
      let yieldLine = `\n*Rendimiento:* ${s.yield.kg.toLocaleString('es-AR')} kg`;
      if (s.yield.kgPerHa) yieldLine += ` (${s.yield.kgPerHa.toLocaleString('es-AR')} kg/ha)`;
      lines.push(yieldLine);
    } else if (s.state === 'harvested' || s.state === 'closed') {
      lines.push(`\n*Rendimiento:* no registrado\n_Cargalo con: "rindió X kg/ha en lote ${s.plot}" o "cosechamos X tn en ${s.plot}"._`);
    }

    // Harvest loads detail
    if (s.yield.loads && s.yield.loads.length > 0) {
      lines.push(`\n🚛 *Cargas (${s.yield.loads.length}):*`);
      for (const ld of s.yield.loads) {
        let loadLine = `• ${ld.driver_name} — ${ld.weight_kg.toLocaleString('es-AR')} kg`;
        if (ld.humidity_pct != null) loadLine += ` (${ld.humidity_pct}% hum)`;
        if (ld.destinatario) loadLine += ` → ${ld.destinatario}`;
        else if (ld.destination) loadLine += ` → ${ld.destination}`;
        lines.push(loadLine);
      }
      if (s.yield.avgHumidity != null) {
        lines.push(`💧 Humedad promedio: ${s.yield.avgHumidity}%`);
      }
      // Quality metrics (any load with metrics)
      const qLoads = s.yield.loads.filter(l => l.quality_metrics && Object.keys(l.quality_metrics).length > 0);
      if (qLoads.length > 0) {
        lines.push(`🏷️ *Calidad:*`);
        for (const ql of qLoads) {
          const metrics = Object.entries(ql.quality_metrics!)
            .map(([k, v]) => `${k.replace(/_pct$/, '%').replace(/_/g, ' ')}: ${v}`)
            .join(', ');
          lines.push(`  • ${ql.driver_name}: ${metrics}`);
        }
      }
    }

    // Profitability (only if both expenses and incomes exist)
    if (s.expenses.count > 0 || s.incomes.count > 0) {
      const sign = s.profitability.netARS >= 0 ? '+' : '';
      let profLine = `\n*Rentabilidad:*\nResultado neto: ${sign}$${s.profitability.netARS.toLocaleString('es-AR')} ARS`;
      if (s.profitability.costPerHaARS != null) profLine += `\nCosto/ha: $${s.profitability.costPerHaARS.toLocaleString('es-AR')}`;
      if (s.profitability.incomePerHaARS != null) profLine += ` | Ingreso/ha: $${s.profitability.incomePerHaARS.toLocaleString('es-AR')}`;
      if (s.profitability.costPerTnARS != null) profLine += `\nCosto/tn: $${s.profitability.costPerTnARS.toLocaleString('es-AR')}`;
      if (s.profitability.costPerTnUSD != null) profLine += ` (US$${s.profitability.costPerTnUSD.toLocaleString('es-AR')}/tn)`;
      if (s.profitability.incomePerTnARS != null) profLine += ` | Ingreso/tn: $${s.profitability.incomePerTnARS.toLocaleString('es-AR')}`;
      lines.push(profLine);
    }

    // Scouting (structured monitoring)
    if (s.scouting && s.scouting.count > 0) {
      const sevLabels = ['', 'ausente', 'leve', 'moderada', 'alta', 'severa'];
      const sLines: string[] = [`\n🔍 *Monitoreo (${s.scouting.count}):*`];
      if (s.scouting.lastStage) sLines.push(`• Estadio observado: *${s.scouting.lastStage}* (${s.scouting.lastStageDate})`);
      if (s.scouting.avgWeedPct != null) sLines.push(`• Cobertura malezas (prom): ${s.scouting.avgWeedPct}%`);
      if (s.scouting.maxPestSeverity != null) {
        const sev = sevLabels[s.scouting.maxPestSeverity];
        const sp = s.scouting.maxPestSpecies ? ` ${s.scouting.maxPestSpecies}` : '';
        sLines.push(`• Plaga máx:${sp} (${sev} ${s.scouting.maxPestSeverity}/5)`);
      }
      if (s.scouting.lastEmergencePct != null) sLines.push(`• Emergencia: ${s.scouting.lastEmergencePct}%`);
      if (s.scouting.avgPlantDensity != null) sLines.push(`• Densidad prom: ${s.scouting.avgPlantDensity} pl/m²`);
      lines.push(sLines.join('\n'));
    }

    // Observations
    if (s.observations.count > 0) {
      lines.push(`\n*Observaciones:* ${s.observations.count}`);
    }

    return lines.join('\n');
  }

  private formatCampaignComparison(c: CampaignComparison): string {
    const fmt = (n: number) => n.toLocaleString('es-AR');
    const fmtPct = (p: number | null) => {
      if (p == null) return '';
      const sign = p >= 0 ? '+' : '';
      return ` (${sign}${p}%)`;
    };

    const s1 = c.season1.stats;
    const s2 = c.season2.stats;
    const lines: string[] = [];

    lines.push(`📊 *Comparación ${c.crop}* — ${c.plot}${c.field ? ` (${c.field})` : ''}`);
    lines.push(`*${c.season1.label}* vs *${c.season2.label}*`);

    if (s1.yield.kgPerHa != null && s2.yield.kgPerHa != null) {
      lines.push(`\n🌾 Rinde: ${fmt(s1.yield.kgPerHa)} vs ${fmt(s2.yield.kgPerHa)} kg/ha${fmtPct(c.deltas.yieldKgPerHaPct)}`);
    }

    lines.push(`💸 Gastos: $${fmt(s1.expenses.totalARS)} vs $${fmt(s2.expenses.totalARS)}${fmtPct(c.deltas.expensesPct)}`);
    lines.push(`💰 Ingresos: $${fmt(s1.incomes.totalARS)} vs $${fmt(s2.incomes.totalARS)}${fmtPct(c.deltas.incomesPct)}`);

    if (s1.profitability.costPerHaARS != null && s2.profitability.costPerHaARS != null) {
      const result1 = (s1.profitability.incomePerHaARS ?? 0) - s1.profitability.costPerHaARS;
      const result2 = (s2.profitability.incomePerHaARS ?? 0) - s2.profitability.costPerHaARS;
      const sign1 = result1 >= 0 ? '+' : '';
      const sign2 = result2 >= 0 ? '+' : '';
      lines.push(`📈 Resultado/ha: ${sign1}$${fmt(result1)} vs ${sign2}$${fmt(result2)}${fmtPct(c.deltas.netPerHaPct)}`);
    }

    return lines.join('\n');
  }
}
