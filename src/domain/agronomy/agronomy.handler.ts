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

// --- Observation safety guard ---
// Prevents accidental persistence of questions/follow-ups as observations.

const QUESTION_STARTS = /^(?:que|qué|cuando|cuándo|donde|dónde|como|cómo|cual|cuál|cuanto|cuánto|por\s+que|por\s+qué|quien|quién)/i;
const FOLLOWUP_STARTS = /^(?:y\s|del\s|eso|ese|esa|ah[ií])/i;
const STRONG_OBS_SIGNALS = /(?:observaci[oó]n|hay\s|se\s+detect|se\s+observ|presencia\s+de|se\s+ve|plaga|maleza|hongo|roya|helada|granizo|chinche|oruga|gramilla|amarill|seco|seca|sequ[ií]a|encharcam|mancha|yuyo|cardo|isoca|pulgon|pulg[oó]n|trips|bicho|clorosis|deficiencia|carencia)/i;

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

    // Check if plot has a harvested (but not closed) campaign → offer to close
    if (activeCrop?.harvested_at && !activeCrop.end_date) {
      return {
        messages: [confirmation],
        interactive: {
          type: 'buttons',
          body: `La campaña de ${activeCrop.crop} en ${plotLabel} ya fue cosechada. ¿Querés cerrarla?`,
          buttons: [
            { id: `campaign_close_yes_${activeCrop.id}`, title: 'Cerrar campaña' },
            { id: `campaign_close_no_${activeCrop.id}`, title: 'Mantener abierta' },
          ],
        },
        sideEffects: { setPendingCampaignClose: { plotCropId: activeCrop.id, crop: activeCrop.crop, plotName: plotLabel || '' } },
      };
    }

    return { messages: [confirmation] };
  }

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      // --- Weather ---

      case 'weather_full': {
        if (!process.env.OPENWEATHER_API_KEY) {
          return { messages: ['El clima no est\u00e1 configurado todav\u00eda.'] };
        }
        const weatherCity = (cmd.city as string) || user.city || null;
        if (!weatherCity && !process.env.WEATHER_CITY) {
          return { messages: ['No tengo tu ubicaci\u00f3n. Escrib\u00ed algo como:\n\ud83d\udccd *estoy en Jun\u00edn*\n\nO ped\u00ed el clima de una ciudad:\n\ud83c\udf24\ufe0f *clima en Pergamino*'] };
        }
        try {
          const [current, forecastData] = await Promise.all([
            getCurrentWeather(weatherCity),
            getForecast(weatherCity, 3),
          ]);
          let msg = formatCurrentWeather(current) + '\n\n' + formatForecast(forecastData);
          const rainAlert = checkRainAlert(forecastData);
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
        const fcCity = (cmd.city as string) || user.city || null;
        if (!fcCity && !process.env.WEATHER_CITY) {
          return { messages: ['No tengo tu ubicaci\u00f3n. Escrib\u00ed algo como:\n\ud83d\udccd *estoy en Jun\u00edn*\n\nO ped\u00ed el clima de una ciudad:\n\ud83c\udf24\ufe0f *clima en Pergamino*'] };
        }
        try {
          const forecastData = await getForecast(fcCity, cmd.days as number);
          let msg = formatForecast(forecastData);
          const rainAlert = checkRainAlert(forecastData);
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
          const rainAlert = checkRainAlert(forecastData);
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

            const rainAlert = checkRainAlert(forecast);
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
          // Multiple fields, none explicitly mentioned — ask user which one
          const buttons = rainfallUserFields.slice(0, 3).map(f => ({
            id: `rain_field_${f.name}_${mm}`,
            title: f.name.slice(0, 20),
          }));
          return {
            messages: [`Llovieron *${mm}mm* 🌧️ ¿En qué campo?`],
            interactive: { type: 'buttons' as const, body: 'Elegí el campo:', buttons },
          };
        }

        const saved = await this.repo.saveRainfall(userId, mm, fieldId);

        // Handle dedup rejection
        if (saved === RAINFALL_REJECTED_DUPLICATE) {
          const dupLabel = fieldLabel || 'tu campo';
          return { messages: [`Ya hay un registro de lluvia hoy para *${dupLabel}*. Si querés corregirlo, borrá el anterior con *borrar lluvia* y registrá de nuevo.`] };
        }

        let msg = `\ud83c\udf27\ufe0f Lluvia registrada: *${mm}mm*`;
        if (fieldLabel) msg += `\n\ud83d\udccd ${fieldLabel}`;

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

      case 'delete_last_rainfall': {
        const deleted = await this.repo.deleteLastRainfall(userId);
        if (!deleted) {
          return { messages: ['No hay registros de lluvia para borrar.'] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Registro de lluvia eliminado: ${deleted.millimeters}mm`] };
      }

      case 'rainfall_report': {
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
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        const plotResult = await this.resolveActivityPlot(userId, resolved);

        if (plotResult.type === 'no_plots') {
          return {
            messages: ['Primero necesitás crear un campo y un lote.\n\n📍 Escribí *agregar campo [nombre]*'],
            interactive: {
              type: 'buttons',
              body: 'Necesitás un lote para registrar siembra.',
              buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
            },
          };
        }

        if (plotResult.type === 'ask_user') {
          return this.buildAskPlotResponse('siembra', plotResult.plots, cmd);
        }

        const crop = cmd.crop as string;
        const sowedHa = cmd.hectares != null ? Number(cmd.hectares) : null;
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
        msgs.push(sowMsg);
        return { messages: msgs };
      }

      case 'harvest_crop': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        const plotResult = await this.resolveActivityPlot(userId, resolved);

        if (plotResult.type === 'no_plots') {
          return {
            messages: ['Primero necesitás crear un campo y un lote.\n\n📍 Escribí *agregar campo [nombre]*'],
            interactive: {
              type: 'buttons',
              body: 'Necesitás un lote para registrar cosecha.',
              buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
            },
          };
        }

        if (plotResult.type === 'ask_user') {
          return this.buildAskPlotResponse('cosecha', plotResult.plots, cmd);
        }

        const crop = cmd.crop as string;
        const yieldKg = cmd.yieldKg != null ? Number(cmd.yieldKg) : null;
        const yieldNotes = (cmd.yieldNotes as string) || null;
        const plotLabel = plotResult.fieldName ? `${plotResult.fieldName} > ${plotResult.plotName}` : plotResult.plotName;

        // Dedup: check if there's already a harvest event for this plot today
        const loads = Array.isArray(cmd.loads) ? cmd.loads as Array<{ driver_name: string; weight_kg: number; destination?: string; destinatario?: string; truck_plate?: string }> : null;
        const existingEvent = await this.repo.findTodayHarvestEvent(userId, plotResult.plotId);

        let savedEvent: { id: number; plot_crop_id?: number | null; [key: string]: unknown };
        let harvested: { id: number; season_year: number; season_type: string } | null = null;
        let isAppend = false;

        if (existingEvent) {
          // Reuse existing event — just append loads
          savedEvent = existingEvent;
          isAppend = true;
          // Get plot_crop info for season label
          if (existingEvent.plot_crop_id) {
            const activeCrop = await this.cropService.getActive(plotResult.plotId);
            if (activeCrop) harvested = activeCrop;
          }
        } else {
          // Normal flow: register harvest
          const harvestedResult = await this.cropService.harvestCrop(plotResult.plotId, crop, cmd.eventDate as Date | undefined, yieldKg, yieldNotes);

          if (!harvestedResult) {
            const active = await this.cropService.getActive(plotResult.plotId);
            if (active) {
              return { messages: [`En *${plotLabel}* hay *${active.crop}* sembrado, no ${crop}.\nSi querés cosechar ${active.crop}, escribí:\n🌾 *cosechamos ${active.crop.toLowerCase()} en el lote ${plotResult.plotName}*`] };
            }
            return { messages: [`No hay cultivo activo en *${plotLabel}* para cosechar.`] };
          }

          harvested = harvestedResult;

          // Save domain event for harvest
          const harvestQuantity = cmd.quantity ? Number(cmd.quantity) : null;
          const harvestUnit = (cmd.unit as string) || 'tn';
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
            if (l.destinatario) line += ` → ${l.destinatario}`;
            else if (l.destination) line += ` → ${l.destination}`;
            return line;
          });

          const header = isAppend
            ? `🚛 *${loads.length} carga${loads.length > 1 ? 's' : ''} agregada${loads.length > 1 ? 's' : ''} en ${plotLabel}:*`
            : `🚛 *${loads.length} carga${loads.length > 1 ? 's' : ''} registrada${loads.length > 1 ? 's' : ''} en ${plotLabel}:*`;
          let loadsMsg = `${header}\n${loadLines.join('\n')}\n\n📊 *Total: ${totalKg.toLocaleString('es-AR')} kg*`;

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
        if (yieldKg) {
          const { getPlotById } = await import('../../services/expenses.js');
          const plotInfo = await getPlotById(plotResult.plotId, userId);
          const areaHa = plotInfo?.area_hectares ? Number(plotInfo.area_hectares) : null;
          const kgPerHa = areaHa ? Math.round(yieldKg / areaHa) : null;
          harvestMsg += `\n📊 Rendimiento: ${yieldKg.toLocaleString('es-AR')} kg`;
          if (kgPerHa) harvestMsg += ` (${kgPerHa.toLocaleString('es-AR')} kg/ha)`;
        }
        harvestMsg += `\n\nLa campaña sigue abierta. Cuando quieras cerrarla, decime "cerrar campaña".`;
        const messages = [harvestMsg];

        // If quantity provided, suggest loading grain to stock/silo
        const harvestQuantity = cmd.quantity ? Number(cmd.quantity) : null;
        const harvestUnit = (cmd.unit as string) || 'tn';
        if (harvestQuantity && harvestQuantity > 0) {
          try {
            const { FeatureGate } = await import('../billing/feature-gate.js');
            const fg = new FeatureGate();
            const hasStock = await fg.hasFeature(userId, 'stock');
            if (hasStock) {
              const warehouseName = (cmd.warehouseName as string) || undefined;
              messages.push(`\n📦 ¿Querés cargar *${harvestQuantity}${harvestUnit}* de *${crop}* al ${warehouseName ? `silo *${warehouseName}*` : 'stock'}?`);
              return {
                messages,
                interactive: {
                  type: 'buttons',
                  body: `Cargar ${harvestQuantity}${harvestUnit} de ${crop} al stock?`,
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
            return { messages: [`No hay cultivo activo en *${plotLabel}*.`] };
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
          return { messages: [`No hay campañas activas${filterMsg}${grupoMsg}.`] };
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
        const resolved = await this.plotDiscovery.resolveFromNames(
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
        let loadsPlotId: number | null = null;
        let loadsFieldId: number | null = null;
        let loadsLocationLabel: string | null = null;

        if (cmd.plotName || cmd.fieldName) {
          const resolved = await this.plotDiscovery.resolveFromNames(
            userId,
            cmd.fieldName as string | null,
            cmd.plotName as string | null,
          );
          loadsFieldId = resolved.fieldId ?? null;
          loadsPlotId = resolved.plotId ?? null;
          loadsLocationLabel = resolved.plotName
            ? (resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName)
            : resolved.fieldName ?? null;
        }

        const loadRows = await this.repo.queryHarvestLoads(userId, {
          plotId: loadsPlotId,
          fieldId: loadsFieldId,
          desde: cmd.desde as string | null,
          hasta: cmd.hasta as string | null,
          driverName: cmd.driverName as string | null,
          destinatario: cmd.destinatario as string | null,
        });

        if (loadRows.length === 0) {
          let emptyMsg = 'No hay cargas de cosecha registradas';
          if (loadsLocationLabel) emptyMsg += ` en *${loadsLocationLabel}*`;
          emptyMsg += '.';
          return { messages: [emptyMsg] };
        }

        // Group by date+plot for display
        const totalKg = loadRows.reduce((sum, r) => sum + Number(r.weight_kg), 0);
        const lines: string[] = [];
        let title = `🚛 *${loadRows.length} carga${loadRows.length > 1 ? 's' : ''}*`;
        if (loadsLocationLabel) title += ` — ${loadsLocationLabel}`;
        lines.push(title);

        for (const r of loadRows) {
          let line = `• ${r.driver_name} — ${Number(r.weight_kg).toLocaleString('es-AR')} kg`;
          if (r.destinatario) line += ` → ${r.destinatario}`;
          else if (r.destination) line += ` → ${r.destination}`;
          if (r.truck_plate) line += ` (${r.truck_plate})`;
          if (!loadsPlotId && r.plot_name) line += ` [${r.plot_name}]`;
          lines.push(line);
        }

        lines.push('');
        lines.push(`📊 *Total: ${totalKg.toLocaleString('es-AR')} kg*`);

        return { messages: [lines.join('\n')] };
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
          return {
            messages: [`Para registrar ${actLabel.toLowerCase()} primero necesitás crear un campo y un lote.\n\n📍 Escribí *agregar campo [nombre]*`],
            interactive: {
              type: 'buttons',
              body: `Necesitás un campo para registrar ${actLabel.toLowerCase()}.`,
              buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
            },
          };
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

        // Check if plot has a harvested (but not closed) campaign → offer to close
        if (activeCrop?.harvested_at && !activeCrop.end_date) {
          return {
            messages: [confirmation],
            interactive: {
              type: 'buttons',
              body: `La campaña de ${activeCrop.crop} en ${plotLabel} ya fue cosechada. ¿Querés cerrarla?`,
              buttons: [
                { id: `campaign_close_yes_${activeCrop.id}`, title: 'Cerrar campaña' },
                { id: `campaign_close_no_${activeCrop.id}`, title: 'Mantener abierta' },
              ],
            },
            sideEffects: { setPendingCampaignClose: { plotCropId: activeCrop.id, crop: activeCrop.crop, plotName: plotLabel || '' } },
          };
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
            return {
              messages: ['Para registrar tacto primero necesitás crear un campo y un lote.\n\n📍 Escribí *agregar campo [nombre]*'],
              interactive: {
                type: 'buttons',
                body: 'Necesitás un lote para registrar tacto.',
                buttons: [{ id: 'cmd_agregar_campo', title: 'Crear Campo' }],
              },
            };
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

        if (!newPlotName) {
          return { messages: ['Indicá el lote correcto. Ejemplo:\n✏️ *la siembra era en lote B*'] };
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

        // Resolve new plot
        const newResolved = await this.plotDiscovery.resolveFromNames(
          userId,
          newFieldName,
          newPlotName,
        );

        if (!newResolved.plotId) {
          return { messages: [`No encontré el lote *${newPlotName}*. Revisá el nombre o escribí *mis lotes*.`] };
        }

        // Build extra fields to update
        const extraFields: { crop?: string; eventDate?: string } = {};
        if (newCrop) extraFields.crop = newCrop;
        if (newDate) extraFields.eventDate = newDate;

        // Update the event
        await this.repo.updateDomainEventPlot(lastEvent.id, newResolved.plotId, userId, extraFields);

        const { label: editActLabel } = getActivityLabel(lastEvent.event_type);
        const oldPlotLabel = lastEvent.plot_name || 'sin lote';
        const newPlotLabel = newResolved.fieldName
          ? `${newResolved.fieldName} > ${newResolved.plotName}`
          : newResolved.plotName;

        const editLines: string[] = [`✏️ Actividad corregida: *${editActLabel}*`];
        if (lastEvent.crop) editLines[0] += ` de *${lastEvent.crop}*`;
        editLines.push(`📍 ${oldPlotLabel} → *${newPlotLabel}*`);
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

        if (!fieldName && !plotName) {
          return { messages: ['Indicá el campo o lote. Ejemplo:\n📋 *reporte agronómico campo norte*\n📋 *reporte agronómico lote 1*'] };
        }

        let field: { id: number; name: string } | null = null;
        let filterPlotId: number | null = null;
        let filterPlotName: string | null = null;

        if (plotName) {
          const resolved = await this.plotDiscovery.resolveFromNames(userId, null, plotName);
          if (!resolved.plotId || resolved.autoCreated) {
            // Fallback: AI might have put a field name in the plot slot
            const fallbackField = await this.repo.getFieldByName(userId, plotName);
            if (fallbackField) {
              field = fallbackField;
            } else {
              return { messages: [`No encontré el lote "${plotName}". Revisá el nombre o escribí *mis lotes* para ver tus lotes.`] };
            }
          } else {
            filterPlotId = resolved.plotId;
            filterPlotName = resolved.plotName;
            field = await this.repo.getFieldByName(userId, resolved.fieldName!);
          }
        } else {
          field = await this.repo.getFieldByName(userId, fieldName!);
        }

        if (!field) {
          return { messages: [`No encontré el campo "${fieldName || plotName}". Revisá el nombre o escribí *mis campos* para ver tus campos.`] };
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
          return { messages: ['Hubo un error generando el reporte agronómico. Intentá de nuevo.'] };
        }
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

    // Yield
    if (s.yield.kg) {
      let yieldLine = `\n*Rendimiento:* ${s.yield.kg.toLocaleString('es-AR')} kg`;
      if (s.yield.kgPerHa) yieldLine += ` (${s.yield.kgPerHa.toLocaleString('es-AR')} kg/ha)`;
      lines.push(yieldLine);
    }

    // Harvest loads detail
    if (s.yield.loads && s.yield.loads.length > 0) {
      lines.push(`\n🚛 *Cargas (${s.yield.loads.length}):*`);
      for (const ld of s.yield.loads) {
        let loadLine = `• ${ld.driver_name} — ${ld.weight_kg.toLocaleString('es-AR')} kg`;
        if (ld.destinatario) loadLine += ` → ${ld.destinatario}`;
        else if (ld.destination) loadLine += ` → ${ld.destination}`;
        lines.push(loadLine);
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
