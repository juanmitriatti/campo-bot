# Dashboard UX polish — Diseño

**Fecha:** 2026-07-18
**Estado:** Aprobado

## Contexto

Feedback de Juan sobre los tabs del usuario final: Campos sin explicación y con letra
chica; Observaciones sin ejemplos (Monitoreos sí tiene); Categorías no explica por qué
existen; la card de Exportar no gusta (ocultar); falta edición de perfil; el nombre del
usuario en el Navbar no linkea a Mi cuenta.

## Decisiones acordadas

- **Export de datos: OCULTAR la card** de Mi cuenta (el endpoint `GET /me/export` queda
  vivo — garantía GDPR accesible vía soporte).
- **Perfil editable: nombre + ciudad + email.** Email con unicidad; al cambiarlo se
  resetea `email_verified_at` (el banner de verificación se re-dispara). El teléfono NO
  se edita acá (card de WhatsApp con OTP, ya existe).
- **Tipografía: ajuste general moderado** en todos los tabs (text-sm→text-base datos
  principales, text-xs→text-sm secundarios), no solo Campos.

## A. TabHeader reutilizable (fix sistémico)

`frontend/src/components/TabHeader.tsx`: `{ title, description, botHint? }` → título
(text-xl font-bold), descripción de una línea (text-sm gray), y hint opcional
`💬 Pedile al bot: "ejemplo"` (ejemplo en cursiva/mono, estilo del empty state de
Monitoreos). Se aplica a TODOS los tabs. Copy por tab (es-AR, voseo):

| Tab | description | botHint |
|---|---|---|
| Campos | "La estructura de tu establecimiento: campos, lotes, hectáreas y qué hay sembrado. Acá podés renombrar y corregir hectáreas." | "tengo el campo La Esperanza en Pergamino con los lotes Norte y Sur" |
| Recordatorios | "Lo que le pediste al bot que te recuerde. Marcá hecho o cancelá; se crean por chat." | "acordame el sábado a las 9 de fumigar el lote 5" |
| Categorías | "Con esto se clasifican tus gastos e ingresos en los reportes. El bot las crea solo cuando registrás — acá podés renombrar, borrar o unir duplicadas (ej: 'Gasoil' y 'gas oil')." | — |
| Gastos | "Todos tus gastos registrados. Podés editar o eliminar cualquiera." | "gasté 80 mil en gasoil" |
| Ingresos | "Tus ventas y cobros." | "vendí 200 quintales de soja a 290 mil el quintal" |
| Actividades | "Siembras, fumigaciones, fertilizaciones, cosechas y demás labores." | "fumigué el lote Norte con 2 litros de glifosato" |
| Observaciones | "Notas libres sobre lo que ves en el campo — el bot las guarda con fecha y lote." | "observación: apareció pulgón en la loma del 5" |
| Monitoreos | "Monitoreos estructurados del cultivo: estadio, malezas, plagas, humedad." | (ya tiene ejemplo en empty state; header suma la descripción) |
| Cosechas | "Cada camión que salió: chofer, kilos, humedad, destino." | "cosechamos el lote 3: Ramírez 28.500 kg a Cargill" |
| Stock | "Tus insumos en depósito. El bot descuenta solo cuando registrás una aplicación." | "compré 200 litros de glifosato a 8 mil el litro" |
| Hacienda | "Tu rodeo: categorías, movimientos, sanidad, pesadas." | "compré 40 terneros a 500 mil por cabeza" |
| Documentos | "Facturas y remitos que le mandaste al bot por foto." | (hint: "Sacale una foto a una factura y mandásela al bot") |
| Reportes | "PDFs agronómicos generados por el bot (se guardan 30 días)." | "reporte agronómico del lote Norte" |

## B. Observaciones — empty state con ejemplo

Mismo formato que Monitoreos: borde punteado + "No hay observaciones. Mandale al bot:"
+ ejemplo en mono: `"observación: apareció pulgón en la loma del 5"`.

## C. Tipografía

Pasada general por los tabs: datos principales de tablas/cards text-sm→text-base,
secundarios text-xs→text-sm. NO tocar chips/badges (quedan bien) ni el admin. Criterio:
lo que el productor lee como CONTENIDO sube; los metadatos acompañan.

## D. Mi cuenta

- **Card "Tu perfil"** (primera): nombre, ciudad, email — edición inline o mini-form.
  Teléfono visible read-only con nota "→ se cambia desde la card de WhatsApp".
  Al guardar email distinto: aviso "vas a tener que verificarlo de nuevo".
- **Export**: la card se elimina del render (código de download puede quedar muerto o
  removerse; el endpoint backend NO se toca).
- **Backend nuevo:** `PATCH /api/auth/me` — body `{ name?, city?, email? }`. Valida:
  name no vacío si viene; email formato + unicidad case-insensitive (409 "Ese email ya
  está en uso"); si el email cambia → `email_verified_at = NULL`. Devuelve el usuario
  actualizado. Solo `requireAuth`.

## E. Navbar → Mi cuenta

El `<span>` del nombre pasa a botón (hover subrayado) que lleva al tab Mi cuenta.
Mecanismo: el Dashboard ya maneja `view` con `useState` y pasa callbacks
(`onGoToAccount={() => setView('account')}` existe como patrón) — el Navbar recibe un
prop equivalente. En mobile (nombre oculto hoy) se muestra un ícono de perfil.
Verificar dónde se renderiza el Navbar (si vive fuera del Dashboard, resolver con
callback registrado o query param — decisión del plan mirando el árbol real).

## Fuera de alcance

- Editar teléfono desde perfil (flujo OTP de WhatsApp ya cubre).
- Re-envío automático del mail de verificación al cambiar email (el banner existente
  ofrece "reenviar" — alcanza).
- Rediseño de tablas/filtros más allá de tipografía y headers.

## Testing

- Rutas HTTP (`dashboard-prelaunch.routes.test.ts` o archivo nuevo): PATCH /me — cambia
  name/city (200 + DB), email duplicado → 409, email nuevo → `email_verified_at` NULL,
  scoping implícito (solo el propio usuario), email inválido → 400.
- Frontend: `npm run build` limpio. Verificación visual manual post-deploy.
