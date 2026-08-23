# Dashboard de usuario final — Resumen + navegación

Rediseño de Ago 2026. Cubre la pantalla **Resumen** (`OverviewSummaryView`) y la **shell de navegación** (sidebar, barra inferior, hoja "Más"). Las otras vistas del dashboard (tablas de Gastos, Hacienda, Stock…) no cambiaron.

---

## La ventana de campaña — `src/utils/campaign-range.ts`

**Fuente única de "qué período muestra el Resumen".** Reusa `getSeasonYear(date, 'gruesa')` de `domain/plots/crop.service.ts`, que ya definía la campaña para los cultivos: **campaña Y = 1 sep Y → 31 ago Y+1**, etiqueta `Y/Y+1`.

No definir una segunda ventana. El riesgo no es teórico: `campaign-stats.service.ts` (reportes agronómicos) usa `season_year`, y si la plata usara otro corte, el mismo usuario vería dos "campaña 25/26" con números distintos según la pantalla. El test `src/utils/__tests__/campaign-range.test.ts` verifica día por día que ambas definiciones coinciden en los bordes.

| Función | Para qué |
|---|---|
| `campaignRange(seasonYear)` | `{seasonYear, label, from, to}` |
| `currentSeasonYear(date?)` | La campaña en curso |
| `resolveCampaign(raw, now?)` | Parsea el query param. Acepta `"2025"` o `"25/26"`. **Nunca tira**: un valor basura cae a la campaña actual, porque un param malo no puede romper toda la pantalla |
| `recentCampaigns(n?, now?)` | Lista para el selector, más nueva primero |

---

## `GET /api/auth/overview?field_id=&season=`

`src/services/overview.service.ts`. `field_id` acepta un id o `all`; `season` acepta año o etiqueta y por defecto es la campaña actual.

**Por qué no se extendió `/dashboard`**: aquel responde "cómo viene ESTE MES" (actual vs anterior) y sigue vivo para otros consumidores. Este responde "cómo cerró LA CAMPAÑA" — otra ventana, otro grano (por lote, ranking por categoría) y otra historia de moneda.

Payload:

- `campaign` / `campaigns` — la ventana y la lista para el selector
- `observed` — primer y último movimiento reales dentro de la ventana (no es lo mismo que la ventana)
- `money.ARS` / `money.USD` — `{income, expense, result, incomeCount, expenseCount}` **en paralelo, nunca colapsados**
- `categories.ARS` / `.USD` — gasto por categoría, ordenado desc
- `rainfall` — total, cantidad de registros y **los 12 meses de la ventana**, incluidos los vacíos
- `activities.count`, `plots[]` (con `spendARS/USD` e `incomeARS/USD`), `feed[]` (10 últimos, mezcla gasto/ingreso/actividad)
- `counts` — contadores por sección para los badges del nav, incluido `stockAlerts`

**Las dos monedas van siempre juntas, sin toggle.** Un campo argentino cierra negativo en pesos y positivo en dólares en la misma campaña: los costos son ARS y el grano se vende en USD. Mostrar una sola y llamarla "el resultado" es incorrecto. El toggle ARS/USD que sí existe afecta únicamente el detalle por lote y por categoría.

**Los meses sin lluvia se dibujan igual.** Un mes en cero es la información más útil del gráfico: si llovió y nadie se lo dictó al bot, el acumulado de campaña queda corto. Sacarlo del eje esconde exactamente eso.

**Etiquetas de mes en JS, no en SQL.** `to_char(..., 'TMMon')` sigue el `lc_time` del servidor, que no es español en todos los deploys (un cluster en locale C devuelve `dec`/`jan`).

---

## `GET /api/auth/review?field_id=&season=` — "Para revisar"

`src/services/review-findings.service.ts`.

Todo en campo-bot entra dictado a un chat y parseado por un LLM. La falla peligrosa no es el registro que falta — es el que **parece bien y está mal**, porque se arrastra al reporte sin que nadie lo mire. Esta card asume que algo salió mal y lo busca.

Las reglas son **contradicciones chequeables, nunca inferencias**. Cada una devuelve `Finding[]`:

```ts
{ key, rule, severity: 'warn'|'info', title, body, action,
  ref: {type:'activity'|'expense'|'plot'|'field', id} | null, fieldId }
```

| Regla | Qué detecta |
|---|---|
| `product_is_plot_name` | El nombre de un lote quedó en `domain_events.product` ("fertilicé el lote norte" → producto = "lote norte"). Matchea vía `entity-matcher` |
| `overlapping_plantings` | 2+ cultivos distintos sembrados en el mismo lote dentro de 45 días |
| `harvest_before_planting` | Cosecha con fecha anterior o igual a su propia siembra, mismo lote y cultivo |
| `outlier_plot_area` | Lote con superficie ≥10× la **mediana** de los demás (mediana, no promedio: un outlier no puede esconderse detrás de su propio efecto) |
| `expense_without_plot` | Gasto a nivel campo en un campo con 2+ lotes |
| `hollow_fields` | Campos con movimientos y sin lotes, o con lotes y sin ningún registro |

**Regla nueva = una entrada en `RULES`.** Nunca lógica suelta en un handler.

**Es advisory.** Una regla que explota loguea `[REVIEW]` y devuelve `[]` — degrada a menos hallazgos, jamás a un Resumen roto. Nada acá escribe en la base.

**`expense_without_plot` excluye a propósito las categorías de `utils/field-level-categories.ts`.** Ese set salió de `financial.handler.ts` a un módulo compartido justamente por esto: el handler strippea el lote auto-resuelto de gastos corporativos (sueldos, arrendamiento…) **a propósito**, y con dos copias de la lista el dashboard terminaría delatando su propia regla como un error del usuario. Una sola fuente (invariante 3).

Los descartes del usuario viven en `localStorage` (`campo:reviewDismissed`), no en la base: un hallazgo es una opinión derivada, no un registro — si se corrige el dato, desaparece solo.

---

## Navegación — `frontend/src/components/layout/nav-model.ts`

**Fuente única** del sidebar, la barra inferior y la hoja "Más". Antes eran dos arrays mantenidos a mano que ya habían divergido: el sidebar tenía Stock y Hacienda, la barra inferior no.

Agrupación por la pregunta que se hace el productor, no por tabla:

| Grupo | Pregunta | Ítems |
|---|---|---|
| Producción | ¿Qué pasó en el lote? | Campos y lotes · Actividades · Monitoreos · Cosechas · Reportes |
| Plata | ¿Cómo viene la plata? | Gastos · Ingresos · Categorías |
| Recursos | ¿Qué tengo? | Stock · Hacienda · Documentos |

Recordatorios y Mi cuenta bajan al pie, separados: son configuración, no datos de campaña, y no deberían competir visualmente con Gastos.

**Mobile: 4 destinos, no 13.** La barra anterior renderizaba todos los ítems en `justify-around` sobre 56px: en un teléfono de 390px son ~30px por tab, bajo el mínimo táctil de 44, con etiquetas de 7px. El resto vive en `MoreSheet`, agrupada igual que el sidebar para que las dos navegaciones enseñen el mismo mapa.

**Observaciones dejó de ser destino propio** y es sub-tab de Actividades (`Dashboard.tsx`). Para quien le dicta al bot, una observación ES un registro del lote; dos tablas casi iguales obligaban a buscar en dos lugares. El view `observations` sigue resolviendo, para links viejos.

**Contadores por sección**: vienen de `counts` del overview. Existen para poder decidir **antes** de entrar — con la lista plana, Monitoreos/Stock/Documentos en cero ocupaban exactamente el mismo espacio y atención que Gastos con 26 filas.

**El selector de campo salió del sidebar** y pasó a chips junto al contenido (`FieldChips`). Filtra todo lo que se ve, así que pertenece al contenido; y el sidebar está oculto en mobile, donde el filtro directamente no existía.

---

## Decisiones de presentación

- **El donut de categorías pasó a barras rankeadas de una sola tinta.** Gasto por categoría es una comparación de MAGNITUD, no de identidad: diez hues no codificaban nada que la etiqueta no dijera ya, y "¿Combustible es más que Insumos?" se lee peor en un donut que en barras ordenadas.
- **El cultivo NO se codifica por color.** Cuatro hues categóricos no pasan el gate de separación CVD en modo oscuro (violeta↔azul ΔE 1.9 en protanopia). La identidad la lleva el nombre, que además ya está escrito al lado.
- **Cada número del resultado viene con la frase que lo explica** ("73% del gasto es hacienda"), en vez de dejar que el usuario la deduzca.
- **Casing de cultivos normalizado solo para mostrar** (`displayCrop`): la misma cuenta guarda "Maíz" y "maíz". El valor almacenado no se toca.
- **"Actualizar" ya no hace `window.location.reload()`** — refresca los datos.

## Compartir un solo fetch

`useOverviewData` cachea por `(field, season)` en un store a nivel módulo con suscriptores — el mismo patrón que `useSelectedField`. El Resumen, el sidebar y la hoja "Más" consumen el mismo payload sin disparar tres requests. `invalidateOverview()` limpia todo tras una mutación.

## Archivos

| Archivo | Rol |
|---|---|
| `src/utils/campaign-range.ts` | La ventana de campaña (+ test) |
| `src/utils/field-level-categories.ts` | Set compartido con `financial.handler.ts` |
| `src/services/overview.service.ts` | Payload del Resumen |
| `src/services/review-findings.service.ts` | Reglas de "Para revisar" |
| `src/routes/auth.routes.ts` | `/overview`, `/review`, `parseFieldIdParam` |
| `frontend/src/hooks/useOverviewData.ts` | Fetch compartido + caché |
| `frontend/src/hooks/useReviewFindings.ts` | Hallazgos + descartes locales |
| `frontend/src/hooks/useSelectedCampaign.ts` | `?season=` en la URL |
| `frontend/src/components/layout/nav-model.ts` | Navegación (fuente única) |
| `frontend/src/components/layout/MoreSheet.tsx` | Hoja "Más" (mobile) |
| `frontend/src/components/overview/` | `CampaignResult`, `ReviewPanel`, `RainfallMonths`, `PlotCards`, `CategoryRanking`, `CampaignFeed`, `FieldChips`, `CampaignPicker` |
| `frontend/src/utils/format.ts` | Formato de plata, hectáreas y fechas |
| `design/*.dc.html` + `design/canvas.json` | Fuentes del canvas de diseño. El HTML sembrado (~2,3 MB) está gitignoreado: se regenera con el helper de la skill `/design` |

## Tipografía

IBM Plex Sans + IBM Plex Mono, vía Google Fonts en `frontend/index.html` (`display=swap` + stack de fallback en `tailwind.config.js`). Antes no había tipografía propia: caía al stack del sistema. Los números tabulares de Plex Mono importan acá — la pantalla es mayormente columnas de plata y milímetros.

**Es una dependencia externa nueva.** Si el host no responde la app renderiza con la fuente del sistema, pero es una request a un tercero que antes no existía. Self-hostear las fuentes es un cambio acotado a esos dos archivos.

## Pendientes conocidos

- Quedaron sin uso `CategoryDonutChart`, `RecentFeed`, `FieldSelector` y `RentabilidadPorLoteChart`. No se borraron porque `computeRentabilidadPorLote` tiene tests propios; es una limpieza aparte.
- `/review` corre 6 queries por carga del Resumen. Irrelevante a la escala actual; es el primer lugar donde mirar si crece el uso.
- Las reglas de revisión no tienen tests de integración (necesitan DB seedeada). El único test nuevo cubre `campaign-range`.
