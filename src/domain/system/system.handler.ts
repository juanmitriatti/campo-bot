import { UserRepository } from '../users/user.repository.js';
import { PlanRepository } from '../billing/plan.repository.js';
import { pool } from '../../config/db.js';
import { buildHelpText, buildHelpMenu, HELP_SECTIONS } from './help-text.js';
import { localidadLookup } from '../../services/localidad-lookup.service.js';
import { formatLocation } from '../../middleware/pending-field-city-handler.js';
import { getSetting } from '../../services/settings.service.js';
import { interpolate } from '../../utils/template.js';
import type { FinancialService } from '../financial/financial.service.js';
import { logError } from '../../services/error-logger.js';
import { GrainPriceService, formatGrainBoard, normalizeGrainCrop } from '../../services/grain-price.service.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse, InteractiveMessage } from '../../types/index.js';

// Singleton a nivel módulo: el caché de 30 min de la pizarra vive acá.
const grainPriceService = new GrainPriceService();

export class SystemHandler {
  private financialService: FinancialService | null;
  private planRepo: PlanRepository;

  constructor(private userRepo: UserRepository, financialService?: FinancialService | null) {
    this.financialService = financialService ?? null;
    this.planRepo = new PlanRepository();
  }

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      case 'greeting': {
        const nombre = user.name ? `, ${user.name}` : '';
        const botName = (await getSetting('BOT_NAME')) || 'MIA';
        const vars = { nombre, botName };

        // Onboarding: if user has no fields, guide them to create one
        if (this.financialService) {
          const fields = await this.financialService.getUserFields(userId);
          if (fields.length === 0) {
            const template = (await getSetting('GREETING_NEW_USER_MESSAGE')) || '';
            return {
              messages: [interpolate(template, vars)],
              interactive: {
                type: 'buttons',
                body: '\u00bfQuer\u00e9s crear tu primer campo?',
                buttons: [
                  { id: 'cmd_agregar_campo', title: 'Crear Campo' },
                  { id: 'menu_ayuda', title: 'Ayuda' },
                ],
              },
            };
          }

          // Tier 2: has fields but no plots → guide to create a lote
          const allPlots = await this.financialService.findAllUserPlots(userId);
          if (allPlots.length === 0) {
            const fieldName = fields[0].name || 'tu campo';
            const template = (await getSetting('GREETING_NO_PLOTS_MESSAGE')) || '';
            return {
              messages: [interpolate(template, { ...vars, fieldName })],
              interactive: {
                type: 'buttons',
                body: '\u00bfQuer\u00e9s crear tu primer lote?',
                buttons: [
                  { id: 'cmd_agregar_lote', title: 'Crear Lote' },
                  { id: 'menu_ayuda', title: 'Ayuda' },
                ],
              },
            };
          }
        }

        const template = (await getSetting('GREETING_NORMAL_MESSAGE')) || '';
        return {
          messages: [interpolate(template, vars)],
          interactive: {
            type: 'buttons',
            body: '\u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'menu_gastos', title: 'Gastos' },
              { id: 'menu_clima', title: 'Clima' },
              { id: 'back_menu', title: 'Ver Men\u00fa' },
            ],
          },
        };
      }

      case 'help': {
        const helpBotName = (await getSetting('BOT_NAME')) || 'MIA';
        // Direct shortcut: "ayuda gastos" / "ayuda lluvia" / etc → jump
        // straight to that section without the category picker.
        const sectionKey = (cmd.helpSection as string) || '';
        if (sectionKey && HELP_SECTIONS[sectionKey]) {
          return { messages: [HELP_SECTIONS[sectionKey]] };
        }
        // Default: paginated category list
        const { message, interactive } = buildHelpMenu(user.name, helpBotName);
        const { getSupportLine } = await import('../../services/support-contact.js');
        const helpSupport = await getSupportLine();
        return { messages: [helpSupport ? `${message}\n\n${helpSupport}` : message], interactive };
      }

      case 'help_section': {
        const key = (cmd.helpSection as string) || '';
        if (key && HELP_SECTIONS[key]) {
          return { messages: [HELP_SECTIONS[key]] };
        }
        const helpBotName = (await getSetting('BOT_NAME')) || 'MIA';
        const { message, interactive } = buildHelpMenu(user.name, helpBotName);
        return { messages: [message], interactive };
      }

      case 'menu':
        return {
          messages: [],
          interactive: {
            type: 'list',
            body: '\ud83d\udccb *Men\u00fa principal*\nEleg\u00ed una opci\u00f3n o escrib\u00ed directamente lo que necesit\u00e9s.',
            buttonText: 'Ver opciones',
            sections: [
              {
                title: 'Registrar',
                rows: [
                  { id: 'flow_new_expense', title: '\ud83d\udcb8 Nuevo Gasto', description: 'Registrar paso a paso' },
                  { id: 'flow_new_income', title: '\ud83d\udcb0 Nuevo Ingreso', description: 'Registrar paso a paso' },
                ],
              },
              {
                title: 'Documentos',
                rows: [
                  { id: 'doc_upload_factura', title: '🧾 Cargar Factura', description: 'Registrar gastos desde factura' },
                  { id: 'doc_upload_remito', title: '📋 Cargar Remito', description: 'Cargar stock desde remito' },
                ],
              },
              {
                title: 'Finanzas',
                rows: [
                  { id: 'cmd_resumen_mensual', title: '\ud83d\udcc8 Resultado Mes', description: 'Ingresos vs gastos' },
                  { id: 'menu_reportes', title: '\ud83d\udcca Reportes', description: 'Semanal, CSV, agron\u00f3mico' },
                  { id: 'menu_dolar', title: '\ud83d\udcb5 D\u00f3lar', description: 'Cotizaci\u00f3n actual' },
                ],
              },
              {
                title: 'Campo',
                rows: [
                  { id: 'menu_clima', title: '\u2600\ufe0f Clima', description: 'Pron\u00f3stico del tiempo' },
                  { id: 'menu_lluvia', title: '\ud83c\udf27\ufe0f Lluvia', description: 'Registrar, ver reportes' },
                  { id: 'menu_campos', title: '\ud83c\udfe1 Campos', description: 'Listar, agregar campos' },
                ],
              },
              {
                title: 'Sistema',
                rows: [
                  { id: 'menu_config', title: '\u2699\ufe0f Configuraci\u00f3n', description: 'Alertas y preferencias' },
                  { id: 'menu_ayuda', title: '\u2753 Ayuda', description: 'Ver todos los comandos' },
                ],
              },
            ],
          },
        };

      case 'show_expense_menu':
        return {
          messages: [],
          interactive: {
            type: 'buttons',
            body: '\ud83d\udcb8 *Gastos* \u2014 \u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'cmd_resumen_mensual', title: 'Resumen Mensual' },
              { id: 'cmd_reporte_mensual', title: 'Reporte' },
              { id: 'cmd_borrar_ultimo_gasto', title: 'Borrar \u00daltimo' },
            ],
          },
        };

      case 'show_income_menu':
        return {
          messages: [],
          interactive: {
            type: 'buttons',
            body: '\ud83d\udcb0 *Ingresos* \u2014 \u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'cmd_ingresos_mes', title: 'Ingresos del Mes' },
              { id: 'cmd_reporte_ingresos', title: 'Reporte' },
              { id: 'cmd_borrar_ultimo_ingreso', title: 'Borrar \u00daltimo' },
            ],
          },
        };

      case 'show_rain_menu':
        return {
          messages: [],
          interactive: {
            type: 'buttons',
            body: '\ud83c\udf27\ufe0f *Lluvia* \u2014 \u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'cmd_registrar_lluvia', title: 'Registrar Lluvia' },
              { id: 'cmd_reporte_lluvia', title: 'Reporte Lluvia' },
              { id: 'back_menu', title: 'Volver' },
            ],
          },
        };

      case 'show_fields_menu':
        return {
          messages: [],
          interactive: {
            type: 'buttons',
            body: '\ud83c\udfe1 *Campos* \u2014 \u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'cmd_listar_campos', title: 'Listar Campos' },
              { id: 'cmd_agregar_campo', title: 'Agregar Campo' },
              { id: 'back_menu', title: 'Volver' },
            ],
          },
        };

      case 'show_reports_menu':
        return {
          messages: [],
          interactive: {
            type: 'list',
            body: '📊 *Reportes* — Elegí el que necesités:',
            buttonText: 'Ver Reportes',
            sections: [
              {
                title: '💰 Financiero',
                rows: [
                  { id: 'cmd_resumen_mensual', title: 'Resultado del Mes', description: 'Ingresos vs gastos del mes' },
                  { id: 'cmd_reporte_mensual', title: 'Detalle Mensual', description: 'Gastos desglosados por categoría' },
                  { id: 'cmd_reporte_semanal', title: 'Resumen Semanal', description: 'Movimientos de la semana' },
                  { id: 'cmd_exportar_csv', title: 'Exportar CSV', description: 'Descargar datos en planilla' },
                ],
              },
              {
                title: '🌱 Agronómico',
                rows: [
                  { id: 'cmd_reporte_agro', title: 'Reporte Agronómico', description: 'Actividades y observaciones' },
                  { id: 'cmd_historial_lote', title: 'Historial de Lote', description: 'Timeline completo de un lote' },
                ],
              },
              {
                title: '🌧️ Lluvias',
                rows: [
                  { id: 'cmd_reporte_lluvia', title: 'Reporte de Lluvia', description: 'Acumulados por campo y período' },
                ],
              },
            ],
          },
        };

      case 'show_agro_menu':
        return {
          messages: [],
          interactive: {
            type: 'buttons',
            body: '\ud83c\udf31 *Agronom\u00eda* \u2014 \u00bfQu\u00e9 quer\u00e9s hacer?',
            buttons: [
              { id: 'cmd_reporte_agro', title: 'Reporte Agro' },
              { id: 'menu_lluvia', title: 'Lluvia' },
              { id: 'back_menu', title: 'Volver' },
            ],
          },
        };

      case 'prompt_rainfall':
        return {
          messages: ['Para registrar lluvia, escrib\u00ed algo como:\n\n_\"Llovieron 25mm\"_\n_\"Cayeron 40 milimetros en campo norte\"_'],
        };

      case 'prompt_add_field':
        return {
          messages: ['Para agregar un campo, escrib\u00ed:\n\n_\"Agregar campo [nombre]\"_\n\nEj: _\"Agregar campo La Esperanza\"_'],
        };

      case 'prompt_add_plot':
        return {
          messages: ['Para agregar un lote, escrib\u00ed:\n\n_\"Agregar lote [nombre]\"_\n\nEj: _\"Agregar lote A1\"_\n\nSi ten\u00e9s varios campos, especific\u00e1 cu\u00e1l:\n_\"Agregar lote A1 en campo Norte\"_'],
        };

      case 'thanks':
        return { messages: ['De nada \ud83d\udc4d Cualquier cosa, ac\u00e1 estoy.'] };

      case 'ack':
        return { messages: ['\ud83d\udc4d'] };

      case 'dollar': {
        try {
          const resp = await fetch('https://dolarapi.com/v1/dolares');
          const data = await resp.json() as Array<{ nombre: string; compra: number | null; venta: number | null; fechaActualizacion: string }>;
          let msg = '\ud83d\udcb5 *Cotizaci\u00f3n del d\u00f3lar*\n';
          for (const d of data) {
            const fecha = new Date(d.fechaActualizacion);
            const fechaStr = String(fecha.getDate()).padStart(2, '0') + '/' + String(fecha.getMonth() + 1).padStart(2, '0') + '/' + fecha.getFullYear();
            const compra = d.compra != null ? `$${Number(d.compra).toLocaleString('es-AR')}` : '-';
            const venta = d.venta != null ? `$${Number(d.venta).toLocaleString('es-AR')}` : '-';
            msg += `\n*${d.nombre}*\nCompra: ${compra} | Venta: ${venta}\n\ud83d\udcc5 ${fechaStr}\n`;
          }
          return { messages: [msg] };
        } catch (e: unknown) {
          console.error('DOLLAR API ERROR:', (e as Error).message);
          logError('system', 'DOLLAR_API', e as Error);
          return { messages: ['No pude obtener la cotizaci\u00f3n del d\u00f3lar. Intent\u00e1 m\u00e1s tarde.'] };
        }
      }

      case 'grain_prices': {
        try {
          const requested = normalizeGrainCrop(cmd.crop as string | null);
          if (requested === 'unsupported') {
            return { messages: [`Por ahora solo tengo cotización de *soja, maíz y trigo* (Matba-Rofex no publica disponible de ${cmd.crop}).\nPedime *pizarra* para verlos.`] };
          }
          const board = await grainPriceService.getBoard();
          if (!board) {
            return { messages: ['No pude consultar la pizarra en este momento. Probá de nuevo en unos minutos.'] };
          }
          return { messages: [formatGrainBoard(board, requested)] };
        } catch (e: unknown) {
          console.error('GRAIN_PRICES ERROR:', (e as Error).message);
          logError('system', 'GRAIN_PRICES', e as Error);
          return { messages: ['No pude consultar la pizarra en este momento. Probá de nuevo en unos minutos.'] };
        }
      }

      case 'show_plan': {
        // El CTA de los feature-gates y del trial vencido dice "Escribí *plan*"
        // — este comando cierra ese loop (era un CTA roto, ronda 3 Jul 2026).
        // Costo cero, disponible con trial vencido.
        try {
          const plan = await this.planRepo.getUserPlan(userId);
          const planName = plan?.display_name ?? 'Gratis';

          let trialLine = '';
          try {
            const { rows } = await pool.query(
              `SELECT status, trial_ends_at FROM subscriptions
               WHERE user_id = $1 AND status IN ('trial','active','past_due')
               ORDER BY created_at DESC LIMIT 1`,
              [userId],
            );
            if (rows[0]?.status === 'trial' && rows[0].trial_ends_at) {
              const days = Math.ceil((new Date(rows[0].trial_ends_at).getTime() - Date.now()) / 86400000);
              trialLine = days > 0
                ? ` _(prueba — te quedan ${days} día${days === 1 ? '' : 's'})_`
                : ' _(prueba vencida)_';
            } else if (rows[0]?.status === 'past_due') {
              trialLine = ' _(pago pendiente)_';
            }
          } catch { /* sin tabla subscriptions o sin fila: mostramos solo el plan */ }

          const aiLimit = plan?.daily_ai_limit != null ? Number(plan.daily_ai_limit) : null;
          const limitLine = aiLimit ? `\n🤖 Consultas con IA por día: ${aiLimit}` : '';

          // Enterprise se asigna a mano (precio 0 en la tabla) — no se lista.
          const all = (await this.planRepo.getAllPlans()).filter(p => p.name !== 'enterprise');
          const planLines = all.map(p => {
            const price = Number(p.price_ars) > 0 ? `$${Number(p.price_ars).toLocaleString('es-AR')}/mes` : 'sin costo';
            const current = plan?.id === p.id ? ' ← tu plan' : '';
            return `• *${p.display_name}* — ${price}${current}`;
          }).join('\n');

          let base = 'https://campo-bot-production.up.railway.app';
          const publicUrl = await getSetting('PUBLIC_URL');
          if (publicUrl && /^https?:\/\//.test(publicUrl)) base = publicUrl.replace(/\/$/, '');

          const { getSupportLine } = await import('../../services/support-contact.js');
          const supportLine = await getSupportLine();

          return {
            messages: [
              `📋 Tu plan: *${planName}*${trialLine}${limitLine}\n\n` +
              `*Planes disponibles:*\n${planLines}\n\n` +
              `Para cambiar de plan entrá a tu panel:\n${base}/dashboard` +
              (supportLine ? `\n\n${supportLine}` : ''),
            ],
          };
        } catch (e: unknown) {
          console.error('SHOW_PLAN ERROR:', (e as Error).message);
          logError('system', 'SHOW_PLAN', e as Error);
          return { messages: ['No pude consultar tu plan en este momento. Probá de nuevo en unos minutos.'] };
        }
      }

      case 'disable_tips': {
        await pool.query(`UPDATE user_settings SET tips_enabled = FALSE WHERE user_id = $1`, [userId]);
        return { messages: ['👍 Listo, no te muestro más consejos.\n\n_Si los querés de vuelta: "dame tips de nuevo"._'] };
      }

      case 'enable_tips': {
        await pool.query(`UPDATE user_settings SET tips_enabled = TRUE WHERE user_id = $1`, [userId]);
        return { messages: ['💡 Consejos activados de nuevo — te voy mostrando capacidades a medida que uses el bot.'] };
      }

      case 'create_reminder': {
        const desc = (cmd.description as string | null)?.trim();
        if (!desc) {
          return { messages: ['¿Qué te recuerdo y cuándo? Ej: *"acordame el sábado de fumigar el lote 5"*.'] };
        }
        const { createReminder, resolveFutureDate } = await import('../../services/reminder.service.js');
        const dueDate = (cmd.due_date as string | null)
          || resolveFutureDate(cmd.originalText as string | null)
          || resolveFutureDate(desc);
        if (!dueDate) {
          return { messages: [`¿Para cuándo te lo recuerdo? Decime la frase completa con la fecha, ej: *"acordame el viernes de ${desc}"*.`] };
        }
        const r = await createReminder(Number(userId), desc, dueDate);
        const dd = `${r.due_date.slice(8, 10)}/${r.due_date.slice(5, 7)}`;
        return { messages: [`⏰ Listo, te lo recuerdo el *${dd}*:\n"${r.description}"\n\n_"mis recordatorios" para ver todos._`] };
      }

      case 'list_reminders': {
        const { listReminders, formatReminderList } = await import('../../services/reminder.service.js');
        const rs = await listReminders(Number(userId));
        return { messages: [formatReminderList(rs)] };
      }

      case 'complete_reminder': {
        const { completeReminder } = await import('../../services/reminder.service.js');
        const done = await completeReminder(Number(userId), {
          id: cmd.reminderId ? Number(cmd.reminderId) : null,
          descriptionLike: (cmd.description as string | null) || null,
          cancel: cmd.cancel === true,
        });
        if (!done) return { messages: ['No encontré ese recordatorio pendiente. *mis recordatorios* para ver la lista.'] };
        return { messages: [done.status === 'cancelled' ? `🗑️ Cancelado: "${done.description}"` : `✅ Hecho: "${done.description}"`] };
      }

      case 'show_alerts': {
        const dayNames = ['Domingo', 'Lunes', 'Martes', 'Mi\u00e9rcoles', 'Jueves', 'Viernes', 'S\u00e1bado'];
        let msg = '\u2699\ufe0f *Tu configuraci\u00f3n de alertas*\n\n';
        msg += `\ud83c\udf27\ufe0f Alertas de lluvia: ${settings.rain_alerts ? '\u2705 Activado' : '\u274c Desactivado'}\n`;
        msg += `   Umbral: ${settings.rain_alert_mm || 10}mm\n`;
        msg += `\ud83d\udcb0 Alertas de presupuesto: ${settings.budget_alerts ? '\u2705 Activado' : '\u274c Desactivado'}\n`;
        msg += `\ud83d\udcca Resumen semanal: ${settings.weekly_summary ? '\u2705 Activado' : '\u274c Desactivado'}\n`;
        if (settings.weekly_summary) {
          msg += `   ${dayNames[settings.weekly_summary_day || 0]} a las ${String(settings.weekly_summary_hour || 19).padStart(2, '0')}:00\n`;
        }
        msg += `\u2705 Confirmar antes de guardar: ${settings.confirm_before_save ? 'S\u00ed' : 'No'}\n`;
        msg += `\n_Comandos: activar/desactivar lluvia, presupuesto, resumen_\n`;
        msg += `_Ej: alerta lluvia 20mm_`;
        return { messages: [msg] };
      }

      case 'set_rain_threshold':
        await this.userRepo.updateSetting(userId, 'rain_alert_mm', cmd.mm as number);
        return { messages: [`\ud83c\udf27\ufe0f Umbral de alerta de lluvia actualizado a *${cmd.mm}mm*\nVas a recibir alertas cuando se pronostiquen lluvias de ${cmd.mm}mm o m\u00e1s.`] };

      case 'enable_rain_alerts':
        await this.userRepo.updateSetting(userId, 'rain_alerts', true);
        return { messages: ['\ud83c\udf27\ufe0f Alertas de lluvia *activadas*.\nUmbral actual: ' + (settings.rain_alert_mm || 10) + 'mm'] };

      case 'disable_rain_alerts':
        await this.userRepo.updateSetting(userId, 'rain_alerts', false);
        return { messages: ['\ud83c\udf27\ufe0f Alertas de lluvia *desactivadas*.'] };

      case 'enable_budget_alerts':
        await this.userRepo.updateSetting(userId, 'budget_alerts', true);
        return { messages: ['\ud83d\udcb0 Alertas de presupuesto *activadas*.'] };

      case 'disable_budget_alerts':
        await this.userRepo.updateSetting(userId, 'budget_alerts', false);
        return { messages: ['\ud83d\udcb0 Alertas de presupuesto *desactivadas*.'] };

      case 'enable_weekly_summary':
        await this.userRepo.updateSetting(userId, 'weekly_summary', true);
        return { messages: ['\ud83d\udcca Resumen semanal *activado*.'] };

      case 'disable_weekly_summary':
        await this.userRepo.updateSetting(userId, 'weekly_summary', false);
        return { messages: ['\ud83d\udcca Resumen semanal *desactivado*.'] };

      case 'set_name':
        await this.userRepo.updateSetting(userId, 'confirm_before_save', settings.confirm_before_save);
        await this.userRepo.setName(userId, cmd.name as string);
        return { messages: [`\u2705 Listo, ${cmd.name}. Ya te tengo registrado.`] };

      case 'set_city': {
        const cityInput = cmd.city as string;
        const lookupResult = localidadLookup.lookup(cityInput);

        if (lookupResult.status === 'exact') {
          const loc = lookupResult.matches[0];
          await this.userRepo.setCity(userId, loc.nombre, loc.provincia);
          return { messages: [`\ud83d\udccd Ubicaci\u00f3n guardada: *${formatLocation(loc.nombre, loc.provincia)}*\nAhora el clima va a ser de tu zona.`] };
        }

        if (lookupResult.status === 'disambiguate') {
          const options = lookupResult.matches.map(m => `\u2022 ${m.nombre}, ${m.provincia}`).join('\n');
          return { messages: [`Hay varias localidades con ese nombre:\n${options}\n\nIndic\u00e1me la provincia para guardar tu ubicaci\u00f3n.`] };
        }

        if (lookupResult.status === 'suggestions') {
          const suggestions = lookupResult.matches.map(m => `\u2022 ${m.nombre}, ${m.provincia}`).join('\n');
          return { messages: [`No encontr\u00e9 "${cityInput}". \u00bfQuisiste decir?\n${suggestions}`] };
        }

        // not_found — save as-is without province
        await this.userRepo.setCity(userId, cityInput);
        return { messages: [`\ud83d\udccd Ubicaci\u00f3n guardada: *${cityInput}*\nNo encontr\u00e9 esa localidad en el listado censal, pero la guard\u00e9 igual.\nAhora el clima va a ser de tu zona.`] };
      }

      case 'request_more_messages': {
        // Log the request for analytics
        try {
          const plan = await this.planRepo.getUserPlan(userId);
          const dailyCount = await this.userRepo.getDailyClaudeCount(userId);
          await pool.query(
            `INSERT INTO ai_limit_requests (user_id, plan_name, daily_count) VALUES ($1, $2, $3)`,
            [userId, plan?.name ?? 'unknown', dailyCount],
          );
        } catch {
          // Fire-and-forget
        }
        return {
          messages: [
            '\ud83d\udce9 Registramos tu solicitud de m\u00e1s mensajes.\n\n'
            + 'Tu plan actual tiene un l\u00edmite diario de mensajes con IA. '
            + 'Pod\u00e9s seguir usando comandos directos (registrar gastos, ver reportes, etc.) sin l\u00edmite.\n\n'
            + 'Para ampliar tu l\u00edmite, consult\u00e1 con el administrador sobre los planes disponibles.',
          ],
        };
      }

      default:
        return { messages: [] };
    }
  }
}
