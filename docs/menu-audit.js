import PDFDocument from 'pdfkit';
import fs from 'fs';

const doc = new PDFDocument({ size: 'A4', margin: 50 });
const output = fs.createWriteStream('docs/menu-audit.pdf');
doc.pipe(output);

const COLORS = {
  primary: '#1a5276',
  secondary: '#2e86c1',
  accent: '#27ae60',
  text: '#2c3e50',
  light: '#7f8c8d',
  bg: '#eaf2f8',
  white: '#ffffff',
};

function title(text) {
  doc.moveDown(0.5);
  doc.fontSize(20).fillColor(COLORS.primary).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(COLORS.secondary).lineWidth(2).stroke();
  doc.moveDown(0.5);
}

function subtitle(text) {
  doc.moveDown(0.3);
  doc.fontSize(14).fillColor(COLORS.secondary).font('Helvetica-Bold').text(text);
  doc.moveDown(0.2);
}

function body(text) {
  doc.fontSize(10).fillColor(COLORS.text).font('Helvetica').text(text, { lineGap: 3 });
}

function bullet(text, indent = 0) {
  const x = 60 + indent * 15;
  doc.fontSize(10).fillColor(COLORS.text).font('Helvetica').text(`•  ${text}`, x, doc.y, { lineGap: 2 });
}

function code(text) {
  doc.fontSize(9).fillColor(COLORS.light).font('Courier').text(text, 65, doc.y, { lineGap: 1 });
  doc.font('Helvetica');
}

function tableRow(cols, widths, bold = false) {
  const y = doc.y;
  const font = bold ? 'Helvetica-Bold' : 'Helvetica';
  const size = bold ? 9 : 9;
  let x = 55;
  for (let i = 0; i < cols.length; i++) {
    doc.fontSize(size).fillColor(bold ? COLORS.primary : COLORS.text).font(font)
      .text(cols[i], x, y, { width: widths[i], lineGap: 1 });
    x += widths[i] + 5;
  }
  doc.moveDown(0.3);
  if (bold) {
    doc.moveTo(55, doc.y).lineTo(545, doc.y).strokeColor('#ddd').lineWidth(0.5).stroke();
    doc.moveDown(0.2);
  }
}

function checkPage(needed = 80) {
  if (doc.y > 720 - needed) doc.addPage();
}

// ─── COVER ─────────────────────────────────────────────
doc.moveDown(6);
doc.fontSize(32).fillColor(COLORS.primary).font('Helvetica-Bold')
  .text('Campo Bot', { align: 'center' });
doc.moveDown(0.3);
doc.fontSize(22).fillColor(COLORS.secondary).font('Helvetica')
  .text('Auditoría del Sistema de Menús', { align: 'center' });
doc.moveDown(1);
doc.fontSize(12).fillColor(COLORS.light).font('Helvetica')
  .text('Documento interno — Abril 2026', { align: 'center' });
doc.moveDown(0.5);
doc.fontSize(10).fillColor(COLORS.light)
  .text('WhatsApp + Telegram — Asistente Agrícola', { align: 'center' });

doc.moveDown(4);
doc.fontSize(10).fillColor(COLORS.text).font('Helvetica')
  .text('Contenido:', 50);
doc.moveDown(0.3);
const toc = [
  '1. Menú Principal',
  '2. Sub-Menús Interactivos',
  '3. Menú de Reportes',
  '4. Flujos Conversacionales (Flows)',
  '5. Sistema de Confirmación',
  '6. Configuración y Alertas',
  '7. Mapeo de Botones (Callback IDs)',
  '8. Soporte por Canal',
];
for (const item of toc) {
  doc.fontSize(10).fillColor(COLORS.secondary).text(`    ${item}`, { lineGap: 4 });
}

// ─── 1. MENÚ PRINCIPAL ────────────────────────────────
doc.addPage();
title('1. Menú Principal');

subtitle('Triggers');
body('El menú principal se activa con los siguientes comandos:');
doc.moveDown(0.2);
bullet('"ayuda", "help", "menu", "menú", "opciones", "?"');
bullet('Botón interactivo: "Ver Menú" (ID: back_menu)');
bullet('Comando /start en Telegram (se mapea a "hola")');

doc.moveDown(0.3);
subtitle('Saludo Inicial (Onboarding)');
body('Al saludar, el bot presenta botones según el estado del usuario:');
doc.moveDown(0.2);

checkPage();
bullet('Sin campos: "Crear Campo" + "Ayuda"');
bullet('Con campos, sin lotes: "Crear Lote" + "Ayuda"');
bullet('Usuario normal: "Gastos" + "Clima" + "Ver Menú"');

doc.moveDown(0.3);
subtitle('Lista del Menú Principal');
body('Se presenta como lista interactiva con 4 secciones:');
doc.moveDown(0.3);

const menuSections = [
  { section: 'Registrar', items: [
    ['flow_new_expense', 'Nuevo Gasto', 'Registrar paso a paso'],
    ['flow_new_income', 'Nuevo Ingreso', 'Registrar paso a paso'],
  ]},
  { section: 'Finanzas', items: [
    ['cmd_resumen_mensual', 'Resultado Mes', 'Ingresos vs gastos'],
    ['menu_reportes', 'Reportes', 'Semanal, CSV, agronómico'],
    ['menu_dolar', 'Dólar', 'Cotización actual'],
  ]},
  { section: 'Campo', items: [
    ['menu_clima', 'Clima', 'Pronóstico del tiempo'],
    ['menu_lluvia', 'Lluvia', 'Registrar, ver reportes'],
    ['menu_campos', 'Campos', 'Listar, agregar campos'],
  ]},
  { section: 'Sistema', items: [
    ['menu_config', 'Configuración', 'Alertas y preferencias'],
    ['menu_ayuda', 'Ayuda', 'Ver todos los comandos'],
  ]},
];

for (const s of menuSections) {
  checkPage();
  doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold').text(`  ${s.section}`);
  doc.moveDown(0.1);
  tableRow(['ID', 'Opción', 'Descripción'], [150, 140, 180], true);
  for (const [id, name, desc] of s.items) {
    checkPage();
    tableRow([id, name, desc], [150, 140, 180]);
  }
  doc.moveDown(0.2);
}

// ─── 2. SUB-MENÚS ─────────────────────────────────────
doc.addPage();
title('2. Sub-Menús Interactivos');
body('Cada sección del menú principal abre un sub-menú con hasta 3 botones:');
doc.moveDown(0.3);

const submenus = [
  { name: 'Gastos', emoji: '💸', buttons: [
    ['cmd_resumen_mensual', 'Resumen Mensual'],
    ['cmd_reporte_mensual', 'Reporte'],
    ['cmd_borrar_ultimo_gasto', 'Borrar Último'],
  ]},
  { name: 'Ingresos', emoji: '💰', buttons: [
    ['cmd_borrar_ultimo_ingreso', 'Borrar Último'],
    ['back_menu', 'Volver al Menú'],
  ]},
  { name: 'Lluvia', emoji: '🌧', buttons: [
    ['cmd_registrar_lluvia', 'Registrar Lluvia'],
    ['cmd_reporte_lluvia', 'Reporte Lluvia'],
    ['back_menu', 'Volver'],
  ]},
  { name: 'Campos', emoji: '🏡', buttons: [
    ['cmd_listar_campos', 'Listar Campos'],
    ['cmd_agregar_campo', 'Agregar Campo'],
    ['back_menu', 'Volver'],
  ]},
  { name: 'Agronomía', emoji: '🌾', buttons: [
    ['cmd_reporte_agro', 'Reporte Agro'],
    ['menu_lluvia', 'Lluvia'],
    ['back_menu', 'Volver'],
  ]},
];

for (const sm of submenus) {
  checkPage(90);
  subtitle(`${sm.emoji}  ${sm.name}`);
  tableRow(['ID del Botón', 'Etiqueta'], [200, 250], true);
  for (const [id, label] of sm.buttons) {
    tableRow([id, label], [200, 250]);
  }
  doc.moveDown(0.2);
}

// ─── 3. MENÚ DE REPORTES ──────────────────────────────
doc.addPage();
title('3. Menú de Reportes');
body('Trigger: comando "reportes" / "informes" o botón menu_reportes.');
body('Se presenta como lista interactiva con 3 secciones:');
doc.moveDown(0.3);

const reportSections = [
  { section: 'Financiero', items: [
    ['cmd_resumen_mensual', 'Resultado del Mes', 'Ingresos vs gastos del mes'],
    ['cmd_reporte_mensual', 'Detalle Mensual', 'Gastos por categoría'],
    ['cmd_reporte_semanal', 'Resumen Semanal', 'Movimientos de la semana'],
    ['cmd_exportar_csv', 'Exportar CSV', 'Descargar datos en planilla'],
  ]},
  { section: 'Agronómico', items: [
    ['cmd_reporte_agro', 'Reporte Agronómico', 'Actividades y observaciones'],
    ['cmd_historial_lote', 'Historial de Lote', 'Timeline completo de un lote'],
  ]},
  { section: 'Lluvias', items: [
    ['cmd_reporte_lluvia', 'Reporte de Lluvia', 'Acumulados por campo y período'],
  ]},
];

for (const s of reportSections) {
  checkPage(80);
  doc.fontSize(11).fillColor(COLORS.accent).font('Helvetica-Bold').text(`  ${s.section}`);
  doc.moveDown(0.1);
  tableRow(['ID', 'Opción', 'Descripción'], [150, 150, 170], true);
  for (const [id, name, desc] of s.items) {
    tableRow([id, name, desc], [150, 150, 170]);
  }
  doc.moveDown(0.3);
}

// ─── 4. FLUJOS CONVERSACIONALES ───────────────────────
doc.addPage();
title('4. Flujos Conversacionales (Flows)');
body('Los flujos guían al usuario paso a paso. Estado persistido en BD. Timeout: 10 min.');
doc.moveDown(0.3);

const flows = [
  { name: 'Gasto (expense_flow)', steps: [
    ['amount', 'Monto', 'Texto libre', '"¿Cuánto gastaste?"'],
    ['category', 'Categoría', 'Lista interactiva', 'Categorías de gasto'],
    ['plotName', 'Lote', 'Botones agrupados por campo', 'Selección dinámica'],
    ['description', 'Detalle', 'Texto libre (opcional)', 'Botón "Saltar"'],
  ]},
  { name: 'Ingreso (income_flow)', steps: [
    ['amount', 'Monto', 'Texto libre', '"¿Cuánto cobraste?"'],
    ['category', 'Categoría', 'Lista interactiva', 'Categorías de ingreso'],
    ['quantity', 'Toneladas', 'Texto libre (opcional)', 'Botón "Saltar"'],
    ['plotName', 'Lote', 'Botones agrupados', 'Selección dinámica'],
    ['description', 'Detalle', 'Texto libre (opcional)', 'Botón "Saltar"'],
  ]},
  { name: 'Campo (field_flow)', steps: [
    ['name', 'Nombre', 'Texto libre', '"¿Cómo se llama?"'],
    ['city', 'Localidad', 'Texto libre + validación', '4027 localidades censales'],
  ]},
  { name: 'Lluvia (rainfall_flow)', steps: [
    ['fieldName', 'Campo', 'Botones dinámicos', 'Selección de campo'],
    ['mm', 'Milímetros', 'Texto libre', '"¿Cuántos mm?"'],
  ]},
  { name: 'Actividad (activity_flow)', steps: [
    ['activityType', 'Tipo', 'Lista interactiva', 'Siembra, fumigación, etc.'],
    ['plotName', 'Lote', 'Botones agrupados (opc.)', 'Skip en labranza/cosecha'],
    ['product', 'Producto', 'Texto libre (opcional)', 'Botón "Saltar"'],
    ['quantity', 'Cantidad', 'Texto libre (opcional)', '"3 lt/ha, 200 kg"'],
  ]},
];

for (const f of flows) {
  checkPage(100);
  subtitle(f.name);
  tableRow(['Paso', 'Campo', 'Input', 'Nota'], [70, 80, 145, 160], true);
  for (let i = 0; i < f.steps.length; i++) {
    checkPage();
    const [field, label, input, note] = f.steps[i];
    tableRow([`${i + 1}. ${field}`, label, input, note], [70, 80, 145, 160]);
  }
  doc.moveDown(0.2);
}

doc.moveDown(0.3);
checkPage();
body('Cada flujo termina con una pantalla de confirmación que muestra un resumen y 3 botones:');
doc.moveDown(0.2);
bullet('flow_confirm → "Confirmar" (guarda en BD)');
bullet('flow_cancel → "Cancelar" (descarta todo)');
bullet('flow_back → "Volver" (retrocede un paso)');

// ─── 5. SISTEMA DE CONFIRMACIÓN ──────────────────────
doc.addPage();
title('5. Sistema de Confirmación');
body('Si el usuario tiene activado "Confirmar antes de guardar" (setting por usuario), las transacciones registradas por mensaje directo (no por flow) también muestran confirmación.');
doc.moveDown(0.3);

subtitle('Formato de Confirmación');
code('💸 *Confirmar gasto:*');
code('');
code('Monto: *$50,000*');
code('Categoría: *Combustible*');
code('Lote: *A1 (Campo Norte)*');
code('Detalle: Nafta para tractor');
code('');
code('[Confirmar]  [Cancelar]');

doc.moveDown(0.5);
subtitle('Botones de Confirmación');
tableRow(['ID', 'Etiqueta', 'Acción'], [150, 100, 220], true);
tableRow(['flow_confirm', 'Confirmar', 'Guarda la transacción en la BD'], [150, 100, 220]);
tableRow(['flow_cancel', 'Cancelar', 'Descarta y vuelve al estado normal'], [150, 100, 220]);
tableRow(['flow_back', 'Volver', 'Retrocede al último paso del flow'], [150, 100, 220]);

doc.moveDown(0.5);
subtitle('Interrupciones Seguras');
body('Algunos comandos se pueden ejecutar durante un flow sin cancelarlo:');
doc.moveDown(0.2);
bullet('Reportes: resumen, reporte, lluvia semana');
bullet('Consultas: clima, dólar, mis campos');
bullet('Información: ayuda, alertas, configuración');

// ─── 6. CONFIGURACIÓN Y ALERTAS ─────────────────────
checkPage(150);
doc.moveDown(0.5);
title('6. Configuración y Alertas');
body('Trigger: "configuración", "alertas", "config" o botón menu_config.');
doc.moveDown(0.3);

subtitle('Panel de Alertas');
body('Muestra el estado actual de las preferencias del usuario:');
doc.moveDown(0.2);
bullet('Alertas de lluvia: activado/desactivado + umbral (mm)');
bullet('Alertas de presupuesto: activado/desactivado');
bullet('Resumen semanal: activado/desactivado + día + hora');
bullet('Confirmar antes de guardar: sí/no');

doc.moveDown(0.3);
subtitle('Comandos de Configuración');
tableRow(['Comando', 'Acción'], [230, 260], true);
tableRow(['"activar alertas lluvia"', 'Habilita notificaciones de lluvia'], [230, 260]);
tableRow(['"desactivar alertas lluvia"', 'Deshabilita notificaciones'], [230, 260]);
tableRow(['"alerta lluvia 20mm"', 'Cambia el umbral a 20mm'], [230, 260]);
tableRow(['"activar resumen"', 'Habilita resumen semanal'], [230, 260]);
tableRow(['"soy Juan"', 'Cambia el nombre del usuario'], [230, 260]);
tableRow(['"estoy en Junín"', 'Cambia la localidad del usuario'], [230, 260]);

// ─── 7. MAPEO DE BOTONES ─────────────────────────────
doc.addPage();
title('7. Mapeo de Botones (Callback IDs)');
body('Todos los botones interactivos se resuelven en interactive.router.ts:');
doc.moveDown(0.3);

subtitle('Botones Estáticos');
const staticButtons = [
  ['menu_gastos', 'show_expense_menu'],
  ['menu_ingresos', 'show_income_menu'],
  ['menu_agro', 'show_agro_menu'],
  ['menu_campos', 'show_fields_menu'],
  ['menu_clima', 'weather_full'],
  ['menu_lluvia', 'show_rain_menu'],
  ['menu_reportes', 'show_reports_menu'],
  ['menu_config', 'show_alerts'],
  ['menu_ayuda', 'help'],
  ['menu_dolar', 'dollar'],
  ['back_menu', 'menu'],
];

tableRow(['Callback ID', 'Comando Interno'], [220, 250], true);
for (const [id, cmd] of staticButtons) {
  checkPage();
  tableRow([id, cmd], [220, 250]);
}

doc.moveDown(0.3);
subtitle('Botones Dinámicos');
tableRow(['Patrón', 'Acción'], [220, 250], true);
tableRow(['flow_cat_<categoría>', 'Selección de categoría en flow'], [220, 250]);
tableRow(['flow_activity_<id>', 'Selección de actividad en flow'], [220, 250]);
tableRow(['flow_plot_<plotId>', 'Selección de lote en flow'], [220, 250]);
tableRow(['flow_new_expense', 'Inicia expense_flow'], [220, 250]);
tableRow(['flow_new_income', 'Inicia income_flow'], [220, 250]);
tableRow(['flow_confirm / cancel / back / skip', 'Control de flujo'], [220, 250]);
tableRow(['cmd_historial_<plotId>', 'Historial de lote específico'], [220, 250]);
tableRow(['rain_field_<campo>_<mm>', 'Registra lluvia directa'], [220, 250]);

// ─── 8. SOPORTE POR CANAL ────────────────────────────
doc.addPage();
title('8. Soporte por Canal');
doc.moveDown(0.3);

subtitle('Diferencias entre WhatsApp y Telegram');
doc.moveDown(0.2);

const channelMatrix = [
  ['Elemento', 'WhatsApp', 'Telegram'],
  ['Botones', 'Máx 3, 1 por fila', 'Inline keyboard, 1 por fila'],
  ['Listas', 'Lista desplegable nativa', 'Grilla de 2 por fila'],
  ['Formato', '*bold* _italic_', '*bold* _italic_ (Markdown)'],
  ['Documentos', 'Archivo adjunto nativo', 'sendDocument API'],
  ['Audio', 'OGG vía Media API', 'downloadFile + transcripción'],
  ['Comando /start', 'N/A', 'Se mapea a "hola"'],
  ['Alertas clima', 'sendMessageWithRetry', 'sendTelegramMessage (3 reintentos)'],
  ['User ID', 'Número de teléfono', 'tg_<chatId>'],
];

tableRow(channelMatrix[0], [120, 180, 180], true);
for (let i = 1; i < channelMatrix.length; i++) {
  checkPage();
  tableRow(channelMatrix[i], [120, 180, 180]);
}

doc.moveDown(0.5);
subtitle('Notas Técnicas');
bullet('WhatsApp: Límite de 3 botones por mensaje (API Cloud)');
bullet('Telegram: Sin límite de botones, se organizan en filas');
bullet('Listas WhatsApp: Hasta 10 filas por sección, 10 secciones');
bullet('Telegram listas: Se convierten a grilla de botones inline (2 por fila)');
bullet('Ambos canales comparten el mismo pipeline de procesamiento');
bullet('Store key: WhatsApp usa teléfono, Telegram usa tg_<chatId>');

// ─── FOOTER ──────────────────────────────────────────
doc.moveDown(3);
doc.fontSize(9).fillColor(COLORS.light).font('Helvetica')
  .text('Generado automáticamente — Campo Bot — Abril 2026', { align: 'center' });

doc.end();
output.on('finish', () => console.log('PDF generado: docs/menu-audit.pdf'));
