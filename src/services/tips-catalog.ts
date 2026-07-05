/**
 * tips-catalog.ts — Catálogo de tips contextuales de primera vez.
 *
 * Cada tip enseña UNA capacidad relacionada con la acción que el usuario
 * ACABA de hacer (descubrimiento por goteo, no tutorial). Reglas del motor
 * (tip-engine.ts): máximo TIPS_MAX_PER_DAY por día (default 1), cada tip se
 * muestra UNA sola vez en la vida del usuario, y solo tras acciones exitosas.
 *
 * Convenciones del catálogo:
 *  - `triggerCommands`: comandos (post-router) que habilitan el tip. Un
 *    comando puede disparar varios tips — salen en días distintos, en orden.
 *  - `requiresFeature`: si el tip enseña una feature gateada por plan
 *    (stock/livestock/docs), el motor la verifica antes de mostrarlo — nunca
 *    invitar a algo que el plan no tiene.
 *  - El texto es UNA línea, arranca con 💡 y muestra el fraseo EXACTO que el
 *    usuario puede copiar. Sin explicaciones largas.
 *
 * Para agregar un tip: entrada acá + nada más (el motor y el router ya están
 * cableados). Mantener las keys estables — son el registro de "ya visto".
 */

export interface Tip {
  /** Estable — se persiste en user_settings.tips_shown. */
  key: string;
  /** Comandos que lo habilitan (nombre post-router, ej 'log_expense'). */
  triggerCommands: string[];
  /** Texto completo del tip (una línea, empieza con 💡). */
  text: string;
  /** Feature gateada que el tip enseña (se valida el plan antes de mostrar). */
  requiresFeature?: import('../types/index.js').FeatureKey;
}

export const TIPS_CATALOG: Tip[] = [
  // ── Gastos / ingresos ──────────────────────────────────────────────────
  {
    key: 'audio',
    triggerCommands: ['log_expense', 'log_income'],
    text: '💡 También podés mandarme un *audio*: decí "gasté 20 mil en gasoil" hablando y lo registro igual.',
  },
  {
    key: 'query_gastos',
    triggerCommands: ['log_expense'],
    text: '💡 Preguntame *"cuánto gasté este mes"* o *"gastos del lote X"* — tus números siempre a mano.',
  },
  {
    key: 'factura_foto',
    triggerCommands: ['log_expense'],
    text: '💡 Sacale una *foto a la factura* y mandámela — leo el monto y el proveedor solos.',
    requiresFeature: 'documents',
  },
  {
    key: 'pizarra',
    triggerCommands: ['log_income', 'harvest_crop'],
    text: '💡 Preguntame *"a cuánto está la soja"* o mandá *"pizarra"* — te doy los precios de Rosario al día.',
  },
  {
    key: 'balance',
    triggerCommands: ['log_income'],
    text: '💡 Mandá *"cómo venimos de plata"* y te armo el balance del mes (ingresos − gastos, ARS y USD).',
  },

  // ── Agro: siembra / cosecha / labores ──────────────────────────────────
  {
    key: 'que_sembrado',
    triggerCommands: ['sow_crop'],
    text: '💡 Preguntame *"qué tengo sembrado"* cuando quieras — te muestro todos los cultivos activos por lote.',
  },
  {
    key: 'recordatorio',
    triggerCommands: ['sow_crop', 'log_spraying', 'log_fertilization', 'log_tillage'],
    text: '💡 ¿Labor a futuro? Decime *"acordame el sábado de fumigar"* y te aviso ese día.',
  },
  {
    key: 'stock_insumos',
    triggerCommands: ['log_spraying', 'log_fertilization'],
    text: '💡 Cargá tus insumos ("compré 100 lt de glifosato") y cuando fumigues te ofrezco *descontar el stock* solo.',
    requiresFeature: 'stock',
  },
  {
    key: 'cargas_camion',
    triggerCommands: ['harvest_crop'],
    text: '💡 En la cosecha podés pasarme los camiones: *"Pérez 28000 kg a Cargill, Gómez 30000 a ACA"* — llevo la cuenta por acopio.',
  },
  {
    key: 'saldo_acopio',
    triggerCommands: ['query_harvest_loads'],
    text: '💡 También: *"cuánta soja tengo en Cargill"* o *"cuánto entregué a cada acopio"*.',
  },
  {
    key: 'reporte_agro',
    triggerCommands: ['harvest_crop', 'campaign_stats'],
    text: '💡 Pedime *"reporte agro"* y te armo un PDF con toda la campaña: labores, rindes, lluvias y números.',
  },
  {
    key: 'monitoreo',
    triggerCommands: ['log_observation'],
    text: '💡 Si me das datos ("soja V3 con 15% rama negra") guardo un *monitoreo estructurado* — después pedí "cómo viene la sanidad".',
  },

  // ── Lluvia / clima ──────────────────────────────────────────────────────
  {
    key: 'lluvia_mes',
    triggerCommands: ['log_rainfall'],
    text: '💡 Preguntame *"cuánto llovió este mes"* o *"lluvias del año"* — llevo el acumulado por campo.',
  },
  {
    key: 'clima',
    triggerCommands: ['log_rainfall', 'sow_crop'],
    text: '💡 Mandá *"clima"* y te doy el pronóstico de tu zona (o *"clima en Pergamino"* para otra).',
  },

  // ── Hacienda ────────────────────────────────────────────────────────────
  {
    key: 'sanidad',
    triggerCommands: ['add_livestock'],
    text: '💡 Registrá la sanidad: *"vacuné las vacas contra aftosa"* — después preguntá "cuándo se vacunó".',
    requiresFeature: 'livestock',
  },
  {
    key: 'pesaje',
    triggerCommands: ['add_livestock', 'log_health_event'],
    text: '💡 Anotá pesadas: *"pesé los novillos a 380 kg"* — te calculo la ganancia diaria (GDPV) entre pesajes.',
    requiresFeature: 'livestock',
  },

  // ── Setup / general ─────────────────────────────────────────────────────
  {
    key: 'todo_junto',
    triggerCommands: ['add_plot', 'add_plots_batch'],
    text: '💡 Podés mandarme *todo junto*: "sembré soja en el Norte, gasté 80 mil en gasoil y llovieron 20mm" — registro las tres cosas.',
  },
  {
    key: 'dashboard',
    triggerCommands: ['financial_report'],
    text: '💡 Tenés un *panel web* con todos tus datos y gráficos — entrá con tu email en el sitio del bot.',
  },
];
