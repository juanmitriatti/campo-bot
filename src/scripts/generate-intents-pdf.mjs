import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });
const outputPath = path.resolve('data/campo-bot-intents.pdf');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const stream = fs.createWriteStream(outputPath);
doc.pipe(stream);

// Colors
const PRIMARY = '#1a5276';
const SECONDARY = '#2e86c1';
const GRAY = '#7f8c8d';
const BLACK = '#2c3e50';
const CARD_BORDER = '#bdc3c7';
const CARD_BG_LEFT = '#2e86c1';

// Helper: section title (no emojis)
function sectionTitle(text, color = PRIMARY) {
  if (doc.y > 680) doc.addPage();
  doc.moveDown(0.5);
  doc.fontSize(16).font('Helvetica-Bold').fillColor(color).text(text);
  doc.moveTo(50, doc.y + 2).lineTo(545, doc.y + 2).strokeColor(color).lineWidth(1.5).stroke();
  doc.moveDown(0.5);
  doc.fillColor(BLACK);
}

// Helper: subsection
function subsection(text) {
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.3);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(SECONDARY).text(text);
  doc.moveDown(0.2);
  doc.fillColor(BLACK);
}

// Helper: draw a left-bordered card (draw border first, then content)
function intentCard(name, description, examples, params, mode) {
  const cardX = 58;
  const cardW = 484;
  const contentX = cardX + 6;
  const contentW = cardW - 12;

  const modeLabel = mode === 'ai' ? '  [AI Agent]' : mode === 'regex' ? '  [Regex]' : '  [AI + Regex]';
  const modeColor = mode === 'ai' ? '#2e86c1' : mode === 'regex' ? '#e67e22' : '#27ae60';
  const borderColor = mode === 'ai' ? '#2e86c1' : mode === 'regex' ? '#e67e22' : '#27ae60';

  if (doc.y > 630) doc.addPage();

  const startY = doc.y + 4;

  // Name + badge
  doc.fontSize(11).font('Helvetica-Bold').fillColor(PRIMARY)
     .text(name, contentX, startY + 6, { continued: true, width: contentW });
  doc.fontSize(8).font('Helvetica').fillColor(modeColor).text(modeLabel);

  // Description
  doc.fontSize(9).font('Helvetica').fillColor(BLACK)
     .text(description, contentX, doc.y + 1, { width: contentW });

  // Parameters
  if (params && params.length > 0) {
    doc.moveDown(0.15);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
       .text('Parametros: ', contentX, doc.y, { continued: true, width: contentW });
    doc.font('Helvetica').fillColor(BLACK).text(params.join(', '));
  }

  // Examples
  if (examples && examples.length > 0) {
    doc.moveDown(0.15);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(GRAY)
       .text('Ejemplos:', contentX, doc.y, { width: contentW });
    for (const ex of examples) {
      doc.fontSize(8).font('Helvetica-Oblique').fillColor('#5d6d7e')
         .text(`  > "${ex}"`, contentX, doc.y, { width: contentW });
    }
  }

  const endY = doc.y + 6;

  // Left accent border
  doc.save();
  doc.roundedRect(cardX, startY, 3, endY - startY, 1.5).fill(borderColor);
  doc.restore();

  // Bottom separator
  doc.moveTo(cardX, endY + 2).lineTo(cardX + cardW, endY + 2)
     .strokeColor('#e0e0e0').lineWidth(0.5).stroke();

  doc.y = endY + 6;
  doc.moveDown(0.1);
}

// Simple intent row (for trivial commands)
function intentRow(name, description, examples, mode = 'regex') {
  if (doc.y > 710) doc.addPage();
  const modeColor = mode === 'ai' ? '#2e86c1' : mode === 'regex' ? '#e67e22' : '#27ae60';
  const modeLabel = mode === 'ai' ? '[AI]' : mode === 'regex' ? '[Regex]' : '[AI+Regex]';

  doc.fontSize(9).font('Helvetica-Bold').fillColor(PRIMARY).text(name, 65, doc.y, { continued: true });
  doc.fontSize(7).font('Helvetica').fillColor(modeColor).text(`  ${modeLabel}`, { continued: false });
  doc.fontSize(8).font('Helvetica').fillColor(BLACK).text(`  ${description}`, 65, doc.y, { width: 475 });
  if (examples && examples.length > 0) {
    doc.fontSize(7.5).font('Helvetica-Oblique').fillColor(GRAY)
       .text(`  Ej: ${examples.map(e => `"${e}"`).join(', ')}`, 65, doc.y, { width: 475 });
  }
  doc.moveDown(0.3);
}

// ==================== COVER PAGE ====================
doc.moveDown(6);
doc.fontSize(32).font('Helvetica-Bold').fillColor(PRIMARY).text('Campo Bot', { align: 'center' });
doc.moveDown(0.3);
doc.fontSize(18).font('Helvetica').fillColor(SECONDARY).text('Catalogo de Intents Disponibles', { align: 'center' });
doc.moveDown(1.5);
doc.fontSize(11).font('Helvetica').fillColor(GRAY).text('Guia completa de todos los comandos e intenciones', { align: 'center' });
doc.text('reconocidos por el bot de gestion agricola', { align: 'center' });
doc.moveDown(3);

// Stats box
const statsY = doc.y;
doc.roundedRect(130, statsY, 290, 115, 6).strokeColor(SECONDARY).lineWidth(1).stroke();
doc.fontSize(11).font('Helvetica-Bold').fillColor(PRIMARY).text('Resumen', 0, statsY + 12, { align: 'center' });
doc.moveDown(0.3);
doc.fontSize(9.5).font('Helvetica').fillColor(BLACK);
doc.text('82 herramientas AI Agent (tool_use)', 0, statsY + 30, { align: 'center' });
doc.text('35+ comandos regex (triviales)', 0, statsY + 45, { align: 'center' });
doc.text('12 dominios: Finanzas, Agro, Monitoreo (Scouting),', 0, statsY + 60, { align: 'center' });
doc.text('Clima, Reportes, Campos/Lotes, Stock,', 0, statsY + 73, { align: 'center' });
doc.text('Hacienda + Sanidad/Repro/Pesaje, Feedlot,', 0, statsY + 86, { align: 'center' });
doc.text('Compartidos, Documentos, Sistema', 0, statsY + 99, { align: 'center' });

doc.y = statsY + 145;
doc.moveDown(3.5);
doc.fontSize(8).fillColor(GRAY).text(`Generado: ${new Date().toLocaleDateString('es-AR')} -- Campo Bot v3.0 (May 2026, MVP-ready)`, { align: 'center' });

// ==================== PIPELINE PAGE ====================
doc.addPage();
sectionTitle('Pipeline de Clasificacion');
doc.fontSize(9.5).font('Helvetica').fillColor(BLACK);
doc.text('Cada mensaje del usuario pasa por el siguiente pipeline de clasificacion en orden de prioridad:', { width: 495 });
doc.moveDown(0.5);

const pipelineSteps = [
  ['1. Prefijo observacion', 'Mensajes que comienzan con "observacion:", "obs:" o "nota:" se clasifican como log_observation sin pasar por AI.'],
  ['2. Comandos triviales (regex)', '35+ comandos simples (hola, menu, agregar campo, etc.) se detectan por regex. No consumen API de AI.'],
  ['3a. AI Agent (tool_use)', 'Si AGENT_ENABLED=true, Claude decide que herramienta(s) usar. Soporta acciones compuestas (multiples tool calls en un solo mensaje).'],
  ['3b. AI JSON Extraction', 'Si AGENT_ENABLED=false, Claude extrae un JSON estructurado con la intencion del mensaje.'],
  ['4. Regex fallback', 'Cadena completa de regex para comandos, observaciones y referencias a campos/lotes.'],
  ['5. Conversational fallback', 'Si nada coincide, responde conversacionalmente o muestra el menu.'],
];
for (const [step, desc] of pipelineSteps) {
  doc.fontSize(10).font('Helvetica-Bold').fillColor(SECONDARY).text(step, 60, doc.y);
  doc.fontSize(8.5).font('Helvetica').fillColor(BLACK).text(desc, 80, doc.y, { width: 460 });
  doc.moveDown(0.5);
}

doc.moveDown(0.8);
// Legend
doc.roundedRect(55, doc.y, 490, 55, 4).strokeColor('#ddd').lineWidth(0.5).stroke();
const legendY = doc.y + 8;
doc.fontSize(9).font('Helvetica-Bold').fillColor(GRAY).text('Leyenda de badges:', 65, legendY);
doc.fontSize(8).font('Helvetica-Bold');
doc.fillColor('#2e86c1').text('[AI Agent]', 65, legendY + 14, { continued: true });
doc.fillColor(BLACK).font('Helvetica').text('  Procesado por Claude con tool_use', { continued: false });
doc.font('Helvetica-Bold').fillColor('#e67e22').text('[Regex]', 65, doc.y, { continued: true });
doc.fillColor(BLACK).font('Helvetica').text('  Detectado por expresiones regulares (sin costo AI)', { continued: false });
doc.font('Helvetica-Bold').fillColor('#27ae60').text('[AI + Regex]', 65, doc.y, { continued: true });
doc.fillColor(BLACK).font('Helvetica').text('  Puede ser detectado por ambos metodos', { continued: false });

// ==================== FINANCIAL INTENTS ====================
doc.addPage();
sectionTitle('Intents Financieros', PRIMARY);
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Registro y consulta de gastos e ingresos agricolas.');
doc.moveDown(0.5);

intentCard('log_expense', 'Registra un gasto agricola. Se activa con verbos como gaste, pague, compre seguido de un monto. Soporta categorias: Combustible, Semillas, Agroquimicos, Fertilizantes, Maquinaria, Mano de Obra, Servicios, Flete, Seguros, Impuestos, Alquiler, Otros. Incluye event_date para registros historicos.', [
  'gaste 50mil en gasoil para el lote norte',
  'compre semillas de soja por 200 dolares',
  'pague 150000 de flete ayer',
], ['amount (requerido)', 'description (requerido)', 'category', 'currency (ARS/USD)', 'field', 'plot', 'event_date (YYYY-MM-DD)', 'expense_type (varios|insumo)', 'product', 'quantity', 'unit'], 'ai');

intentCard('log_income', 'Registra un ingreso. Se activa con verbos como vendi, cobre seguido de un monto. Soporta categorias: Venta Granos, Venta Hacienda, Servicios, Alquiler, Otros. Incluye event_date para registros historicos.', [
  'vendi 30 toneladas de soja a 300 usd la tonelada',
  'cobre 500mil por la cosecha de trigo',
], ['amount (requerido)', 'description (requerido)', 'category', 'currency', 'quantity', 'unit', 'unit_price', 'field', 'plot', 'event_date'], 'ai');

intentCard('financial_report', 'Reporte financiero unificado. Reemplaza los anteriores field_report, plot_report, monthly_report, weekly_report, monthly_result y date_range_report. Soporta filtros por campo, lote, periodo, rango de fechas, categoria, tipo (gastos/ingresos/ambos) y actividades agronomicas.', [
  'reporte mensual',
  'gastos del campo La Esperanza',
  'gastos del lote A1',
  'resumen semanal',
  'resultado del mes',
  'gastos ultimos 30 dias',
  'ingresos de enero a marzo',
], ['field', 'plot', 'period (week|month|year)', 'desde', 'hasta', 'days', 'category', 'type (expenses|incomes|both)', 'include_activities', 'activity_filter'], 'ai');

intentCard('export_csv', 'Exporta gastos del mes actual en formato CSV descargable.', [
  'exportar',
  'exportar csv',
], [], 'regex');

// Transaction management
subsection('Gestion de Transacciones');

intentRow('delete_last', 'Elimina el ultimo gasto registrado.', ['borrar ultimo gasto', 'eliminar ultimo gasto']);
intentRow('delete_last_income', 'Elimina el ultimo ingreso registrado.', ['borrar ultimo ingreso']);
intentRow('delete_specific', 'Elimina un gasto especifico por descripcion.', ['borrar gasto de gasoil']);
intentRow('edit_last', 'Edita el monto del ultimo gasto.', ['editar ultimo gasto a 100mil']);
intentRow('edit_specific', 'Edita un gasto especifico.', ['editar gasto de gasoil a 50000']);
intentRow('set_budget', 'Asigna un presupuesto mensual a una categoria.', ['presupuesto combustible 500000']);
intentRow('start_expense_flow', 'Inicia flujo guiado paso a paso para registrar un gasto.', ['registrar gasto', 'nuevo gasto']);
intentRow('start_income_flow', 'Inicia flujo guiado paso a paso para registrar un ingreso.', ['registrar ingreso', 'nuevo ingreso']);

subsection('Plantillas de Gastos');

intentRow('create_expense_template', 'Crea una plantilla reutilizable de gasto recurrente (mensual / quincenal / semanal).', ['plantilla alquiler 200mil mensual'], 'ai');
intentRow('list_expense_templates', 'Lista las plantillas activas y su proximo disparo.', ['mis plantillas', 'gastos recurrentes'], 'ai');
intentRow('delete_expense_template', 'Elimina una plantilla por nombre.', ['borrar plantilla alquiler'], 'ai');

// ==================== AGRONOMY INTENTS ====================
doc.addPage();
sectionTitle('Intents Agronomicos', '#27ae60');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Actividades agricolas, observaciones de campo, registros fenologicos y gestion de campanias.');
doc.moveDown(0.5);

subsection('Actividades de Campo');

intentCard('log_spraying', 'Registra fumigacion/pulverizacion. Verbos: fumigue, pulverice, aplique, tire (herbicida/insecticida/fungicida). NUNCA es un gasto a menos que el usuario mencione monto explicito.', [
  'fumigue glifosato en el lote norte',
  'aplique insecticida ayer',
  'tire herbicida en el campo sur',
], ['product', 'product_type (herbicida|insecticida|fungicida)', 'quantity', 'unit', 'crop', 'field', 'plot', 'event_date'], 'ai');

intentCard('log_fertilization', 'Registra fertilizacion. Verbos: fertilice, abone, meti (fertilizante).', [
  'fertilice con urea el lote A1',
  'meti DAP 100kg/ha',
], ['product', 'quantity', 'unit', 'crop', 'field', 'plot', 'event_date'], 'ai');

intentCard('sow_crop', 'Registra siembra de un cultivo. Verbos: sembre, implante. Abre una nueva campania en plot_crops. Si el lote ya tiene un cultivo cosechado (harvested_at set), lo cierra automaticamente antes de sembrar el nuevo.', [
  'sembre maiz en el lote sur',
  'hoy sembramos soja en campo norte',
], ['crop (requerido)', 'field', 'plot', 'event_date', 'season_year', 'season_type'], 'ai');

intentCard('harvest_crop', 'Registra cosecha. Verbos: coseche, levante. Setea harvested_at en plot_crops (la campania queda abierta para actividades post-cosecha). Acepta cargas por camion en `loads[]` (chofer + kg + opcional destinatario, patente, humedad %, calidad). Acepta `yield_kg_per_ha` para "X kg/ha" o "X qq/ha". Dedup: si se cosecha el mismo lote el mismo dia, se anexan loads sin duplicar el evento.', [
  'coseche 25 toneladas de trigo',
  'levante la soja del lote A1',
  'cosecha lote norte: Britos 28000, Perez 31500 al 14% humedad',
  'rindio 42 qq en el lote sur',
], ['crop (requerido)', 'quantity', 'unit', 'field', 'plot', 'event_date', 'yield_kg', 'yield_kg_per_ha', 'loads[] (driver_name, weight_kg, destination?, destinatario?, truck_plate?, humidity_pct?, quality_metrics?)'], 'ai');

intentCard('query_harvest_loads', 'Consulta cargas (camiones) de cosecha registradas. Filtros por lote, campo, fecha, chofer o destinatario. Muestra humedad y calidad si fueron capturadas.', [
  'cargas del lote norte',
  'cuanto llevo Britos',
  'cargas a Cargill este mes',
  'detalle de cosecha del lote A1',
], ['plot', 'field', 'desde', 'hasta', 'driver_name', 'destinatario'], 'ai');

intentCard('delete_harvest_loads', 'Elimina cargas duplicadas o incorrectas. Soporta borrado selectivo: por choferes, por fecha, o solo las que no tienen destinatario asignado.', [
  'borrar las cargas del lote norte de hoy',
  'eliminar cargas duplicadas',
  'borrar camiones sin destino del 7D',
], ['plot (requerido)', 'field', 'event_date', 'driver_names[]', 'only_without_destination'], 'ai');

intentCard('active_crop', 'Consulta el cultivo activo de un lote. Sin parametro plot: lista TODOS los cultivos activos del usuario (opcionalmente filtrados por crop). Con parametro plot: muestra el cultivo especifico del lote.', [
  'que cultivo tiene el lote A1?',
  'que sembre?',
  'lotes con soja',
  'donde tengo maiz?',
], ['plot', 'crop'], 'ai');

intentCard('close_campaign', 'Cierra definitivamente una campania de cultivo. Setea end_date en plot_crops. A diferencia de harvest_crop, esta accion es permanente y bloquea futuras actividades en esa campania.', [
  'cerrar campania soja lote A1',
  'finalizar campania maiz campo norte',
], ['crop (requerido)', 'field', 'plot'], 'ai');

intentCard('campaign_stats', 'Estadisticas de una campania: actividades, gastos, ingresos, rendimiento (kg/ha + humedad promedio + calidad), rentabilidad, monitoreos (scouting). Agrega datos por tipo de actividad, categoria de gasto, tipo de ingreso y por camion.', [
  'estadisticas campania soja',
  'como va la campania de maiz',
  'rentabilidad soja lote norte',
], ['crop', 'field', 'plot', 'season_year (ej: 2025/26)'], 'ai');

intentCard('compare_campaigns', 'Compara dos campanias del mismo lote o cultivo: rinde, gastos, ingresos, resultado por hectarea. Si no se especifican anios, toma las dos ultimas.', [
  'comparar soja 25/26 vs 24/25',
  'comparar campanias',
  'como salio vs la anterior',
], ['plot', 'field', 'crop', 'season_year_1', 'season_year_2'], 'ai');

intentCard('activity_stats', 'Estadisticas agregadas de actividades por periodo: cantidad de fumigaciones, siembras, cosechas, etc. Con breakdown por lote/campo.', [
  'cuantas fumigaciones hice este mes',
  'estadisticas de actividades',
  'actividades del campo norte',
], ['activity_type', 'field', 'plot', 'period', 'desde', 'hasta'], 'ai');

intentCard('edit_last_activity', 'Edita la ultima actividad del usuario que coincida con filtros opcionales (tipo, cultivo). Permite cambiar plot, crop o event_date.', [
  'editar ultima fumigacion, fue en lote sur',
  'la ultima siembra fue de maiz no soja',
  'cambiar fecha de la cosecha a ayer',
], ['activity_type', 'crop_filter', 'new_plot', 'new_crop', 'new_date'], 'ai');

intentCard('log_tacto', 'Registra tacto/revision de prenez en hacienda. Acepta pregnant_count, open_count, uncertain_count. Auto-calcula total y tasa de prenez %.', [
  'tacto hoy: 45 prenadas, 5 vacias',
  'revisamos 50 vacas, 40 prenadas, 8 vacias, 2 dudosas',
], ['pregnant_count', 'open_count', 'uncertain_count', 'total_count', 'field', 'plot', 'event_date'], 'ai');

intentCard('tacto_summary', 'Resumen de tactos realizados: prenez promedio, total revisado, por lote. Soporta filtros opcionales de lote/campo/rango de fechas.', [
  'resumen tactos',
  'como viene la prenez',
  'tasa de prenez lote norte',
  'tactos este anio',
], ['field', 'plot', 'desde', 'hasta'], 'ai');

intentCard('log_tillage', 'Registra labranza/preparacion de suelo. Verbos: are, disquee, rastree, pase disco/cincel.', [
  'are el lote 3',
  'pase disco ayer en el norte',
], ['product (implemento)', 'crop', 'field', 'plot', 'event_date'], 'ai');

intentCard('log_irrigation', 'Registra riego. Verbos: regue, riego.', [
  'regue 50mm esta manana',
  'riego pivot en lote A1',
], ['quantity', 'unit', 'crop', 'field', 'plot', 'event_date'], 'ai');

subsection('Observaciones');

intentCard('log_observation', 'Registra una observacion agronomica de campo. Categorias auto-detectadas: malezas, sanidad, nutricion, fenologia, clima, general. El prefijo "observacion:" o "obs:" fuerza la clasificacion sin AI.', [
  'observacion: hay roya en el lote norte',
  'hay mucha maleza en el campo sur',
  'el maiz esta en V6 en el lote A1',
], ['observation (requerido)', 'crop', 'field', 'plot', 'event_date'], 'both');

intentCard('log_rainfall', 'Registra milimetros de lluvia. Patrones: llovieron Xmm, cayeron X milimetros. Soporta multi-dia: cuando se mencionan varios dias en un mensaje (ej: "20mm el lunes, 35mm el martes"), el agente dispara una llamada por dia y compound-executor consolida en un solo prompt batched.', [
  'llovieron 25mm',
  'cayeron 30 milimetros anoche',
  '20mm el lunes, 35mm el martes y 12mm el miercoles',
], ['quantity en mm (requerido)', 'field', 'event_date'], 'both');

intentCard('log_rainfall_batch', 'Persistencia atomica de varios registros de lluvia (uno por dia) cuando el agente disparo multiples log_rainfall sin campo. El usuario elige el campo una sola vez via boton callback `rain_batch_<field>_<base64>`.', [
  '(disparado automaticamente desde log_rainfall multi-dia)',
], ['entries[] (requerido: mm + date)', 'field (requerido)'], 'ai');

subsection('Monitoreo de Cultivo (Crop Scouting)');

intentCard('log_crop_scouting', 'Monitoreo agronomico ESTRUCTURADO (distinto de log_observation que es texto libre). Se activa cuando el mensaje incluye metricas: estadio fenologico (V3, R5, Z3), %, severidad (leve/moderada/alta/severa), densidad (pl/m2). 9 metricas tipadas. Incluye validador stage_code: si el estadio no es tipico del cultivo (ej: "soja R12") se guarda igual con un warning.', [
  'soja V3 con 15% rama negra y presencia leve de chinche',
  'monitoreo lote A1: maiz V6, 30% emergencia, suelo humedo',
  'trigo Z3 sin malezas, sin plagas',
], ['crop', 'plot', 'field', 'event_date', 'stage_code', 'weed_coverage_pct', 'weed_species[]', 'pest_species', 'pest_severity_1_5 (1=ausente,5=severa)', 'pest_affected_pct', 'soil_moisture_1_5', 'emergence_pct', 'plant_density_m2', 'notes'], 'ai');

intentCard('query_scoutings', 'Consulta monitoreos ya registrados. Filtros por lote/campo/cultivo, rango de fechas, severidad minima, estadio.', [
  'como viene la sanidad del lote norte',
  'presion de plagas',
  'evolucion del cultivo',
  'monitoreos del lote A1 con severidad alta',
], ['plot', 'field', 'crop', 'desde', 'hasta', 'min_severity (1-5)', 'stage_code'], 'ai');

// ==================== WEATHER & REPORTS ====================
doc.addPage();
sectionTitle('Clima y Reportes Agronomicos', '#2e86c1');

intentCard('weather_full', 'Consulta del clima actual y pronostico extendido. Si el usuario menciona una ciudad explicita ("clima en X"), se usa esa city. localidadLookup desambigua nombres ambiguos (ej: Ameghino BA vs La Pampa).', [
  'que tiempo hace',
  'pronostico',
  'clima en el campo norte',
  'va a llover en Pergamino',
  'clima en Ameghino Buenos Aires',
], ['field', 'city', 'province'], 'ai');

intentCard('rainfall_report', 'Reporte de lluvias: acumulado por periodo (hoy, semana, mes, anio, semana pasada, mes pasado).', [
  'cuanto llovio esta semana',
  'lluvia del mes',
  'lluvias acumuladas este anio',
], ['period (today|week|month|year|last_week|last_month)', 'field', 'plot'], 'ai');

intentCard('generate_agro_report', 'Genera reporte agronomico en PDF: observaciones por lote, actividades recientes, cultivo activo. Soporta rango de fechas (desde/hasta).', [
  'reporte agronomico',
  'reporte agro del lote norte',
  'estado del campo',
  'como va el lote A1',
  'reporte agro de enero a marzo',
], ['field', 'plot', 'desde', 'hasta'], 'both');

intentCard('query_plot_history', 'Consulta el historial de actividades de un lote: fumigaciones, siembras, cosechas, fertilizaciones, lluvias, observaciones. Soporta isUltimaVez para "ultima fumigacion" y isBinaryQuestion para preguntas si/no.', [
  'cuando se fumigo el lote norte',
  'historial del lote A1',
  'ultima vez que se sembro en el sur',
  'en que lote sembre maiz',
  'se fumigo el lote norte?',
], ['plot', 'field', 'crop', 'timeRef', 'activityFilter', 'isUltimaVez', 'isBinaryQuestion'], 'both');

intentCard('share_report', 'Genera y envia un reporte en PDF al usuario (campania o financiero). Para campania genera el PDF de la campana del lote/cultivo indicado. Para financiero arma el PDF del periodo (week/month/year).', [
  'mandame el PDF de la campania',
  'exportar reporte financiero',
  'PDF de la soja del lote norte',
  'compartir reporte mensual',
], ['report_type (campaign|financial)', 'plot', 'field', 'crop', 'period (week|month|year)'], 'ai');

// ==================== FIELD/PLOT MANAGEMENT ====================
doc.addPage();
sectionTitle('Gestion de Campos y Lotes', '#8e44ad');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Creacion, modificacion y consulta de campos (fields) y lotes (plots).');
doc.moveDown(0.5);

intentCard('add_field', 'Crea un nuevo campo. Opcionalmente puede incluir localidad. Inicia flujo para elegir ubicacion (ciudad, dibujar en mapa o compartir ubicacion).', [
  'agregar campo La Esperanza',
  'crear campo norte en Pergamino',
], ['field (requerido)', 'city'], 'both');

intentCard('add_plot', 'Crea un nuevo lote dentro de un campo. SIEMPRE pide hectareas despues de crear (obligatorio).', [
  'agregar lote A1 en campo norte',
  'crear lote sur de 150 hectareas',
], ['plotName (requerido)', 'field', 'hectares'], 'both');

intentCard('add_plots_batch', 'Crea multiples lotes de una vez en un campo. Tras crear, pide hectareas de cada lote secuencialmente.', [
  'agregar lotes A1, A2 y A3 en campo norte',
  'crear lotes norte, sur, este',
], ['plotNames[] (requerido)', 'field'], 'both');

intentCard('set_plot_area', 'Asigna superficie en hectareas a un lote existente.', [
  'lote A1 tiene 50 hectareas',
  'asignar 75 ha al lote sur',
], ['plot (requerido)', 'hectares (requerido)', 'field'], 'both');

intentCard('set_plot_grupo', 'Asigna un grupo/sociedad a un lote (para agrupar por sociedad productora).', [
  'lote A1 es del grupo Los Hermanos',
  'asignar grupo Sociedad SA al lote norte',
], ['plot (requerido)', 'grupo (requerido)', 'field'], 'ai');

intentCard('set_field_city', 'Asigna localidad a un campo existente.', [
  'el campo norte esta en Pergamino',
  'ubicar campo sur en Junin',
], ['field (requerido)', 'city'], 'both');

intentCard('rename_field', 'Renombra un campo existente.', [
  'renombrar campo norte a La Esperanza',
  'cambiar nombre campo sur por Las Acacias',
], ['oldName (requerido)', 'newName (requerido)'], 'ai');

intentCard('rename_plot', 'Renombra un lote existente.', [
  'renombrar lote A1 a Lote Principal',
  'cambiar nombre del lote norte a A2',
], ['oldName (requerido)', 'newName (requerido)', 'field'], 'ai');

subsection('Consulta y Gestion');

intentRow('field_info', 'Muestra informacion detallada de un campo: lotes, cultivos, superficie.', ['info del campo norte', 'estado campo La Esperanza'], 'ai');
intentRow('list_fields', 'Lista todos los campos del usuario con sus lotes.', ['mis campos', 'que campos tengo', 'ver campos'], 'ai');
intentRow('list_plots', 'Lista todos los lotes de un campo o del usuario. Muestra hectareas y cultivos activos.', ['mis lotes', 'lotes del campo norte', 'cuantas hectareas tengo'], 'ai');
intentRow('delete_field', 'Elimina un campo (soft delete, recuperable).', ['borrar campo norte', 'eliminar campo viejo'], 'ai');
intentRow('delete_plot', 'Elimina un lote (soft delete, recuperable).', ['borrar lote A1 del campo norte'], 'ai');
intentRow('restore_field', 'Restaura un campo eliminado.', ['restaurar campo norte', 'recuperar campo viejo'], 'ai');
intentRow('restore_plot', 'Restaura un lote eliminado.', ['restaurar lote A1', 'recuperar lote norte'], 'ai');

// ==================== STOCK MANAGEMENT (NEW) ====================
doc.addPage();
sectionTitle('Gestion de Stock (Inventario)', '#d35400');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Inventario de insumos (agroquimicos, fertilizantes, semillas, combustible) y granos. Requiere plan pro_plus o enterprise.');
doc.moveDown(0.5);

intentCard('create_warehouse', 'Crea un nuevo deposito/galpon asociado a un campo. Permite multiples galpones por campo.', [
  'crear galpon galpon1 en campo norte',
  'nuevo deposito en La Esperanza',
], ['name (requerido)', 'field (requerido)'], 'ai');

intentCard('list_warehouses', 'Lista todos los galpones del usuario con stock asociado.', [
  'mis galpones',
  'listar depositos',
  'que galpones tengo',
], [], 'ai');

intentCard('add_stock', 'Carga producto al stock. Auto-resuelve el galpon si solo hay uno. Crea el producto si no existe. Registra un movimiento de tipo "entrada".', [
  'cargar 200 litros de glifosato',
  'agregar 50 bolsas de urea al galpon1',
  'entrada de 100kg de semilla soja',
], ['product (requerido)', 'quantity (requerido)', 'unit', 'warehouse', 'field', 'notes', 'event_date'], 'ai');

intentCard('remove_stock', 'Descuenta producto del stock. Registra un movimiento de tipo "salida". Requiere stock suficiente.', [
  'descontar 20 litros de glifosato',
  'salida de 10 bolsas de urea',
  'use 5kg de semilla del galpon1',
], ['product (requerido)', 'quantity (requerido)', 'unit', 'warehouse', 'notes', 'event_date'], 'ai');

intentCard('adjust_stock', 'Corrige el stock de un producto al valor absoluto indicado. Registra un movimiento de tipo "ajuste" (positivo o negativo).', [
  'tengo 150 litros de glifosato en galpon1',
  'stock de urea es 80 bolsas',
], ['product (requerido)', 'quantity (requerido)', 'unit', 'warehouse', 'notes'], 'ai');

intentCard('check_stock', 'Consulta stock actual de un producto especifico o de todo el inventario. Soporta fuzzy search por nombre.', [
  'cuanto glifosato tengo',
  'stock de urea',
  'inventario',
  'que tengo en el galpon1',
], ['product', 'warehouse', 'field'], 'ai');

intentCard('stock_history', 'Historial de movimientos (entradas/salidas/ajustes) de un producto o galpon.', [
  'historial de glifosato',
  'movimientos del galpon1',
  'entradas de urea este mes',
], ['product', 'warehouse', 'desde', 'hasta', 'movement_type'], 'ai');

intentCard('set_min_stock', 'Define un stock minimo para un producto. Cuando el stock cae bajo este valor, se envia alerta diaria.', [
  'minimo de glifosato 50 litros',
  'alertar si urea baja de 20 bolsas',
], ['product (requerido)', 'min_stock (requerido)', 'unit', 'warehouse'], 'ai');

// ==================== LIVESTOCK (HACIENDA) - NEW ====================
doc.addPage();
sectionTitle('Gestion de Hacienda (Livestock)', '#7d3c98');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Inventario de ganado (vacas, terneros, novillos, toros, bueyes) con modelo event-sourced. Requiere plan pro_plus o enterprise.');
doc.moveDown(0.5);

intentCard('add_livestock', 'Agrega animales a un lote o corral. Crea un grupo si no existe. Categorias: vaca, vaquillona, ternero, ternera, novillo, novillito, toro, torito, buey. Soporta plurales ("vacas" -> "vaca"). Si se incluye `unit_price_ars|usd`, AUTO-CREA un gasto vinculado (categoria Hacienda) para la compra. La relacion se guarda en livestock_movements.linked_expense_id.', [
  'agregue 20 vacas al lote norte',
  'entraron 15 terneros al corral 3',
  'compre 50 novillos a 800 dolares c/u',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'breed', 'avg_weight_kg', 'unit_price_ars', 'unit_price_usd', 'notes', 'event_date'], 'ai');

intentCard('remove_livestock', 'Registra salida de animales (venta, salida a pasturas, etc.). Requiere count suficiente en el grupo. Si se incluye `unit_price_ars|usd`, AUTO-CREA un ingreso vinculado (categoria Hacienda) para la venta.', [
  'vendi 5 novillos del lote A1 a 1200 dolares c/u',
  'salieron 10 vacas del corral 2',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'breed', 'unit_price_ars', 'unit_price_usd', 'notes', 'event_date'], 'ai');

intentCard('transfer_livestock', 'Mueve animales entre lotes o corrales. Si source_plot === dest_plot y categorias distintas, se clasifica como recategorizacion.', [
  'move 10 vacas del lote A al lote B',
  'pasar 5 terneros del corral 1 al corral 2',
  'pase 15 terneros a novillos en el lote sur',
], ['category (requerido)', 'count (requerido)', 'source (requerido)', 'dest (requerido)', 'destCategory', 'breed'], 'ai');

intentCard('record_livestock_death', 'Registra muerte de animales en un grupo. Descuenta del stock.', [
  'se murieron 2 terneros',
  'murio 1 vaca en el lote norte',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'reason', 'event_date'], 'ai');

intentCard('record_livestock_birth', 'Registra nacimientos. IMPORTANTE: solo con verbos explicitos de nacimiento (nacieron/parieron/nacio). "N vacas con N terneros" = add_livestock 2x (nunca record_livestock_birth).', [
  'nacieron 8 terneros',
  'parieron 5 vacas esta semana',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'event_date'], 'ai');

intentCard('adjust_livestock', 'Ajusta el count de un grupo al valor absoluto indicado. Usado para correcciones de inventario.', [
  'en el lote A1 hay 50 vacas',
  'ajustar a 30 novillos el corral 2',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'notes'], 'ai');

intentCard('list_livestock', 'Lista inventario de hacienda agrupado por lote/corral y categoria.', [
  'cuantos animales tengo',
  'inventario hacienda',
  'vacas en el lote norte',
  'hacienda del campo La Esperanza',
], ['field', 'plot', 'corral', 'category'], 'ai');

intentCard('livestock_history', 'Historial de movimientos de un grupo: entradas, salidas, transferencias, muertes, nacimientos, recategorizaciones, ajustes.', [
  'historial vacas lote A1',
  'movimientos de terneros',
  'entradas del corral 2 este mes',
], ['category', 'field', 'plot', 'corral', 'desde', 'hasta', 'movement_type'], 'ai');

subsection('Sanidad Animal');

intentCard('log_health_event', 'Registra eventos sanitarios: vacunaciones, desparasitaciones, tratamientos curativos, revisiones. Verbos: vacune, desparasite, cure, trate. health_type se infiere del verbo: vacune=vacunacion, desparasite=desparasitacion, curo/trato=tratamiento, revise=revision_sanitaria. Captura nombre de vacuna/enfermedad y dosis.', [
  'vacune 50 vacas contra aftosa',
  'desparasite con ivermectina los terneros del lote A',
  'trate 5 vacas por mastitis',
  'revisamos sanitariamente el rodeo del corral 2',
], ['health_type (requerido)', 'animals_affected', 'category', 'disease_or_vaccine', 'dose_quantity', 'dose_unit', 'field', 'plot', 'corral', 'veterinarian', 'event_date'], 'ai');

intentCard('query_health_events', 'Consulta historial sanitario: ultima vacunacion, desparasitaciones del año, tratamientos por animal o categoria.', [
  'cuando se vacuno la hacienda',
  'historial sanitario del corral 2',
  'ultima desparasitacion de los terneros',
], ['health_type', 'category', 'field', 'plot', 'corral', 'desde', 'hasta'], 'ai');

subsection('Reproduccion');

intentCard('log_repro_event', 'Registra eventos reproductivos. Verbos: eche el toro/entore (servicio), insemine/IA/IATF (inseminacion), deteccion de celo, deste (destete). repro_type: servicio, inseminacion, deteccion_celo, destete. Captura datos de toro padre o metodo de IA.', [
  'eche el toro al lote norte el 15 de enero',
  'insemine 30 vaquillonas con IATF',
  'deteccion de celo: 12 vacas',
  'desteté 25 terneros del corral 3',
], ['repro_type (requerido)', 'animals_affected', 'category', 'sire_info (raza, nombre, RP)', 'method (IA, IATF, monta natural)', 'field', 'plot', 'corral', 'event_date'], 'ai');

intentCard('query_repro_events', 'Consulta historial reproductivo: cuando se servicio, destetes del año, eficiencia reproductiva.', [
  'cuando se echo el toro al lote norte',
  'historial reproductivo',
  'destetes del año',
], ['repro_type', 'category', 'field', 'plot', 'corral', 'desde', 'hasta'], 'ai');

subsection('Pesaje');

intentCard('log_weighing', 'Registra pesaje de hacienda. IMPORTANTE: el peso es SIEMPRE promedio por animal, no peso total. Verbos: pese, peso promedio. Captura cantidad de animales pesados.', [
  'pese 30 novillos a 380 kg promedio',
  'peso promedio del corral 1: 250 kg, 25 animales',
], ['avg_weight_kg (requerido)', 'animals_weighed', 'category', 'field', 'plot', 'corral', 'event_date'], 'ai');

intentCard('query_weighings', 'Consulta evolucion de peso: GDPV (ganancia diaria de peso vivo), ultimo pesaje, comparativa entre lotes.', [
  'cuanto pesan los novillos del corral 2',
  'evolucion de peso del lote norte',
  'GDPV del corral A',
  'ultimo pesaje',
], ['category', 'field', 'plot', 'corral', 'desde', 'hasta'], 'ai');

intentCard('adjust_livestock', 'Ajusta el count de un grupo al valor absoluto indicado. Usado para correcciones de inventario.', [
  'en el lote A1 hay 50 vacas',
  'ajustar a 30 novillos el corral 2',
], ['category (requerido)', 'count (requerido)', 'field', 'plot', 'corral', 'notes'], 'ai');

// ==================== FEEDLOT / CORRAL (NEW) ====================
doc.addPage();
sectionTitle('Feedlot y Corrales', '#a04000');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Gestion de feedlot (engorde a corral) con corrales multiples. Maximo 1 feedlot por campo. Requiere plan con feature livestock.');
doc.moveDown(0.5);

intentCard('create_feedlot', 'Crea un feedlot asociado a un campo. Solo se permite 1 feedlot por campo.', [
  'crear feedlot en campo norte',
  'nuevo feedlot La Esperanza',
], ['name', 'field (requerido)'], 'ai');

intentCard('list_feedlots', 'Lista todos los feedlots del usuario con sus corrales.', [
  'mis feedlots',
  'listar feedlot',
], [], 'ai');

intentCard('delete_feedlot', 'Elimina un feedlot (soft delete). Los corrales asociados tambien se marcan como eliminados.', [
  'borrar feedlot campo norte',
  'eliminar feedlot La Esperanza',
], ['field (requerido)'], 'ai');

intentCard('create_corral', 'Crea un corral dentro de un feedlot. Nombres unicos por feedlot.', [
  'crear corral 1 en feedlot campo norte',
  'nuevo corral A en feedlot La Esperanza',
], ['name (requerido)', 'field (requerido)'], 'ai');

intentCard('list_corrals', 'Lista los corrales de un feedlot.', [
  'corrales del campo norte',
  'listar corrales feedlot La Esperanza',
], ['field'], 'ai');

intentCard('delete_corral', 'Elimina un corral (soft delete).', [
  'borrar corral 1 del campo norte',
  'eliminar corral A',
], ['name (requerido)', 'field'], 'ai');

intentCard('rename_corral', 'Renombra un corral existente.', [
  'renombrar corral 1 a corral principal',
  'cambiar nombre corral A por B',
], ['oldName (requerido)', 'newName (requerido)', 'field'], 'ai');

// ==================== SHARING (NEW) ====================
doc.addPage();
sectionTitle('Campos Compartidos', '#16a085');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Sistema de invitaciones por codigo para compartir campos entre usuarios (WhatsApp y Telegram). Requiere plan enterprise para generar invites.');
doc.moveDown(0.5);

intentCard('share_field', 'Genera un codigo de invitacion de 6 caracteres (expira en 7 dias) para compartir acceso a un campo. Solo el dueno puede invitar.', [
  'compartir campo norte',
  'invitar a mi campo La Esperanza',
], ['field (requerido)'], 'ai');

intentCard('accept_invite', 'Redime un codigo de invitacion y obtiene acceso al campo. NO requiere plan especial (cualquier usuario puede aceptar).', [
  'unirme ABC123',
  'aceptar invite XYZ789',
  'codigo de acceso 12ABCD',
], ['code (requerido)'], 'ai');

intentCard('list_field_members', 'Lista los miembros de un campo compartido con sus roles (owner, member).', [
  'quien tiene acceso al campo norte',
  'miembros de campo La Esperanza',
], ['field (requerido)'], 'ai');

intentCard('remove_field_member', 'Remueve un miembro del campo compartido (por nombre o telefono).', [
  'quitar a Juan del campo norte',
  'remover miembro +5491112345678',
], ['field (requerido)', 'identifier (requerido)'], 'ai');

// ==================== DOCUMENTS (NEW) ====================
doc.addPage();
sectionTitle('Documentos (Facturas y Remitos)', '#6c3483');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Procesamiento de facturas y remitos via imagenes. Usa Claude Vision para extraer datos estructurados. Feature-gated con limites diarios por plan.');
doc.moveDown(0.5);

intentCard('list_documents', 'Lista los documentos procesados del usuario (facturas, remitos, tickets) con filtros.', [
  'mis facturas',
  'documentos este mes',
  'ver remitos',
], ['document_type (factura|remito|ticket)', 'desde', 'hasta'], 'ai');

intentCard('link_document_to_expense', 'Vincula un documento a un gasto existente (asocia la factura al registro financiero).', [
  'vincular factura 123 al gasto de gasoil',
  'asociar documento a ultimo gasto',
], ['document_id (requerido)', 'expense_id'], 'ai');

doc.moveDown(0.5);
doc.fontSize(9).font('Helvetica-Bold').fillColor(GRAY).text('Flujos de upload (no son tool calls explicitas):', 60, doc.y, { width: 475 });
doc.moveDown(0.2);
doc.fontSize(8.5).font('Helvetica').fillColor(BLACK);
doc.text('• Factura: solo genera gastos (nunca stock). Con descubrimiento de productos faltantes.', 70, doc.y, { width: 470 });
doc.text('• Remito: solo carga stock (nunca gastos). Con seleccion de galpon si hay multiples.', 70, doc.y, { width: 470 });
doc.text('• Imagen no-solicitada: el bot pregunta la intencion (factura o remito) antes de procesar.', 70, doc.y, { width: 470 });

// ==================== SYSTEM INTENTS ====================
doc.addPage();
sectionTitle('Sistema y Configuracion', '#7f8c8d');

subsection('Navegacion');

intentRow('greeting', 'Saludo inicial. Muestra mensaje de bienvenida y opciones principales.', ['hola', 'buenas', 'hey']);
intentRow('menu', 'Muestra el menu principal con todas las opciones disponibles.', ['menu', 'opciones']);
intentRow('help', 'Muestra ayuda con instrucciones de uso.', ['ayuda', 'help', '?']);
intentRow('show_expense_menu', 'Submenu de gastos.', ['gastos', 'mis gastos']);
intentRow('show_income_menu', 'Submenu de ingresos.', ['ingresos', 'mis ingresos']);
intentRow('show_agro_menu', 'Submenu agronomico.', ['agro', 'agronomia']);
intentRow('show_fields_menu', 'Submenu de campos y lotes.', ['campos', 'mis campos']);
intentRow('show_rain_menu', 'Submenu de lluvias.', ['lluvias', 'lluvia']);
intentRow('show_reports_menu', 'Submenu de reportes.', ['reportes', 'informes']);
intentRow('dollar', 'Muestra cotizacion del dolar.', ['dolar', 'cotizacion dolar']);

subsection('Alertas y Preferencias');

intentRow('show_alerts', 'Muestra configuracion actual de alertas del usuario.', ['mis alertas', 'ver alertas']);
intentRow('set_rain_threshold', 'Configura umbral de alerta de lluvia en mm.', ['alerta lluvia 50mm', 'umbral lluvia 30']);
intentRow('enable_rain_alerts', 'Activa alertas de lluvia diarias.', ['activar alertas lluvia']);
intentRow('disable_rain_alerts', 'Desactiva alertas de lluvia.', ['desactivar alertas lluvia']);
intentRow('enable_budget_alerts', 'Activa alertas de presupuesto (80% y 100%).', ['activar alertas presupuesto']);
intentRow('disable_budget_alerts', 'Desactiva alertas de presupuesto.', ['desactivar alertas presupuesto']);
intentRow('enable_weekly_summary', 'Activa resumen semanal automatico.', ['activar resumen semanal']);
intentRow('disable_weekly_summary', 'Desactiva resumen semanal.', ['desactivar resumen semanal']);
intentRow('set_city', 'Establece la ciudad del usuario para clima.', ['estoy en Junin', 'mi ciudad es Pergamino']);
intentRow('set_name', 'Establece el nombre del usuario.', ['me llamo Juan', 'soy Pedro']);

subsection('Control de Conversacion');

intentRow('confirm', 'Confirma la operacion pendiente.', ['si', 'confirmar', 'dale', 'va']);
intentRow('cancel', 'Cancela la operacion pendiente.', ['no', 'cancelar', 'nah']);
intentRow('thanks', 'Reconoce agradecimiento del usuario.', ['gracias', 'genial', 'joya']);
intentRow('ack', 'Reconoce mensaje informativo.', ['ok', 'listo', 'perfecto', 'bien']);
intentRow('request_more_messages', 'Solicita ampliar limite de mensajes AI.', ['quiero mas mensajes', 'ampliar plan']);

subsection('Herramienta Conversacional (AI Agent)');

intentCard('respond_text', 'Respuesta conversacional del AI Agent. Se usa SOLO para saludos, agradecimientos y preguntas generales sin datos del usuario. NUNCA se usa si hay una herramienta de registro o consulta aplicable.', [
  'que sos?',
  'como funciona el bot?',
], ['text (requerido)'], 'ai');

// ==================== SPECIAL RULES PAGE ====================
doc.addPage();
sectionTitle('Reglas Especiales de Clasificacion', '#c0392b');

subsection('Prefijo de Observacion (Prioridad Maxima)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Mensajes que comienzan con "observacion:", "obs:" o "nota:" SIEMPRE se clasifican como log_observation, sin importar el contenido. Bypasea completamente el AI y el regex.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Acciones Compuestas (Compound Actions)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('El AI Agent puede devolver multiples tool calls en un solo mensaje (ej: "sembre soja y la semilla costo 100mil" -> sow_crop + log_expense). CompoundExecutor los ejecuta secuencialmente. En contexto compound, confirm_before_save se fuerza a false para que los gastos/ingresos guarden directo. Si algun paso devuelve startFlow, la ejecucion se detiene alli.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Guardia de Preguntas');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Preguntas (que, cuando, cuanto, como, etc.) NO se clasifican como gastos, ingresos ni observaciones para evitar falsos positivos. Excepcion: preguntas con senales agronomicas fuertes (plaga, maleza, roya, helada).', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Guardia Financiera en Observaciones');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Texto con verbos financieros (gaste, pague, compre) + montos ($, mil, lucas) NUNCA se guarda como observacion agronomica, incluso si se intenta forzar.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Actividades != Gastos');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Verbos agronomicos (fumigue, sembre, coseche, etc.) son SOLO actividades y NUNCA gastos, a menos que el usuario mencione explicitamente un monto. Si el AI Agent retorna log_expense junto a una actividad agro con amount=0, el expense se filtra automaticamente (hallucination filter). Si el amount es real, ambos se mantienen.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Disambiguacion de Hacienda');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('"N vacas con N terneros" -> SIEMPRE 2x add_livestock (nunca record_livestock_birth). record_livestock_birth solo se activa con verbos explicitos de nacimiento: nacieron, parieron, nacio.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Disambiguacion de Hectareas');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('"has" / "hectareas" / "superficie" + campo -> list_plots (NO confundir con "hacienda"). Ejemplo: "cuantas hectareas tengo" -> list_plots. "cuantos animales tengo" -> list_livestock.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Ciclo de Vida de Campanias');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Una campania tiene 3 estados: ACTIVE (sin end_date ni harvested_at), HARVESTED (harvested_at set, end_date null - permite actividades post-cosecha), CLOSED (end_date set - permanente). sow_crop auto-cierra campanias harvested al re-sembrar.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Feature Gates (Planes)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Stock, Hacienda, Feedlot: requieren pro_plus o enterprise. Sharing (generar invites): requiere enterprise. Documents: limites diarios por plan (free=1, pro=10, pro_plus=25, enterprise=100). Si el usuario no tiene el plan, el comando sugiere upgrade.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Reporte Financiero Unificado');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('La herramienta financial_report unifica 6 reportes anteriores (field_report, plot_report, monthly_report, weekly_report, monthly_result, date_range_report) en una sola herramienta con parametros opcionales. Los nombres anteriores se mantienen como alias en regex/JSON para compatibilidad.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Extraccion de Fechas (event_date)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Todas las herramientas de registro aceptan event_date (YYYY-MM-DD) para registrar eventos historicos. El prompt incluye la fecha de hoy para que el AI interprete correctamente "ayer", "la semana pasada", etc. Si no se menciona fecha, se usa CURRENT_DATE.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Deduplicacion de Observaciones');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Las observaciones pasan por 4 capas de deduplicacion: normalizacion de texto, cache en memoria (5 min), verificacion en DB (5 min), y dedup al renderizar. Evita duplicados por mensajes repetidos.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Compound Stock + Gasto');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('add_stock acepta unit_price_ars / unit_price_usd. Cuando esta presente, el handler crea un gasto vinculado (categoria Insumos, total = quantity * unit_price). El agente NUNCA debe llamar log_expense por separado en estos casos. Mismo patron en add_livestock / remove_livestock con linked_expense_id / linked_income_id.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Correcciones Mid-Flow');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Durante un flujo activo el usuario puede corregir sin cancelar. Patrones soportados: (1) RENAME: "se llama X, no Y" / "no Y, es X" / "el nombre es X" actualiza data.name. (2) AMOUNT: "no, eran X" / "en realidad X" / "perdon, X" / "quise decir X" corrige el monto. (3) CATEGORY: "no, es X" / "no, categoria X". Funciona tanto en flujo como en confirmacion.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Lluvia Multi-Dia (log_rainfall_batch)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Cuando se registran varios dias de lluvia en un mensaje ("20mm el lunes, 35mm el martes y 12mm el miercoles") el agente dispara N llamadas log_rainfall (una por dia con event_date). Si ninguna trae campo, compound-executor.consolidateRainfallPrompts() los colapsa en un solo prompt batched con callback rain_batch_<field>_<base64>. El boton dispara log_rainfall_batch que persiste todo de una.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Truncamiento del Agente');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Si Anthropic devuelve stop_reason=max_tokens, AgentResult.truncated=true. El bot agrega "El mensaje era largo y se corto. Si te quedaron acciones sin registrar, repetilas en un mensaje aparte." y se loguea AI_AGENT TRUNCATED. AGENT_MAX_TOKENS default 1500 (admin > Configuracion de IA).', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Unidades qq / tn / kg');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Conversion centralizada en normalizeToKg(quantity, unit). qq (quintal) = 100 kg, tn (tonelada) = 1000 kg. "rindio 42 qq" -> 4200 kg. "200 qq de soja" -> 20000 kg. Aplica al cargar harvest_loads + agro-report. formatQuantityHuman() renderiza grandes valores como tn (213200 kg -> ~ 213,2 tn).', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Cosecha: Humedad y Calidad');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('harvest_loads soporta humidity_pct (0-50%) y quality_metrics (JSONB crop-specific): soja {oil_pct}, trigo {protein_pct, gluten_pct, test_weight_kg_hl}, girasol {oil_pct}. Se capturan SOLO si el usuario las menciono (el agente nunca inventa). yield_kg_per_ha vs yield_kg: "X kg/ha" o "X qq/ha" -> rate. "sacamos X tn/kg" sin "por hectarea" -> total.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Memoria Multi-Slot (context_stack)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('conversation_state.context_stack (JSONB) guarda los ultimos 3 lotes/campos referenciados como [{field_id, plot_id, ts}], LIFO con dedup. Se expone al agente como "contextos recientes:[1) Lote Norte (La Esperanza), 2) Lote Sur ...]" cuando el stack tiene >1 entrada. Permite resolver "el otro campo" / "el de antes".', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Validador de Estadios (stage_code)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('log_crop_scouting valida stage_code contra crop. Soja VE/V1..V8/R1..R8, maiz VE/V1..V21/VT/R1..R6, trigo+cebada Zadoks Z21..Z99, girasol VE/V1..V20/R1..R9, sorgo VE/V1..V12/R1..R6. Es NO bloqueante: el monitoreo se guarda igual y se agrega un warning ("El estadio R12 no es tipico de soja").', 60, doc.y, { width: 475 });

// ==================== MVP AUDIT PAGE ====================
doc.addPage();
sectionTitle('Auditoria MVP - Estado y Brechas', '#c0392b');
doc.fontSize(9).font('Helvetica').fillColor(GRAY);
doc.text(`Snapshot al ${new Date().toLocaleDateString('es-AR')}. Inventario: 82 herramientas AI distribuidas en 12 dominios; 1280 tests unitarios verdes; eval conversacional 18/18; QA adversarial 90% (30 esc.) y 73% (40 avanzados). Pasaron a produccion features de Sanidad/Repro/Pesaje, Crop Scouting estructurado, harvest_loads con humedad+calidad, multi-day rainfall, memoria multi-slot, y los 4 P0 de hardening MVP (Mayo 2026).`, 60, doc.y, { width: 480 });
doc.moveDown(0.6);

subsection('P0 (bloqueantes pre-launch) - CERRADOS');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
const p0 = [
  ['[OK] Atomicidad de compound actions', 'Resuelto. src/config/db.js hijack pool.query/pool.connect con AsyncLocalStorage; CompoundExecutor envuelve steps en withTransaction. Step que tira -> rollback total + mensaje al usuario. Inner transactions usan SAVEPOINT.'],
  ['[OK] Verificacion de canal y tenant', 'Resuelto. Migracion 076 + ChannelVerificationService. WA OTP via Cloud API + TG deep-link. Endpoints /api/auth/verify/*. Gate en bot controllers behind REQUIRE_VERIFIED_CHANNEL. Grandfather de users existentes.'],
  ['[OK] Export full-data (portabilidad GDPR)', 'Resuelto. Migracion 077 + DataExportService. Stream ZIP con 23 CSV via archiver (fields, plots, plot_crops, expenses, incomes, activities, observations, scoutings, harvest_loads, rainfall, livestock, stock, documents, etc.) + metadata.json + README. AccountDeletionService con password gate, soft-delete + PII release.'],
  ['[OK] Cobros y suscripciones', 'Resuelto. Migracion 078 + PaymentProvider interface + MercadoPagoProvider (Preapproval API). SubscriptionService: trial bootstrap 14d en register, checkout, webhook idempotente, cancel (trial=immediate, paid=deferred), daily sweep cron. Behind PAYMENTS_ENABLED. UI Suscripcion en Mi cuenta.'],
];
for (const [t, d] of p0) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#27ae60').text(`> ${t}`, 60, doc.y, { width: 480 });
  doc.fontSize(8.5).font('Helvetica').fillColor(BLACK).text(d, 70, doc.y, { width: 470 });
  doc.moveDown(0.3);
}

subsection('Brechas P1 (habilitadores MVP)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
const p1 = [
  ['Onboarding guiado', 'El primer registro post-login no guia a crear campo+lote. pending-field-location se dispara solo despues de la primera actividad. No se asigna automaticamente plan free al alta.'],
  ['Notificaciones nativas', 'Push web (VAPID) funciona, pero alertas por WhatsApp/Telegram nativas no tienen confirmacion de entrega. UI de preferencias de notificaciones falta en frontend.'],
  ['Cobertura de tests E2E', '18 escenarios conversacionales + 70 adversariales cubren el happy path. Faltan: aislamiento multi-tenant, flujos compuestos largos (campo -> lote -> siembra -> fumigacion -> cosecha), regresion de ediciones.'],
  ['Documentos: human-in-the-loop', 'Claude Vision extrae factura/remito y crea gastos automaticamente. No hay paso de revision/edicion antes de persistir. Sin audit trail de aceptacion/rechazo.'],
  ['Forecast vs spraying', 'weather_full informa pronostico pero no integra con la decision de fumigar (alerta "no fumigar si lluvia inminente"). Wind/dry alerts existen pero independientes.'],
];
for (const [t, d] of p1) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#d68910').text(`> ${t}`, 60, doc.y, { width: 480 });
  doc.fontSize(8.5).font('Helvetica').fillColor(BLACK).text(d, 70, doc.y, { width: 470 });
  doc.moveDown(0.3);
}

subsection('Brechas P2 (mejoras post-MVP)');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
const p2 = [
  ['Soft-delete inconsistente', 'expenses, incomes, fields, plots tienen deleted_at. Livestock, stock, documentos no -> borrado permanente.'],
  ['Aggregations livestock', 'No hay vistas materializadas de "rodeo total por campo" o "by-breed inventory" mas alla de list_livestock.'],
  ['Visualizacion scouting', 'crop_scoutings se guarda y aparece en agro PDF, pero el dashboard no grafica evolucion fenologica ni timeline de presion de plagas.'],
  ['Re-trigger truncamiento', 'AgentResult.truncated avisa al usuario pero no reintenta automaticamente con el mensaje partido.'],
];
for (const [t, d] of p2) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#7f8c8d').text(`> ${t}`, 60, doc.y, { width: 480 });
  doc.fontSize(8.5).font('Helvetica').fillColor(BLACK).text(d, 70, doc.y, { width: 470 });
  doc.moveDown(0.3);
}

doc.moveDown(0.4);
doc.fontSize(9).font('Helvetica-Oblique').fillColor(GRAY);
doc.text('Conclusion: los 4 P0 estan implementados y verificados end-to-end. MVP listo para launch publico una vez que se setean MP_ACCESS_TOKEN, TELEGRAM_BOT_USERNAME y se flipan los kill switches PAYMENTS_ENABLED y REQUIRE_VERIFIED_CHANNEL desde admin. Los P1/P2 (notificaciones nativas, soft-delete consistente, gráficos scouting, retry truncamiento, etc.) pueden iterarse en post-launch.', 60, doc.y, { width: 480 });

// ==================== FOOTER ON ALL PAGES ====================
const totalPages = doc.bufferedPageRange().count;
for (let i = 0; i < totalPages; i++) {
  doc.switchToPage(i);
  doc.fontSize(7).font('Helvetica').fillColor(GRAY);
  doc.text(`Campo Bot -- Catalogo de Intents -- Pagina ${i + 1} de ${totalPages}`, 50, 780, { align: 'center', width: 495 });
}

doc.end();
stream.on('finish', () => {
  console.log(`PDF generated: ${outputPath}`);
});
