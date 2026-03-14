import fs from 'fs';
import { AgronomyRepository } from './agronomy.repository.js';
import { PlotDiscoveryService } from '../plots/plot-discovery.service.js';
import { CropService, formatSeasonLabel, getSeasonTypeForCrop } from '../plots/crop.service.js';
import { inferCrop, getActivityLabel, formatActivityConfirmation } from './activity.service.js';
import {
  getCurrentWeather,
  getForecast,
  formatCurrentWeather,
  formatForecast,
  checkRainAlert,
} from '../../services/weather.js';
import { generateWeeklyReport } from '../../services/agro-report.js';
import { saveObservation, detectObservationCategory, getCurrentWeekObservations } from '../../services/observations.js';
import { formatObservationResponse, formatAgroReportResponse } from '../../middleware/response-formatter.js';
import type { UserId, User, ParsedCommand, UserSettings, HandlerResponse, ActivityType } from '../../types/index.js';

export class AgronomyHandler {
  private plotDiscovery = new PlotDiscoveryService();
  private cropService = new CropService();

  constructor(private repo: AgronomyRepository) {}

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
          return { messages: [msg] };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
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
          return { messages: [msg] };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
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
          return { messages: [msg] };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
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

          return { messages: [msg] };
        } catch (e: unknown) {
          console.error('WEATHER ERROR:', (e as Error).message);
          return { messages: ['No pude obtener el clima. Intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      // --- Rainfall ---

      case 'log_rainfall': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );

        let fieldLabel = 'General';
        if (resolved.plotName && resolved.fieldName) {
          fieldLabel = `${resolved.fieldName} > ${resolved.plotName}`;
        } else if (resolved.fieldName) {
          fieldLabel = resolved.fieldName;
        }

        await this.repo.saveRainfall(userId, cmd.mm as number, resolved.fieldId, resolved.plotId);
        return { messages: [`\ud83c\udf27\ufe0f Lluvia registrada: *${cmd.mm}mm*\n\ud83d\udccd ${fieldLabel}`] };
      }

      case 'delete_last_rainfall': {
        const deleted = await this.repo.deleteLastRainfall(userId);
        if (!deleted) {
          return { messages: ['No hay registros de lluvia para borrar.'] };
        }
        return { messages: [`\ud83d\uddd1\ufe0f Registro de lluvia eliminado: ${deleted.millimeters}mm`] };
      }

      case 'rainfall_report': {
        const periodLabel: Record<string, string> = { week: 'la semana', month: 'el mes', year: 'el a\u00f1o' };
        const period = cmd.period as string;

        if (cmd.fieldName) {
          const field = await this.repo.getFieldByName(userId, cmd.fieldName as string);
          let data = await this.repo.getRainfallPeriod(userId, period, field?.id || null);
          if (data.registros === 0 && field) {
            const nullData = await this.repo.getRainfallPeriod(userId, period, null);
            if (nullData.registros > 0) data = nullData;
          }
          if (data.registros === 0) {
            return { messages: [`No hay registros de lluvia en lote ${cmd.fieldName} para ${periodLabel[period]}.`] };
          }
          return { messages: [`\ud83c\udf27\ufe0f *Lluvia lote ${cmd.fieldName} \u2014 ${periodLabel[period]}*\n\nTotal: *${data.total}mm*\nRegistros: ${data.registros}`] };
        }

        const allData = await this.repo.getRainfallAllLocations(userId, period);
        if (allData.length === 0) {
          return { messages: [`No hay registros de lluvia para ${periodLabel[period]}.`] };
        }
        let totalGlobal = 0;
        let msg = `\ud83c\udf27\ufe0f *Lluvias \u2014 ${periodLabel[period]}*\n`;
        for (const row of allData) {
          const label = row.field_name || 'General';
          totalGlobal += row.total;
          msg += `\n\ud83d\udccd ${label}: *${row.total}mm* (${row.registros} reg.)`;
        }
        if (allData.length > 1) msg += `\n\n\ud83d\udca7 Total: *${totalGlobal}mm*`;
        return { messages: [msg] };
      }

      case 'rainfall_range': {
        const desde = cmd.desde as Date;
        const hasta = cmd.hasta as Date;
        const desdeStr = desde.toLocaleDateString('es-AR');
        const hastaStr = hasta.toLocaleDateString('es-AR');
        const data = await this.repo.getRainfallRange(userId, desde, hasta);
        if (data.registros === 0) {
          return { messages: [`No hay registros de lluvia entre ${desdeStr} y ${hastaStr}.`] };
        }
        return { messages: [`\ud83c\udf27\ufe0f *Lluvias ${desdeStr} \u2014 ${hastaStr}*\n\nTotal: *${data.total}mm*\nRegistros: ${data.registros}`] };
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
        let msg = `\ud83c\udf27\ufe0f *${cap(mes1Name)} vs ${cap(mes2Name)}*\n\n`;
        msg += `${cap(mes1Name)}: *${d1.total}mm* (${d1.registros} reg.)\n`;
        msg += `${cap(mes2Name)}: *${d2.total}mm* (${d2.registros} reg.)\n`;
        if (d2.total > 0) {
          const diff = d1.total - d2.total;
          const sign = diff >= 0 ? '+' : '';
          const pct = Math.round((diff / d2.total) * 100);
          msg += `\nDiferencia: ${sign}${diff}mm (${sign}${pct}%)`;
        }
        return { messages: [msg] };
      }

      case 'compare_rainfall_years': {
        const [d1, d2] = await Promise.all([
          this.repo.getRainfallForYear(userId, cmd.year1 as number),
          this.repo.getRainfallForYear(userId, cmd.year2 as number),
        ]);
        let msg = `\ud83c\udf27\ufe0f *${cmd.year1} vs ${cmd.year2}*\n\n`;
        msg += `${cmd.year1}: *${d1.total}mm* (${d1.registros} reg.)\n`;
        msg += `${cmd.year2}: *${d2.total}mm* (${d2.registros} reg.)\n`;
        if (d2.total > 0) {
          const diff = d1.total - d2.total;
          const sign = diff >= 0 ? '+' : '';
          const pct = Math.round((diff / d2.total) * 100);
          msg += `\nDiferencia: ${sign}${diff}mm (${sign}${pct}%)`;
        }
        return { messages: [msg] };
      }

      // --- Crops ---

      case 'sow_crop': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Escribí algo como:\n🌱 *sembré soja en el lote 3*'] };
        }

        const crop = cmd.crop as string;
        const { cropRow, closedPrevious } = await this.cropService.startCrop(userId, resolved.plotId, crop);
        const label = formatSeasonLabel(cropRow.season_year, cropRow.season_type);
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

        // Save domain event for planting
        await this.repo.saveDomainEvent(userId, {
          plotId: resolved.plotId,
          plotCropId: cropRow.id,
          eventType: 'planting',
          crop,
        });

        const msgs: string[] = [];
        if (closedPrevious) {
          msgs.push(`📋 Se cerró la campaña anterior de *${closedPrevious.crop}* en ${plotLabel}.`);
        }
        msgs.push(`🌱 *${crop}* sembrado en *${plotLabel}*\n📅 Campaña ${label}`);
        return { messages: msgs };
      }

      case 'harvest_crop': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Escribí algo como:\n🌾 *cosechamos soja en el lote 3*'] };
        }

        const crop = cmd.crop as string;
        const closed = await this.cropService.harvestCrop(resolved.plotId, crop);
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

        if (!closed) {
          const active = await this.cropService.getActive(resolved.plotId);
          if (active) {
            return { messages: [`En *${plotLabel}* hay *${active.crop}* sembrado, no ${crop}.\nSi querés cosechar ${active.crop}, escribí:\n🌾 *cosechamos ${active.crop.toLowerCase()} en el lote ${resolved.plotName}*`] };
          }
          return { messages: [`No hay cultivo activo en *${plotLabel}* para cosechar.`] };
        }

        // Save domain event for harvest
        await this.repo.saveDomainEvent(userId, {
          plotId: resolved.plotId,
          plotCropId: closed.id,
          eventType: 'harvest',
          crop,
        });

        const label = formatSeasonLabel(closed.season_year, closed.season_type);
        return { messages: [`🌾 *${crop}* cosechado en *${plotLabel}*\n📅 Campaña ${label} finalizada`] };
      }

      case 'active_crop': {
        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          return { messages: ['No pude identificar el lote. Escribí algo como:\n🔍 *qué hay sembrado en el lote 3*'] };
        }

        const active = await this.cropService.getActive(resolved.plotId);
        const plotLabel = resolved.fieldName ? `${resolved.fieldName} > ${resolved.plotName}` : resolved.plotName;

        if (!active) {
          return { messages: [`No hay cultivo activo en *${plotLabel}*.`] };
        }

        const label = formatSeasonLabel(active.season_year, active.season_type);
        return { messages: [`🌱 *${plotLabel}* tiene *${active.crop}* sembrado\n📅 Campaña ${label}`] };
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
          const status = row.end_date ? '✅' : '🌱';
          msg += `\n${status} *${row.crop}* — Campaña ${label}`;
          if (row.end_date) {
            msg += ' (cosechado)';
          } else {
            msg += ' (activo)';
          }
        }
        return { messages: [msg] };
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

        const resolved = await this.plotDiscovery.resolveFromNames(
          userId,
          cmd.fieldName as string | null,
          cmd.plotName as string | null
        );
        if (!resolved.plotId) {
          const { label } = getActivityLabel(eventType);
          return { messages: [`No pude identificar el lote. Escribí algo como:\n${label} en el *lote 3*`] };
        }

        const activeCrop = resolved.plotId ? await this.cropService.getActive(resolved.plotId) : null;
        const crop = inferCrop(
          cmd.crop as string | null,
          activeCrop,
          cmd.product as string | null,
        );

        await this.repo.saveDomainEvent(userId, {
          plotId: resolved.plotId,
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

        const plotLabel = resolved.fieldName
          ? `${resolved.fieldName} > ${resolved.plotName}`
          : resolved.plotName;

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
          const dateStr = new Date(ev.event_date).toLocaleDateString('es-AR');
          let line = `\n${emoji} *${label}* — ${dateStr}`;
          if (ev.product) line += ` — ${ev.product}`;
          if (ev.quantity && ev.unit) line += ` (${ev.quantity} ${ev.unit})`;
          if (ev.crop) line += ` — ${ev.crop}`;
          if (ev.implement) line += ` — ${ev.implement}`;
          msg += line;
        }
        return { messages: [msg] };
      }

      // --- Agro Reports ---

      case 'generate_agro_report': {
        const fieldName = cmd.fieldName as string;
        if (!fieldName) {
          return { messages: ['Indicá el campo. Ejemplo:\n📋 *reporte agronómico campo norte*'] };
        }
        const field = await this.repo.getFieldByName(userId, fieldName);
        if (!field) {
          return { messages: [`No encontré el campo "${fieldName}". Revisá el nombre o escribí *mis campos* para ver tus campos.`] };
        }
        try {
          const report = await generateWeeklyReport(userId, field.id);
          const pdfBuffer = fs.readFileSync(report.pdfPath);

          // Build per-plot observation breakdown
          const observations = await getCurrentWeekObservations(field.id);
          const plotMap = new Map<string, string[]>();
          for (const obs of observations) {
            const key = obs.plot_name || 'General';
            if (!plotMap.has(key)) plotMap.set(key, []);
            plotMap.get(key)!.push(obs.observation_text);
          }
          const plotSummaries = [...plotMap.entries()].map(([plotName, obs]) => ({ plotName, observations: obs }));

          // Recent activities for this field's plots
          const fieldPlots = await this.repo.getPlotsByField(field.id);
          const plotIds = new Set(fieldPlots.map(p => p.id));
          const allEvents = await this.repo.getDomainEventsByUser(userId, 10);
          const recentActivities = allEvents
            .filter(ev => ev.plot_id && plotIds.has(ev.plot_id))
            .slice(0, 5)
            .map(ev => ({
              label: getActivityLabel(ev.event_type).label,
              detail: ev.product || ev.crop || '',
              plotName: ev.plot_name || 'General',
            }));

          const richMessage = formatAgroReportResponse({
            fieldName: field.name,
            weekNumber: report.weekNumber,
            observationCount: report.observationCount,
            plotSummaries,
            recentActivities,
          });

          return {
            messages: [richMessage],
            attachment: {
              buffer: pdfBuffer,
              filename: report.filename,
              mime: 'application/pdf',
              caption: `Reporte Agronómico — ${field.name} — Semana ${report.weekNumber}`,
            },
          };
        } catch (err: unknown) {
          console.error('AGRO REPORT ERROR:', (err as Error).message);
          return { messages: ['Hubo un error generando el reporte agronómico. Intentá de nuevo.'] };
        }
      }

      // --- Observations ---

      case 'log_observation': {
        const obsFieldName = cmd.fieldName as string | null;
        const obsPlotName = cmd.plotName as string | null;
        const obsText = cmd.observation as string;

        if (!obsText) {
          return { messages: ['No pude detectar la observación. Ejemplo:\n🔍 *observación lote 3: hay presencia de rama negra*'] };
        }

        const resolved = await this.plotDiscovery.resolveFromNames(userId, obsFieldName, obsPlotName);
        const category = detectObservationCategory(obsText);

        await saveObservation(userId, {
          fieldId: resolved.fieldId,
          plotId: resolved.plotId,
          text: obsText,
          category,
          source: 'text',
        });

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
          observationText: obsText,
        });
        return { messages: [message], suggestionKey: 'observation_logged' };
      }

      default:
        return { messages: ['No pude procesar ese comando agronómico. Escribí *menú agro* para ver las opciones.'] };
    }
  }
}
