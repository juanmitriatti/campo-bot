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
  // Measure content height first by doing a dry run
  const cardX = 58;
  const cardW = 484;
  const contentX = cardX + 6;
  const contentW = cardW - 12;

  const modeLabel = mode === 'ai' ? '  [AI Agent]' : mode === 'regex' ? '  [Regex]' : '  [AI + Regex]';
  const modeColor = mode === 'ai' ? '#2e86c1' : mode === 'regex' ? '#e67e22' : '#27ae60';
  const borderColor = mode === 'ai' ? '#2e86c1' : mode === 'regex' ? '#e67e22' : '#27ae60';

  // Check if we need a new page (estimate ~100px per card)
  if (doc.y > 630) doc.addPage();

  const startY = doc.y + 4;

  // -- Render content --
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

  // -- Draw left accent border --
  doc.save();
  doc.roundedRect(cardX, startY, 3, endY - startY, 1.5).fill(borderColor);
  doc.restore();

  // -- Draw bottom separator --
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
doc.roundedRect(140, statsY, 270, 90, 6).strokeColor(SECONDARY).lineWidth(1).stroke();
doc.fontSize(11).font('Helvetica-Bold').fillColor(PRIMARY).text('Resumen', 0, statsY + 12, { align: 'center' });
doc.moveDown(0.3);
doc.fontSize(9.5).font('Helvetica').fillColor(BLACK);
doc.text('21 herramientas AI Agent (tool_use)', 0, statsY + 30, { align: 'center' });
doc.text('36+ comandos regex (triviales)', 0, statsY + 45, { align: 'center' });
doc.text('6 dominios: Finanzas, Agro, Clima,', 0, statsY + 60, { align: 'center' });
doc.text('Campos, Reportes, Sistema', 0, statsY + 73, { align: 'center' });

doc.y = statsY + 110;
doc.moveDown(5);
doc.fontSize(8).fillColor(GRAY).text(`Generado: ${new Date().toLocaleDateString('es-AR')} -- Campo Bot v1.0`, { align: 'center' });

// ==================== PIPELINE PAGE ====================
doc.addPage();
sectionTitle('Pipeline de Clasificacion');
doc.fontSize(9.5).font('Helvetica').fillColor(BLACK);
doc.text('Cada mensaje del usuario pasa por el siguiente pipeline de clasificacion en orden de prioridad:', { width: 495 });
doc.moveDown(0.5);

const pipelineSteps = [
  ['1. Prefijo observacion', 'Mensajes que comienzan con "observacion:", "obs:" o "nota:" se clasifican como log_observation sin pasar por AI.'],
  ['2. Comandos triviales (regex)', '36 comandos simples (hola, menu, agregar campo, etc.) se detectan por regex. No consumen API de AI.'],
  ['3a. AI Agent (tool_use)', 'Si AGENT_ENABLED=true, Claude decide que herramienta(s) usar. Soporta acciones compuestas.'],
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

intentCard('log_expense', 'Registra un gasto agricola. Se activa con verbos como gaste, pague, compre seguido de un monto. Soporta categorias: Combustible, Semillas, Agroquimicos, Fertilizantes, Maquinaria, Mano de Obra, Servicios, Flete, Seguros, Impuestos, Alquiler, Otros.', [
  'gaste 50mil en gasoil para el lote norte',
  'compre semillas de soja por 200 dolares',
  'pague 150000 de flete',
], ['amount (requerido)', 'description (requerido)', 'category', 'currency (ARS/USD)', 'field', 'plot'], 'ai');

intentCard('log_income', 'Registra un ingreso. Se activa con verbos como vendi, cobre seguido de un monto. Soporta categorias: Venta Granos, Venta Hacienda, Servicios, Alquiler, Otros.', [
  'vendi 30 toneladas de soja a 300 usd la tonelada',
  'cobre 500mil por la cosecha de trigo',
], ['amount (requerido)', 'description (requerido)', 'category', 'currency', 'quantity', 'unit', 'unit_price', 'field', 'plot'], 'ai');

intentCard('financial_report', 'Reporte financiero unificado. Reemplaza los anteriores field_report, plot_report, monthly_report, weekly_report, monthly_result y date_range_report. Soporta filtros por campo, lote, periodo, rango de fechas, categoria, tipo (gastos/ingresos/ambos) y actividades agronomicas.', [
  'reporte mensual',
  'gastos del campo La Esperanza',
  'gastos del lote A1',
  'resumen semanal',
  'resultado del mes',
  'gastos ultimos 30 dias',
  'gastos en combustible este anio',
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

// ==================== AGRONOMY INTENTS ====================
doc.addPage();
sectionTitle('Intents Agronomicos', '#27ae60');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Actividades agricolas, observaciones de campo y registros fenologicos.');
doc.moveDown(0.5);

subsection('Actividades de Campo');

intentCard('log_spraying', 'Registra fumigacion/pulverizacion. Verbos: fumigue, pulverice, aplique, tire (herbicida/insecticida/fungicida).', [
  'fumigue glifosato en el lote norte',
  'aplique insecticida ayer',
  'tire herbicida en el campo sur',
], ['product', 'product_type (herbicida|insecticida|fungicida)', 'quantity', 'unit', 'crop', 'field', 'plot'], 'ai');

intentCard('log_fertilization', 'Registra fertilizacion. Verbos: fertilice, abone, meti (fertilizante).', [
  'fertilice con urea el lote A1',
  'meti DAP 100kg/ha',
], ['product', 'quantity', 'unit', 'crop', 'field', 'plot'], 'ai');

intentCard('sow_crop', 'Registra siembra. Verbos: sembre, implante.', [
  'sembre maiz en el lote sur',
  'hoy sembramos soja en campo norte',
], ['crop (requerido)', 'field', 'plot'], 'ai');

intentCard('harvest_crop', 'Registra cosecha. Verbos: coseche, levante.', [
  'coseche 25 toneladas de trigo',
  'levante la soja del lote A1',
], ['crop (requerido)', 'quantity', 'unit', 'field', 'plot'], 'ai');

intentCard('log_tillage', 'Registra labranza/preparacion de suelo. Verbos: are, disquee, rastree, pase disco/cincel.', [
  'are el lote 3',
  'pase disco ayer en el norte',
], ['product (implemento)', 'crop', 'field', 'plot'], 'ai');

intentCard('log_irrigation', 'Registra riego. Verbos: regue, riego.', [
  'regue 50mm esta manana',
  'riego pivot en lote A1',
], ['quantity', 'unit', 'crop', 'field', 'plot'], 'ai');

subsection('Observaciones');

intentCard('log_observation', 'Registra una observacion agronomica de campo. Categorias auto-detectadas: malezas, sanidad, nutricion, fenologia, clima, general. El prefijo "observacion:" o "obs:" fuerza la clasificacion sin AI.', [
  'observacion: hay roya en el lote norte',
  'hay mucha maleza en el campo sur',
  'el maiz esta en V6 en el lote A1',
], ['observation (requerido)', 'crop', 'field', 'plot'], 'both');

intentCard('log_rainfall', 'Registra milimetros de lluvia. Patrones: llovieron Xmm, cayeron X milimetros.', [
  'llovieron 25mm',
  'cayeron 30 milimetros anoche',
], ['quantity en mm (requerido)', 'field'], 'both');

// ==================== WEATHER & REPORTS ====================
doc.addPage();
sectionTitle('Clima y Reportes Agronomicos', '#2e86c1');

intentCard('weather_full', 'Consulta del clima actual y pronostico extendido para la ubicacion del usuario o campo especifico.', [
  'que tiempo hace',
  'pronostico',
  'clima en el campo norte',
], ['field'], 'ai');

intentCard('rainfall_report', 'Reporte de lluvias: acumulado por periodo (hoy, semana, mes, anio, semana pasada, mes pasado).', [
  'cuanto llovio esta semana',
  'lluvia del mes',
  'lluvias acumuladas este anio',
], ['period (today|week|month|year|last_week|last_month)', 'field', 'plot'], 'ai');

intentCard('generate_agro_report', 'Genera reporte agronomico semanal en PDF: observaciones por lote, actividades recientes, cultivo activo.', [
  'reporte agronomico',
  'reporte agro del lote norte',
  'estado del campo',
  'como va el lote A1',
], ['field', 'plot', 'date_range'], 'both');

intentCard('query_plot_history', 'Consulta el historial de actividades de un lote: fumigaciones, siembras, cosechas, fertilizaciones, lluvias, observaciones.', [
  'cuando se fumigo el lote norte',
  'historial del lote A1',
  'ultima vez que se sembro en el sur',
  'en que lote sembre maiz',
], ['plot', 'field', 'crop', 'timeRef', 'activityFilter'], 'both');

// ==================== FIELD/PLOT MANAGEMENT ====================
doc.addPage();
sectionTitle('Gestion de Campos y Lotes', '#8e44ad');
doc.fontSize(9).font('Helvetica').fillColor(GRAY).text('Creacion, modificacion y consulta de campos (fields) y lotes (plots).');
doc.moveDown(0.5);

intentCard('add_field', 'Crea un nuevo campo. Opcionalmente puede incluir localidad.', [
  'agregar campo La Esperanza',
  'crear campo norte en Pergamino',
], ['field (requerido)', 'city'], 'both');

intentCard('add_plot', 'Crea un nuevo lote dentro de un campo. Puede incluir hectareas.', [
  'agregar lote A1 en campo norte',
  'crear lote sur de 150 hectareas',
], ['plotName (requerido)', 'field', 'hectares'], 'both');

intentCard('add_plots_batch', 'Crea multiples lotes de una vez en un campo.', [
  'agregar lotes A1, A2 y A3 en campo norte',
  'crear lotes norte, sur, este',
], ['plotNames[] (requerido)', 'field'], 'both');

intentCard('set_plot_area', 'Asigna superficie en hectareas a un lote existente.', [
  'lote A1 tiene 50 hectareas',
  'asignar 75 ha al lote sur',
], ['plot (requerido)', 'hectares (requerido)'], 'both');

intentCard('set_field_city', 'Asigna localidad a un campo existente.', [
  'el campo norte esta en Pergamino',
  'ubicar campo sur en Junin',
], ['field (requerido)', 'city'], 'both');

subsection('Consulta y Gestion');

intentRow('field_info', 'Muestra informacion detallada de un campo: lotes, cultivos, superficie.', ['info del campo norte', 'estado campo La Esperanza']);
intentRow('plot_info', 'Muestra informacion detallada de un lote: cultivo activo, hectareas, ultimas actividades.', ['info del lote A1', 'como viene el lote sur']);
intentRow('list_fields', 'Lista todos los campos del usuario con sus lotes.', ['mis campos', 'que campos tengo', 'ver campos']);
intentRow('list_plots', 'Lista todos los lotes de un campo o del usuario.', ['mis lotes', 'lotes del campo norte']);
intentRow('delete_field', 'Elimina un campo (soft delete, recuperable).', ['borrar campo norte', 'eliminar campo viejo']);
intentRow('delete_plot', 'Elimina un lote (soft delete, recuperable).', ['borrar lote A1 del campo norte']);
intentRow('restore_field', 'Restaura un campo o lote eliminado.', ['restaurar campo norte', 'recuperar lote A1']);

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

subsection('Acciones Compuestas');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Mensajes con multiples acciones unidas por "y" + verbo de accion se envian al AI Agent (no se procesan por regex). Ejemplo: "agregar lote norte y registrar un gasto de 100mil en gasoil".', 60, doc.y, { width: 475 });
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
doc.text('Verbos agronomicos (fumigue, sembre, coseche, etc.) son SOLO actividades y NUNCA gastos, a menos que el usuario mencione explicitamente un monto. Si el AI Agent retorna log_expense junto a una actividad agro, el expense se filtra automaticamente.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Reporte Financiero Unificado');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('La herramienta financial_report unifica 6 reportes anteriores (field_report, plot_report, monthly_report, weekly_report, monthly_result, date_range_report) en una sola herramienta con parametros opcionales. Los nombres anteriores se mantienen como alias en regex/JSON para compatibilidad.', 60, doc.y, { width: 475 });
doc.moveDown(0.5);

subsection('Deduplicacion de Observaciones');
doc.fontSize(9).font('Helvetica').fillColor(BLACK);
doc.text('Las observaciones pasan por 4 capas de deduplicacion: normalizacion de texto, cache en memoria (5 min), verificacion en DB (5 min), y dedup al renderizar. Evita duplicados por mensajes repetidos.', 60, doc.y, { width: 475 });

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
