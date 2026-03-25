import type { UserContext } from './user-context.service.js';
import { getSetting } from '../services/settings.service.js';

export class PromptBuilder {
  async build(userContext: UserContext | null): Promise<string> {
    const prefix = (await getSetting('AI_INTENT_SYSTEM_PROMPT_PREFIX')) || 'Asistente agrícola argentino.';
    const parts: string[] = [
      `${prefix} Extraé intención y datos del mensaje. Respondé SOLO JSON.`,
      this.intentSection(),
      this.conventionsSection(),
    ];

    const ctx = this.contextLine(userContext);
    if (ctx) parts.push(ctx);

    parts.push('Formato: {"intent":"…","confidence":0.0-1.0,...campos}');

    return parts.join('\n');
  }

  private intentSection(): string {
    return `Intenciones:
log_expense: amount,category(Combustible|Fertilizantes|Semillas|Agroquímicos|Sueldos|Maquinaria|Arrendamiento|Impuestos|Otros),description,currency(ARS|USD),field?,plot?
log_income: amount(total),category(Soja|Maíz|Trigo|Girasol|Sorgo|Cebada|Hacienda|Arrendamiento|Otros),description,currency,quantity?,unit?,unit_price?,field?,plot?
log_spraying: product,product_type(herbicida|insecticida|fungicida),quantity?,unit?,crop?,field?,plot?
log_fertilization: product,quantity?,unit?,crop?,field?,plot?
log_tillage: product(implemento),crop?,field?,plot?
log_irrigation: quantity?,unit?,crop?,field?,plot?
sow_crop: crop,plot?,field?
harvest_crop: crop,quantity?,unit?,plot?,field?
log_observation: observation,crop?,field?,plot?
generate_agro_report: field?,plot?,date_range?
log_rainfall: quantity(mm),field?
unknown: no encaja en ninguna`;
  }

  private conventionsSection(): string {
    return 'lucas=miles,palos=millones,mil=x1000,k=miles. Default ARS. "dólares/USD"→currency:"USD". Verbos gasto:pagué/gasté/compré. Ingreso:vendí/cobré. Actividad:fumigué/tiré/apliqué/fertilicé/aré/sembré/coseché.';
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
