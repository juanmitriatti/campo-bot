import type { UserContext } from './user-context.service.js';
import { getSetting } from '../services/settings.service.js';
import { EXPENSE_CATEGORIES_PROMPT, INCOME_CATEGORIES_PROMPT } from '../constants/agro-terms.js';

export class PromptBuilder {
  async build(userContext: UserContext | null): Promise<string> {
    const prefix = (await getSetting('AI_INTENT_SYSTEM_PROMPT_PREFIX')) || 'Asistente agrícola argentino.';
    const parts: string[] = [
      `${prefix} Extraé intención y datos del mensaje. Respondé SOLO JSON.`,
      this.intentSection(),
      this.agroRulesSection(),
      this.conventionsSection(),
    ];

    const ctx = this.contextLine(userContext);
    if (ctx) parts.push(ctx);

    parts.push('Formato: {"intent":"…","confidence":0.0-1.0,...campos}');

    return parts.join('\n');
  }

  private intentSection(): string {
    return `Intenciones:
log_expense: amount,category(${EXPENSE_CATEGORIES_PROMPT}),description,currency(ARS|USD),field?,plot?
log_income: amount(total),category(${INCOME_CATEGORIES_PROMPT}),description,currency,quantity?,unit?,unit_price?,field?,plot?
log_spraying: product,product_type(herbicida|insecticida|fungicida),quantity?,unit?,crop?,field?,plot?
log_fertilization: product,quantity?,unit?,crop?,field?,plot?
log_tillage: product(implemento),crop?,field?,plot?
log_irrigation: quantity?,unit?,crop?,field?,plot?
sow_crop: crop,plot?,field?
harvest_crop: crop,quantity?,unit?,plot?,field?
log_observation: observation,crop?,field?,plot?
log_rainfall: quantity(mm),field?
generate_agro_report: field?,plot?,date_range?
weather_full: field?
rainfall_report: period?(week=esta semana|month=este mes|year=este año|last_week=semana pasada|last_month=mes pasado|today=hoy),field?,plot?
monthly_report: -
weekly_report: -
field_report: field
plot_report: plot
monthly_result: -
date_range_report: desde?,hasta?,days?
query_plot_history: plot?,field?,timeRef?,activityFilter?
set_field_city: field,city? (ubicar campo/lote en una localidad)
show_reports_menu: - (quiero ver reportes/informes, sin tipo específico)
unknown: no encaja en ninguna`;
  }

  private agroRulesSection(): string {
    return `REGLAS PARSEO AGRÍCOLA (PRIORIDAD ALTA):
Sinónimos→intent: fumigué/pulvericé/curé/tiré/eché→log_spraying. fertilicé/aboné/metí+fertilizante→log_fertilization. sembré/implanté→sow_crop. coseché/levanté→harvest_crop. aré/pasé disco/disqueé/laburé→log_tillage. regué→log_irrigation.
Patrones compuestos (prioridad máxima): gasté/compré/pagué+insumo→log_expense. vendí/cobré+producto→log_income. fumigué/apliqué/tiré/eché+químico→log_spraying. apliqué/metí+fertilizante→log_fertilization. sembré+cultivo→sow_crop. coseché/levanté+cultivo→harvest_crop. pasé+implemento→log_tillage. llovieron+mm→log_rainfall.
Desambiguación: producto fertilizante(urea,DAP,MAP,fosfato,nitrato,potasio,sulfato)→log_fertilization. producto herbicida/insecticida/fungicida→log_spraying. apliqué/tiré/eché SIN producto→confidence<0.7. reporte+agronómico/agro→generate_agro_report. reporte+financiero/gastos/ingresos→field_report/plot_report. reporte+lote(sin contexto financiero)→generate_agro_report. reporte+campo(sin contexto financiero)→generate_agro_report. reporte+mes→monthly_report. reporte+semana→weekly_report.
NUNCA clasificar como actividad si: consulta(cómo/cuánto/qué/clima), descripción vaga(está lindo/viene bien), contexto sin acción(el lote del medio)→usar unknown o log_observation con confidence<0.7. EXCEPCIÓN: "cuánto llovió"/"llovió hoy"/"lluvia este mes"→rainfall_report (es consulta de datos, no actividad).
Prioridad decisión: 1.patrones compuestos 2.sinónimos+producto 3.keywords simples 4.fallback. CRÍTICO: No inventar datos que el usuario no mencionó→usar null. Si no dice cultivo→crop:null. Si no dice campo/lote→field:null,plot:null. Ambigüedad fuerte→confidence<0.7.`;
  }

  private conventionsSection(): string {
    return 'lucas=miles,palos=millones,mil=x1000,k=miles. Default ARS. "dólares/USD"→currency:"USD". Verbos gasto:pagué/gasté/compré. Ingreso:vendí/cobré. Actividad:fumigué/tiré/apliqué/fertilicé/aré/sembré/coseché. "reportes/informes" sin tipo→show_reports_menu. Si el historial muestra contexto previo, usalo para resolver referencias ambiguas.';
  }

  private contextLine(ctx: UserContext | null): string {
    if (!ctx) return '';

    const parts: string[] = [];

    if (ctx.fieldNames.length > 0) {
      parts.push(`campos:[${ctx.fieldNames.join(',')}]`);
    }
    if (ctx.plotNames.length > 0) {
      parts.push(`lotes:[${ctx.plotNames.join(',')}]`);
    }
    if (ctx.lastFieldName) {
      parts.push(`último campo:${ctx.lastFieldName}`);
    }
    if (ctx.lastPlotName) {
      parts.push(`último lote:${ctx.lastPlotName}`);
    }

    if (parts.length === 0) return '';

    return `Usuario: ${parts.join(', ')}`;
  }
}
