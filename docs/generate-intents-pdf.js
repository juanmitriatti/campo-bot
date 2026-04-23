import PDFDocument from 'pdfkit';
import fs from 'fs';

const doc = new PDFDocument({ size: 'A4', margin: 40 });
const output = fs.createWriteStream('docs/intents-reference.pdf');
doc.pipe(output);

const BLUE = '#1a56db';
const DARK = '#1f2937';
const GRAY = '#6b7280';
const LIGHT_BG = '#f3f4f6';
const WHITE = '#ffffff';

function sectionTitle(text) {
  doc.moveDown(0.8);
  doc.fontSize(14).fillColor(BLUE).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
  const y = doc.y;
  doc.moveTo(40, y).lineTo(555, y).strokeColor(BLUE).lineWidth(1).stroke();
  doc.moveDown(0.4);
}

function tableHeader(cols, widths) {
  const y = doc.y;
  doc.rect(40, y - 2, 515, 18).fill(BLUE);
  let x = 44;
  cols.forEach((col, i) => {
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold').text(col, x, y + 2, { width: widths[i] - 8 });
    x += widths[i];
  });
  doc.y = y + 20;
}

function tableRow(cols, widths, alt) {
  const startY = doc.y;
  const heights = cols.map((col, i) => {
    return doc.heightOfString(col, { width: widths[i] - 12, fontSize: 8.5 });
  });
  const rowH = Math.max(...heights, 14) + 6;

  if (startY + rowH > 780) {
    doc.addPage();
  }

  const y = doc.y;
  if (alt) {
    doc.rect(40, y - 1, 515, rowH).fill(LIGHT_BG);
  }

  let x = 44;
  cols.forEach((col, i) => {
    doc.fontSize(8.5).fillColor(DARK).font(i === 0 ? 'Courier' : 'Helvetica').text(col, x, y + 3, { width: widths[i] - 12 });
    x += widths[i];
  });
  doc.y = y + rowH;
}

// =====================
// TITLE
// =====================
doc.fontSize(22).fillColor(BLUE).font('Helvetica-Bold').text('MIA — Referencia de Intents', { align: 'center' });
doc.moveDown(0.2);
doc.fontSize(10).fillColor(GRAY).font('Helvetica').text('Listado completo de intents del agente AI para entrenamiento y corrección', { align: 'center' });
doc.moveDown(0.1);
doc.fontSize(9).fillColor(GRAY).text(`Generado: ${new Date().toLocaleDateString('es-AR')} — 74 tools`, { align: 'center' });

// =====================
// DATA
// =====================
const sections = [
  {
    title: 'Registros (escritura)',
    rows: [
      ['log_expense', 'Registrar gasto (+ unit_price)', '"gasté 50000 en gasoil", "50 bolsas urea a 8000 c/u"'],
      ['log_income', 'Registrar ingreso (+ unit_price)', '"vendí 30 tn de soja a 300 USD"'],
      ['log_spraying', 'Registrar fumigación', '"fumigué con glifosato 3 lt/ha"'],
      ['log_fertilization', 'Registrar fertilización', '"fertilicé con urea 100 kg/ha"'],
      ['log_tillage', 'Registrar labranza', '"pasé disco en lote sur"'],
      ['log_irrigation', 'Registrar riego', '"regué lote 3"'],
      ['sow_crop', 'Registrar siembra', '"sembré soja en lote 1"'],
      ['harvest_crop', 'Registrar cosecha (+ loads)', '"coseché 30 tn trigo", "1 camión 28tn"'],
      ['close_campaign', 'Cerrar campaña', '"cerrar campaña soja lote 1"'],
      ['log_observation', 'Registrar observación', '"hay chinches en soja lote 1"'],
      ['log_tacto', 'Registrar tacto/preñez', '"hice tacto, 60 preñadas y 20 vacías"'],
      ['log_rainfall', 'Registrar lluvia', '"llovieron 25mm"'],
      ['edit_last_activity', 'Corregir última actividad', '"la siembra era en lote B"'],
    ],
  },
  {
    title: 'Gastos Recurrentes (Templates)',
    rows: [
      ['create_expense_template', 'Crear gasto fijo/recurrente', '"gasto fijo mensual 50k combustible"'],
      ['list_expense_templates', 'Listar gastos fijos', '"mis gastos fijos"'],
      ['delete_expense_template', 'Borrar gasto fijo', '"borrar gasto fijo X"'],
    ],
  },
  {
    title: 'Consultas y Reportes',
    rows: [
      ['financial_report', 'Reporte financiero', '"gastos del mes", "reporte campo Norte"'],
      ['generate_agro_report', 'Reporte agronómico', '"reporte agro", "cómo va el lote?"'],
      ['campaign_stats', 'Estadísticas de campaña', '"cómo viene la campaña soja"'],
      ['compare_campaigns', 'Comparar campañas', '"comparar soja 2024 vs 2025"'],
      ['activity_stats', 'Estadísticas de actividades', '"cuántas fumigaciones hice?"'],
      ['active_crop', 'Cultivos activos / ha sembradas', '"hay soja?", "has sembradas"'],
      ['query_plot_history', 'Historial de actividades', '"cuándo se fumigó el lote norte?"'],
      ['query_harvest_loads', 'Consultar cargas de cosecha', '"camiones del lote A1"'],
      ['delete_harvest_loads', 'Borrar cargas de cosecha', '"borrar cargas del 10/4"'],
      ['rainfall_report', 'Reporte de lluvias', '"cuánto llovió este mes?"'],
      ['weather_full', 'Pronóstico (+ city, province)', '"clima en Ameghino Buenos Aires"'],
      ['share_report', 'Compartir reporte (PDF)', '"mandame el reporte por PDF"'],
      ['check_stock', 'Consultar stock', '"cuánto gasoil tengo?", "inventario"'],
      ['stock_history', 'Historial de stock', '"movimientos de urea"'],
      ['tacto_summary', 'Resumen de tacto/preñez', '"promedio del tacto", "tasa de preñez"'],
      ['list_livestock', 'Listar hacienda', '"cuántos animales tengo?"'],
      ['livestock_history', 'Historial de hacienda', '"historial vacas lote A1"'],
      ['list_documents', 'Listar documentos', '"mis facturas"'],
    ],
  },
  {
    title: 'Campos y Lotes',
    rows: [
      ['list_fields', 'Listar campos', '"mis campos"'],
      ['list_plots', 'Listar lotes', '"mis lotes", "qué lotes tiene el campo?"'],
      ['field_info', 'Info de un campo', '"info campo Norte"'],
      ['add_field', 'Agregar campo', '"agregar campo La Esperanza"'],
      ['add_plot', 'Agregar lote', '"agregar lote A1 en campo Norte"'],
      ['add_plots_batch', 'Agregar lotes (batch)', '"agregar lotes A1, A2, A3"'],
      ['set_plot_area', 'Asignar hectáreas', '"lote A1 tiene 50 ha"'],
      ['set_plot_grupo', 'Asignar grupo/sociedad', '"asignar grupo Pérez al lote 11A"'],
      ['set_field_city', 'Ubicar campo', '"ubicar campo en Pergamino"'],
      ['delete_field', 'Borrar campo', '"borrar campo X"'],
      ['delete_plot', 'Borrar lote', '"borrar lote A1"'],
      ['rename_field', 'Renombrar campo', '"renombrar campo X a Y"'],
      ['rename_plot', 'Renombrar lote', '"renombrar lote A1 a B1"'],
      ['restore_field', 'Restaurar campo', '"restaurar campo X"'],
      ['restore_plot', 'Restaurar lote', '"restaurar lote A1"'],
    ],
  },
  {
    title: 'Stock / Inventario',
    rows: [
      ['add_stock', 'Cargar stock', '"cargué 200 lt de glifosato"'],
      ['remove_stock', 'Sacar stock', '"usé 50 lt de gasoil"'],
      ['adjust_stock', 'Ajustar stock', '"tengo 500 lt de gasoil"'],
      ['create_warehouse', 'Crear galpón', '"crear galpón Norte"'],
      ['list_warehouses', 'Listar galpones', '"mis galpones"'],
      ['set_min_stock', 'Stock mínimo', '"stock mínimo gasoil 100 lt"'],
    ],
  },
  {
    title: 'Hacienda / Ganado',
    rows: [
      ['add_livestock', 'Entrada (+ precio → gasto auto)', '"compré 20 novillos a 500mil c/u"'],
      ['remove_livestock', 'Salida (+ precio → ingreso auto)', '"vendí 10 vacas a 800 USD c/u"'],
      ['transfer_livestock', 'Transferir animales', '"mové 10 vacas del lote A al B"'],
      ['record_livestock_death', 'Registrar muerte', '"se murieron 2 terneros"'],
      ['record_livestock_birth', 'Registrar nacimiento', '"nacieron 8 terneros"'],
      ['adjust_livestock', 'Ajustar conteo', '"en lote A1 hay 50 vacas"'],
    ],
  },
  {
    title: 'Feedlot / Corrales',
    rows: [
      ['create_feedlot', 'Crear feedlot', '"crear feedlot en campo Norte"'],
      ['list_feedlots', 'Listar feedlots', '"mis feedlots"'],
      ['delete_feedlot', 'Borrar feedlot', '"borrar feedlot X"'],
      ['create_corral', 'Crear corral', '"crear corral Recepción"'],
      ['list_corrals', 'Listar corrales', '"corrales"'],
      ['delete_corral', 'Borrar corral', '"borrar corral X"'],
      ['rename_corral', 'Renombrar corral', '"renombrar corral X a Y"'],
    ],
  },
  {
    title: 'Campos Compartidos (Sharing)',
    rows: [
      ['share_field', 'Compartir campo', '"compartir campo X"'],
      ['accept_invite', 'Aceptar invitación', '"unirme ABC123"'],
      ['list_field_members', 'Listar miembros', '"miembros campo X"'],
      ['remove_field_member', 'Quitar miembro', '"quitar a Juan de campo X"'],
    ],
  },
  {
    title: 'Documentos',
    rows: [
      ['link_document_to_expense', 'Vincular doc a gasto', '"vincular factura al gasto"'],
    ],
  },
  {
    title: 'Sistema',
    rows: [
      ['respond_text', 'Respuesta conversacional', '(saludo, pregunta general, agradecimiento)'],
    ],
  },
];

const colWidths = [130, 175, 210];

for (const section of sections) {
  sectionTitle(section.title);
  tableHeader(['Intent', 'Descripción', 'Ejemplo'], colWidths);
  section.rows.forEach((row, i) => tableRow(row, colWidths, i % 2 === 1));
}

// =====================
// NOTES
// =====================
doc.addPage();
sectionTitle('Reglas clave de desambiguación');
doc.fontSize(9).fillColor(DARK).font('Helvetica');

const notes = [
  '• "Q lotes tiene el campo?" → list_plots (NO query_plot_history). query_plot_history es para historial de actividades (cuándo se fumigó, qué se sembró).',
  '• query_plot_history = consulta de actividades pasadas ("cuándo se fumigó", "qué se sembró"). NO es para listar lotes.',
  '• financial_report = reportes con montos (gastos, ingresos, resultado). generate_agro_report = reportes con actividades y observaciones.',
  '• log_observation = REGISTRAR observación agronómica (plagas, malezas, fenología). NO es para consultas ni listados.',
  '• check_stock = consulta de inventario ("cuánto tengo", "hay X?", "qué hay en el galpón"). add_stock/remove_stock = registrar movimiento.',
  '• "gasté" + monto → log_expense. "gasté/usé" + producto sin monto → remove_stock.',
  '• Actividades agro (fumigué, sembré, coseché) → SIEMPRE tool de actividad, NUNCA log_expense, salvo monto explícito.',
  '• Hacienda (vacas, terneros, novillos) + cantidad → SIEMPRE tool de hacienda, NUNCA log_observation.',
  '• Tacto REGISTRO ("hice tacto", "palpé", "revisé preñez") → SIEMPRE log_tacto. Tacto CONSULTA ("promedio", "tasa de preñez") → tacto_summary.',
  '• Feedlot: "corral X" ≠ "lote X". Los corrales son entidades del sistema intensivo de feedlot, separadas de los lotes de campo.',
  '• respond_text = el agente responde sin ejecutar ninguna acción. Para saludos, agradecimientos, preguntas agronómicas generales.',
];

for (const note of notes) {
  doc.text(note, 44, doc.y, { width: 500 });
  doc.moveDown(0.4);
}

sectionTitle('Nuevas reglas (2026-04)');
doc.fontSize(9).fillColor(DARK).font('Helvetica');

const newRules = [
  '• PRECIO UNITARIO en log_expense: "a X c/u", "a X el kg/bolsa/lt", "cada uno a X" → capturar unit_price y amount=quantity*unit_price.',
  '  Ej: "50 bolsas de urea a 8000 c/u" → quantity=50, unit=bolsas, unit_price=8000, amount=400000.',
  '',
  '• CLIMA con ciudad explícita: "clima/pronóstico/va a llover en X" → weather_full(city=X). NUNCA asumir ubicación del usuario si la menciona.',
  '  Si menciona provincia ("clima en Ameghino Buenos Aires") → weather_full(city="Ameghino", province="Buenos Aires").',
  '  Sin ciudad ("clima", "va a llover") → weather_full sin params (usa ubicación del usuario).',
  '',
  '• HACIENDA con precio → gasto/ingreso automático: add_livestock con unit_price_ars o unit_price_usd crea gasto "Hacienda" con el total.',
  '  remove_livestock con unit_price crea ingreso "Hacienda". Se linkea el movement con la transacción financiera.',
  '',
  '• GASTOS RECURRENTES: "gasto fijo/recurrente/mensual/semanal" → create_expense_template. NUNCA confundir con log_expense (registro único).',
  '  "mis gastos fijos"/"gastos recurrentes" → list_expense_templates. "borrar gasto fijo" → delete_expense_template.',
  '',
  '• CULTIVOS ACTIVOS (active_crop): "soja?", "hay soja?", "has sembradas", "hectáreas sembradas", "qué tengo sembrado" → SIEMPRE active_crop.',
  '  Si el mensaje menciona un cultivo (soja/maíz/trigo/...) O "sembrado/sembradas" → active_crop, NUNCA list_plots.',
  '',
  '• COSECHA con cargas: "coseché 30tn, camión ABC 15tn a Cargill, camión XYZ 15tn a ACA" → harvest_crop con array loads[].',
  '  Cada load: driver_name, weight_kg, destination, destinatario, truck_plate.',
];

for (const note of newRules) {
  doc.text(note, 44, doc.y, { width: 500 });
  doc.moveDown(0.3);
}

sectionTitle('Alertas de clima');
doc.fontSize(9).fillColor(DARK).font('Helvetica');

const weatherAlerts = [
  'Corren diariamente a las 06:00 AR (configurable). Dedup 24hs por ciudad+día+tipo.',
  '',
  '• Lluvia: hoy + próximos 2 días. Umbral: user_settings.rain_alert_mm (default 10mm).',
  '• Viento: hoy + próximos 2 días. Umbral: user_settings.wind_alert_kmh (default 20km/h). Útil para evitar aplicaciones.',
  '• Ventana seca: N días consecutivos sin lluvia desde hoy. Umbral: user_settings.dry_window_days (default 3). Útil para planificar fumigación/siembra.',
  '',
  'Todas las alertas incluyen disclaimer "Es un pronóstico, puede cambiar."',
  'Canal: Telegram primero, fallback WhatsApp. Se agrupan en un solo mensaje por tipo de alerta.',
];

for (const note of weatherAlerts) {
  doc.text(note, 44, doc.y, { width: 500 });
  doc.moveDown(0.3);
}

sectionTitle('Intents triviales (regex, no pasan por AI)');
doc.fontSize(9).fillColor(DARK).font('Helvetica');
const trivials = [
  'confirm, cancel, greeting, thanks, ack, menu, help, dollar,',
  'list_fields, list_plots, show_expense_menu, show_income_menu, show_agro_menu,',
  'show_reports_menu, show_config_menu, show_stock_menu, show_livestock_menu',
  '',
  'Estos se detectan por regex antes del agente AI. Si el regex falla (abreviaturas, errores),',
  'el mensaje llega al agente que puede NO tener la tool equivalente → clasificación incorrecta.',
];
for (const line of trivials) {
  doc.text(line, 44, doc.y, { width: 500 });
  doc.moveDown(0.2);
}

sectionTitle('Arquitectura del pipeline');
doc.fontSize(9).fillColor(DARK).font('Helvetica');

const pipeline = [
  '1. Observation prefix ("observación:") → bypass total del AI, guarda como observación.',
  '2. Trivial commands (~35) → regex match, sin AI.',
  '3. Agent (tool_use) → Claude Haiku 4.5 elige 1+ tools. Soporta acciones compuestas (command + expense + income).',
  '4. Regex fallback → si agent deshabilitado, falla o baja confianza.',
  '5. Conversational fallback → si ninguna tool matchea, Claude responde como texto.',
  '',
  'Prompt caching (2026-04): tres breakpoints cache_control — system prompt, última tool, último few-shot.',
  'Contexto del usuario + fecha de hoy van en el prefijo del mensaje (no cacheado), para que el prefix cacheado sea estable entre usuarios.',
  'Few-shots rotan diarios (md5 determinístico por día) — no ORDER BY RANDOM() que invalidaba el cache.',
  'TTL configurable: AGENT_CACHE_TTL=short (5min, 1.25× write) | long (1h, 2× write). Cantidad: AGENT_FEW_SHOT_LIMIT (default 5).',
  '',
  'Cost tracking (2026-04, migración 070): ai_usage guarda cache_read_tokens + cache_write_tokens además de input/output.',
  'Dashboard calcula costo real con 4 términos (Haiku): input $0.80/M, cache read $0.08/M (10%), cache write $1.00/M (125%), output $4.00/M.',
  'Log line: "AI_AGENT CACHE: Nread/Nwrite" permite observar hit rate en Railway logs.',
];

for (const line of pipeline) {
  doc.text(line, 44, doc.y, { width: 500 });
  doc.moveDown(0.3);
}

doc.end();
output.on('finish', () => {
  console.log('PDF generado: docs/intents-reference.pdf');
});
