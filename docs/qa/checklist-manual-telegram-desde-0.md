# Checklist de testeo manual — Telegram desde 0

Usuario reseteado: **Telegram (juan.mitriatti)**, plan **pro_plus**. Empezás sin campos ni datos.
Marcá ✅/❌. Si algo falla, copiá el mensaje que mandaste + la respuesta del bot.

---

## 1. Onboarding (lo primero que hace un usuario nuevo)
- [ ] `Tengo el campo La Esperanza en Pergamino con lotes Norte, Sur y Este` → crea campo + 3 lotes + pregunta hectáreas
- [ ] `todos 50` → asigna 50 ha a los 3 lotes
- [ ] (variante) probá también: `agregar campo San Martín en Junín con lotes A1, A2` → debería crear campo + lotes (no quedarse pidiendo la ciudad)
- [ ] `mis campos` → lista los campos con lotes y hectáreas
- [ ] **Trampa de hectáreas**: arrancá otro onboarding, y cuando pregunte las has mandá `crear un depósito Galpón 1` → NO debe quedarse en loop pidiendo hectáreas; procesa el depósito

## 2. Gastos / Ingresos + moneda
- [ ] `gasté 50 mil en gasoil en el lote Norte` → registra Combustible $50.000
- [ ] `vendí 10 tn de soja a 200 USD` → ingreso en **USD** (nunca con `$`: debe decir "USD 2.000" o "2.000 dólares")
- [ ] `cuánto gasté este mes` → reporte (con `$` solo para pesos, "USD" para dólares)
- [ ] **Pivot sin perder dato**: `gasté 30 mil en semillas` → cuando pida lote, mandá `cuánto llevo gastado` → debe **guardar el gasto** ("💡 Guardé el gasto…") y además responder la consulta
- [ ] **Categoría reusada**: `gasté 20 mil en urea` → `otros 5 mil más` → mismo tipo

## 3. Correcciones (acá metimos varios fixes — probá fuerte)
- [ ] `gasté 10 mil en gasoil` → `no, eran 15 mil` → corrige el monto (1 sola fila)
- [ ] corrección encadenada: `gasté 10 mil en nafta` → `no, eran 12 mil` → `perdón, en realidad 15 mil` → queda en 15.000 (sin duplicar)
- [ ] corrección por referente: registrá gasoil y urea, después `no, el de gasoil eran 70 mil` → corrige **gasoil** (no la urea)
- [ ] referente inexistente: `no, el de fungicida eran 40 mil` (sin tener uno) → "no encontré un gasto de fungicida" (no edita otro)
- [ ] **moneda**: `vendí 5 tn de maíz a 100000` → cuando pida lote `no, eran dólares` → pasa a USD (sin fila fantasma en pesos)
- [ ] **sinónimos de moneda** (NUEVO): probá `no, eran verdes` y `no, eran mangos`
- [ ] corrección de fecha: `fumigué glifosato en el lote Norte` → `el último era de ayer` → fecha = ayer (bien, sin -1 día)
- [ ] **sinónimos de corrección** (NUEVO): `me equivoqué, eran 8 mil` / `corrijo, son 9 mil` / `más bien 12 mil`

## 4. Actividades agro
- [ ] `sembré soja en el lote Sur` → siembra
- [ ] `fumigué con glifosato 3 litros en el lote Norte` → fumigación con dosis
- [ ] **corrección de dosis** (NUEVO): `no, eran 5.5 litros` → actualiza la dosis (probá también `5 lts`, `2 L`, `200 gramos`)
- [ ] `fertilicé con fosfato en el lote Este`
- [ ] **plot con "en"**: `fumigué con cipermetrina 1 litro` → cuando pida lote `no, en Sur` → guarda en Sur (no lo descarta)
- [ ] `coseché soja en el lote Sur, rindió 42 qq` → cosecha (42 qq = 4200 kg/ha)

## 5. Lluvia
- [ ] `llovió 20mm en La Esperanza` → registra
- [ ] **multi-día** (NUEVO): `en La Esperanza cayeron 30mm el lunes, 25 el martes y 40 el sábado` → 3 registros con **fechas distintas** (no todas hoy)
- [ ] `cuánto llovió este mes`

## 6. Compound (varias acciones en un mensaje)
- [ ] `gasté 5 mil en gasoil y compré urea por 2 mil` → 2 gastos, **categorías distintas** (Combustible + Fertilizantes, no las dos iguales)
- [ ] **cola serial** (NUEVO): `vendí 11 tn de soja y vendí 7 tn de maíz` → te pregunta precio de cada una → `a 200000` → `a 100000` → `Norte` → **ambas ventas guardadas** (probá meter `qué lotes tengo` en el medio: igual no se pierde ninguna)

## 7. Hacienda (pro_plus)
- [ ] `agregué 50 vacas y 2 toros` → registra
- [ ] `vendí 3 novillos a 800 mil c/u` → baja + ingreso linkeado
- [ ] `vacuné las vacas contra aftosa` → evento sanitario
- [ ] `pesé los novillos, 380 kg promedio` → pesaje
- [ ] `cuántas vacas tengo`

## 8. Stock (pro_plus)
- [ ] `crear depósito Galpón Central`
- [ ] `cargué 100 litros de glifosato a 800 el litro` → stock + gasto auto
- [ ] `cuánto stock tengo de glifosato`
- [ ] `usé 30 litros de glifosato` → descuenta

## 9. Borrar / editar (con sinónimos NUEVOS)
- [ ] `gasté 7 mil en grasa en el lote Norte` → después `anulá el gasto de grasa` → borrado (probá también `dá de baja`, `eliminá`, `deshacé`)
- [ ] `borrá el último gasto`

## 10. Memoria conversacional
- [ ] `gasté 8 mil en repuestos en el lote Sur` → `cuánto gasté ahí` → reporte **del lote Sur** (no error "__last__")
- [ ] `sembré maíz en el lote Norte` → `cuándo se sembró ahí` → consulta el mismo lote

## 11. Reportes / consultas
- [ ] `cómo vamos` / `reporte financiero`
- [ ] `qué cultivo tiene el lote Norte`
- [ ] `clima en Pergamino`

## 12. Recovery / borde
- [ ] mandá un audio diciendo un monto en dólares → debe registrar USD (no `$`)
- [ ] mandá una foto de una factura → debe ofrecer registrar el gasto
- [ ] `gasté -50 mil` → lo rechaza
- [ ] emoji solo / mensaje sin sentido → respuesta amable, sin romperse

---

### Notas
- Alertas (clima/viento/proactivas) están **desactivadas** a pedido — no vas a recibir notificaciones automáticas.
- Si algo da raro, anotá el texto exacto y lo miramos.
