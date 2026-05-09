// Help is now category-based: a list of topics, each with its own
// short cheat-sheet. The single 90-line wall-of-text was hard to scan
// on mobile and gave new users no entry point.

import type { InteractiveMessage } from '../../types/index.js';

/** Menu entry: a list of help topics. User taps one → sees that section. */
export function buildHelpMenu(userName: string | null, botName: string = 'MIA'): {
  message: string;
  interactive: InteractiveMessage;
} {
  const nombre = userName ? `, ${userName}` : '';
  return {
    message: `👋 Hola${nombre}, soy *${botName}*.\nElegí una categoría para ver ejemplos:`,
    interactive: {
      type: 'list',
      body: 'Categorías de ayuda',
      buttonText: 'Ver categorías',
      sections: [
        {
          title: 'Lo más usado',
          rows: [
            { id: 'help_gastos', title: '💰 Gastos e Ingresos', description: 'Cargar pagos, ventas, facturas' },
            { id: 'help_actividades', title: '🌱 Cultivos y Actividades', description: 'Sembrar, fumigar, fertilizar' },
            { id: 'help_lluvia', title: '🌧️ Lluvia y Clima', description: 'Registrar lluvia, ver pronóstico' },
          ],
        },
        {
          title: 'Operación',
          rows: [
            { id: 'help_cosecha', title: '🌾 Cosecha y Stock', description: 'Cargas, silo, insumos' },
            { id: 'help_hacienda', title: '🐄 Hacienda', description: 'Vacas, terneros, transferencias' },
            { id: 'help_campos', title: '🏡 Campos y Lotes', description: 'Crear, editar, listar' },
          ],
        },
        {
          title: 'Análisis',
          rows: [
            { id: 'help_reportes', title: '📊 Reportes', description: 'Mensual, agro PDF, comparar' },
            { id: 'help_editar', title: '✏️ Editar y Borrar', description: 'Corregir últimos registros' },
            { id: 'help_config', title: '⚙️ Alertas y Config', description: 'Personalizar' },
          ],
        },
      ],
    },
  };
}

/** Per-category text. Each ends with a footer suggesting "menú" / "ayuda". */
export const HELP_SECTIONS: Record<string, string> = {
  help_gastos: `💰 *Gastos e Ingresos*

*Registrar gastos*
• "pagué 200 mil en gasoil"
• "500k en fertilizante en lote 3"
• "compré 100 lt de glifosato a 2000 c/u" (carga al stock + crea gasto)
• "sueldos 300 mil"
• "factura X de YPF 50mil" (también podés cargar foto)

*Registrar ingresos*
• "vendí 30 tn de soja a 300 dólares"
• "cobré 500 mil del alquiler"
• "ingreso 1.5 millones por arrendamiento"

*Tip*: si solo decís el monto sin lote (ej: "sueldos 300mil"), queda como gasto del campo, NO de un lote en particular.

_Escribí "menú" para volver._`,

  help_actividades: `🌱 *Cultivos y Actividades*

*Siembra*
• "sembré soja en lote 3"
• "sembramos 50 ha de maíz en lote norte"
• "sembré soja en 1A en septiembre"

*Fumigación / fertilización*
• "fumigué lote 3 con glifosato 2 lt/ha"
• "tiré 100 kg/ha de urea en lote norte"
• "regué el lote sur"

*Cosecha*
• "coseché soja en lote 3, 4500 kg/ha"
• "cosechamos 20 tn de maíz en lote A1"
• "cargá al silo" (después de cosechar)

*Consultar*
• "qué hay sembrado en lote 3"
• "actividades del lote norte"
• "cuándo se fumigó el lote 3"

_Escribí "menú" para volver._`,

  help_lluvia: `🌧️ *Lluvia y Clima*

*Registrar lluvia*
• "llovieron 25mm"
• "cayeron 30mm en lote 3"
• "20mm el lunes, 35 el martes y 12 el miércoles" (multi-día en un mensaje)

*Reportes*
• "lluvia este mes"
• "lluvia esta semana"
• "comparar lluvia marzo con febrero"
• "cuánto llovió en lote norte"

*Clima*
• "clima"
• "clima mañana"
• "clima 7 días"
• "clima en lote norte"

*Alertas*
• "alerta lluvia 20mm" (cambia el umbral)

_Escribí "menú" para volver._`,

  help_cosecha: `🌾 *Cosecha, Cargas y Stock*

*Cargas de cosecha (per camión)*
• "Pedro 30 tn, Juan 25 tn al silo de Cargill"
• "trajimos 38 tn al 14% de humedad"
• "cargas del lote 11A" (ver detalle)

*Stock de insumos*
• "compré 500 lt de glifosato a 2000 c/u"
• "cargué 200 kg de urea en galpón principal"
• "tengo 100 lt de glifosato" (ajuste manual)
• "stock de glifosato"
• "movimientos de glifosato"

*Stock de granos*
• "cargué 4200 kg de soja al silo" (después de cosechar suele aparecer botón)

_Escribí "menú" para volver._`,

  help_hacienda: `🐄 *Hacienda*

*Inventario*
• "agregar 50 vacas Angus al lote 3"
• "compré 10 vacas a 600 mil c/u" (carga inventario + gasto)
• "vendí 5 novillos del lote 1"
• "nacieron 3 terneros en lote 2"
• "murieron 2 vacas en feedlot"

*Mover / transferir*
• "pasé 30 vacas del lote 3 al feedlot"
• "destete: 20 terneros del lote 2 a corral 1"

*Sanidad y reproducción*
• "vacuné 100 vacas con aftosa"
• "hice tacto en 50 vacas: 45 preñadas, 5 vacías"
• "pesé 30 novillos, promedio 380 kg"

*Consultar*
• "cuántos animales tengo"
• "hacienda en lote 3"
• "promedio de preñez"

_Escribí "menú" para volver._`,

  help_campos: `🏡 *Campos y Lotes*

*Campos*
• "agregar campo La Esperanza en Pergamino"
• "mis campos"
• "info campo La Esperanza"
• "renombrar campo X a Y"
• "borrar campo X"

*Lotes*
• "agregar lote Norte al campo La Esperanza"
• "agregar lotes A1, A2, A3 de 50 ha cada uno"
• "lotes del campo La Esperanza"
• "info lote Norte"
• "lote 3 tiene 80 hectáreas"
• "borrar lote X"

*Compartir*
• "compartir campo La Esperanza" (genera código)
• "unirme ABC123" (acepta invitación)

_Escribí "menú" para volver._`,

  help_reportes: `📊 *Reportes*

*Financieros*
• "resumen mes"
• "resultado del mes"
• "resultado lote 3"
• "comparar marzo con febrero"
• "resumen desde 1/3 hasta 15/3"
• "cuánto gasté los últimos 10 días"
• "exportar mes" (CSV)

*Agronómicos*
• "reporte agro" (PDF, semana actual)
• "reporte agro lote 3"
• "reporte agro de enero a marzo"
• "estadísticas de la campaña del lote 3"
• "comparar campaña 2024 con 2023 del lote 3"

*Hacienda*
• "promedio de preñez"
• "evolución de peso"
• "GDPV"

_Escribí "menú" para volver._`,

  help_editar: `✏️ *Editar y Borrar*

*Borrar último*
• "borrar último gasto"
• "borrar último ingreso"
• "borrar última lluvia"

*Editar último*
• "editar último gasto a 250 mil"
• "no, era en lote B" (tras una actividad)
• "los sueldos eran del campo entero, no del lote 1A"
• "el gasoil sacale el lote"

*Borrar específico*
• "borrar gasto de semillas"
• "borrar cargas sin destinatario"

*Cancelar flujo*
• "cancelar" (cancela el wizard activo)

_Escribí "menú" para volver._`,

  help_config: `⚙️ *Alertas y Configuración*

*Ver*
• "alertas"
• "configuración"

*Lluvia*
• "alerta lluvia 20mm" (cambia umbral)
• "activar/desactivar alertas lluvia"

*Presupuesto*
• "presupuesto combustible 500 mil"
• "activar/desactivar alertas presupuesto"

*Resumen*
• "activar/desactivar resumen semanal"

*Personal*
• "soy Juan"
• "estoy en Junín"

*Reportes en PDF*
• Cualquier "reporte agro X" o "reporte campo X" se manda como PDF

_Escribí "menú" para volver._`,
};

/** Legacy single-text help (kept for callers that need a flat string). */
export function buildHelpText(userName: string | null, botName: string = 'MIA'): string {
  const nombre = userName ? ` ${userName}` : '';
  return `👋 Hola${nombre}, soy *${botName}*
Tu asistente de gestión agrícola 🌱

Tipiá *menú* para ver todas las opciones, o "ayuda" para ver categorías de ejemplos.

*Lo más usado*:
💰 "pagué 200mil en gasoil"
🌱 "sembré soja en lote 3"
🌧️ "llovieron 25mm"
📊 "resumen mes"
🐄 "compré 50 vacas"

Escribí *ayuda gastos* / *ayuda lluvia* / *ayuda hacienda* / etc. para ver más ejemplos por tema.`;
}
