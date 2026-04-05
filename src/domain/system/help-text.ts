export function buildHelpText(userName: string | null): string {
  const nombre = userName ? ` ${userName}` : '';
  return `\ud83d\udc4b Hola${nombre}, soy *MIA*
Tu asistente de gesti\u00f3n agr\u00edcola \ud83c\udf31

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udcb8 *Registrar Gastos*
\u2022 Pagu\u00e9 200mil en gasoil
\u2022 500k en fertilizante lote 3

\ud83d\udcb0 *Registrar Ingresos*
\u2022 Vend\u00ed soja por 2 millones
\u2022 Cobr\u00e9 500mil del alquiler

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udcca *Reportes y Resultados*
\u2022 Resumen mes / semana
\u2022 Resultado mes
\u2022 Resultado lote 3
\u2022 Comparar marzo con febrero
\u2022 Resumen desde 1/3 hasta 15/3
\u2022 Cu\u00e1nto gast\u00e9 en los \u00faltimos 10 d\u00edas
\u2022 Exportar mes

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udccb *Presupuestos*
\u2022 Presupuesto combustible 500mil

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83c\udf26 *Clima*
\u2022 Clima / Clima ma\u00f1ana / Clima semana
\u2022 Clima lote 3 / Clima todos

\ud83c\udf27 *Lluvias*
\u2022 Llovi\u00f3 25mm / Cayeron 30mm lote 3
\u2022 Lluvia mes / Lluvia semana
\u2022 Comparar lluvia marzo con febrero

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83c\udf3e *Campos y Lotes*
\u2022 Mis campos
\u2022 Agregar campo norte en Jun\u00edn
\u2022 Info campo norte
\u2022 Renombrar campo norte a sur
\u2022 Borrar campo norte
\u2022 Agregar lote 3 en campo norte
\u2022 Lotes del campo norte
\u2022 Info lote 3
\u2022 Lote 3 tiene 50 hectareas

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83c\udf31 *Cultivos y Actividades*
\u2022 Sembr\u00e9 soja en el lote 3
\u2022 Aplicamos glifosato en el lote norte
\u2022 Tiramos 150 kg de urea en el lote 2
\u2022 Hicimos labranza en el lote 3
\u2022 Regamos el lote norte
\u2022 Qu\u00e9 hay sembrado en el lote 3
\u2022 Actividades lote 3

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83e\uddfe *Documentos*
\u2022 Cargar factura \u2192 registra gastos
\u2022 Cargar remito \u2192 carga al stock
\u2022 Mis facturas / documentos
\u2022 Vincular factura 5 al gasto 42

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u270f\ufe0f *Editar Datos*
\u2022 Borrar \u00faltimo gasto
\u2022 Editar \u00faltimo gasto a 250mil
\u2022 Borrar gasto de semillas
\u2022 Borrar \u00faltima lluvia

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udcb5 *D\u00f3lar*
\u2022 D\u00f3lar / Cotizaci\u00f3n

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\ud83d\udd14 *Alertas*
\u2022 Alertas (ver configuraci\u00f3n)
\u2022 Activar/Desactivar alertas lluvia
\u2022 Activar/Desactivar alertas presupuesto
\u2022 Activar/Desactivar resumen semanal
\u2022 Alerta lluvia 20mm (cambiar umbral)

\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
\u2699\ufe0f *Configuraci\u00f3n*
\u2022 Soy Juan
\u2022 Estoy en Jun\u00edn
\u2022 Ayuda`;
}
