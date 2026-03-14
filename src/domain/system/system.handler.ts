import { UserRepository } from '../users/user.repository.js';
import { buildHelpText } from './help-text.js';
import type { UserId, User, UserSettings, ParsedCommand, HandlerResponse, InteractiveMessage } from '../../types/index.js';

export class SystemHandler {
  constructor(private userRepo: UserRepository) {}

  async handleCommand(cmd: ParsedCommand, userId: UserId, user: User, settings: UserSettings): Promise<HandlerResponse> {
    switch (cmd.command) {
      case 'greeting': {
        const nombre = user.name ? `, ${user.name}` : '';
        return {
          messages: [`Hola${nombre} \ud83d\udc4b Soy *MIA*, tu asistente de gesti\u00f3n agr\u00edcola.`],
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

      case 'help':
        return { messages: [buildHelpText(user.name)] };

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
              { id: 'cmd_borrar_ultimo_ingreso', title: 'Borrar \u00daltimo' },
              { id: 'back_menu', title: 'Volver al Men\u00fa' },
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
            type: 'buttons',
            body: '\ud83d\udcca *Reportes* \u2014 \u00bfCu\u00e1l quer\u00e9s?',
            buttons: [
              { id: 'cmd_reporte_semanal', title: 'Semanal' },
              { id: 'cmd_exportar_csv', title: 'Exportar CSV' },
              { id: 'cmd_reporte_agro', title: 'Agron\u00f3mico' },
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
          return { messages: ['No pude obtener la cotizaci\u00f3n del d\u00f3lar. Intent\u00e1 m\u00e1s tarde.'] };
        }
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

      case 'set_city':
        await this.userRepo.setCity(userId, cmd.city as string);
        return { messages: [`\ud83d\udccd Ubicaci\u00f3n guardada: *${cmd.city}*\nAhora el clima va a ser de tu zona.`] };

      default:
        return { messages: [] };
    }
  }
}
