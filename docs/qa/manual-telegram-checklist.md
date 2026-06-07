# Checklist manual — Telegram (lo que el harness no puede testear)

El harness de QA usa el endpoint `test-bot`, que corre **el mismo pipeline** que
Telegram/WhatsApp (agente, handlers, flows, guards). Por eso cubre casi todo.
Lo que **NO** puede hacer es enviar **audio real, fotos reales, ni renderizar
botones en el cliente**. Eso requiere un dispositivo. Corré esto en tu teléfono
con el bot de Telegram, una sola vez por release.

> Marcá ✅/❌ y anotá la respuesta textual del bot cuando algo falle.

## 1. Audio / voz (Whisper) — foco: pérdida de datos en transcripción
- [ ] Audio: "gasté cincuenta mil pesos en gasoil" → ¿registra $50.000 Combustible?
- [ ] Audio en **dólares**: "registrá una venta de cien mil dólares" → ¿muestra **USD 100.000** (NUNCA `$100.000`)?
- [ ] Audio con número + unidad: "coseché doscientos quintales de soja en el lote norte" → ¿20.000 kg?
- [ ] Audio largo compuesto: "sembré soja en el lote uno y gasté treinta mil en semillas" → ¿2 acciones?
- [ ] Audio con ruido/acento marcado → ¿transcribe o avisa que no entendió (sin inventar)?
- [ ] Audio vacío / muy corto (<1s) → ¿mensaje claro, sin crash?

## 2. Fotos / documentos (Claude Vision) — foco: OCR y gasto desde factura
- [ ] Foto de una **factura** real → ¿extrae proveedor + monto + items? ¿pide confirmación?
- [ ] Confirmar la factura → ¿crea el/los gasto(s)? Verificá en el dashboard.
- [ ] Foto de un **remito** → ¿carga stock / lista items?
- [ ] Foto borrosa / no-factura (un paisaje) → ¿avisa que no pudo leer, sin inventar montos?
- [ ] Foto + texto en el caption ("esto es del lote sur") → ¿asocia el lote?
- [ ] Documento PDF (si aplica) → ¿lo procesa?

## 3. Botones interactivos (render en el cliente)
- [ ] Tras `coseché` con cultivo → aparecen botones **"Cerrar campaña / Mantener abierta"** y se tocan bien.
- [ ] Onboarding con 2+ lotes → el prompt de "¿a qué lote asigno?" muestra **un botón por lote** + "Dejar a nivel campo".
- [ ] Lista larga (>3 opciones) → se rendea como **lista desplegable**, no botones cortados.
- [ ] Tocar un botón **viejo** (de un mensaje de hace rato) → ¿responde coherente o avisa que expiró?
- [ ] Menú principal (`menú`) → todos los botones funcionan.

## 4. Verificación / onboarding de canal (si `REQUIRE_VERIFIED_CHANNEL=true`)
- [ ] Usuario nuevo escribe al bot sin registrarse → ¿recibe el hint con el link a `/register`?
- [ ] Deep-link `t.me/<bot>?start=verify_<token>` → ¿vincula la cuenta?
- [ ] OTP de WhatsApp (si aplica) → ¿llega el código y valida?

## 5. Multimedia mixta (data-loss en el canal real)
- [ ] Mandar audio **mientras** hay un pending abierto ("¿en qué lote?") → ¿se procesa o se pierde?
- [ ] Mandar foto **mientras** hay un flow abierto → ¿lo maneja sin romper el flow?
- [ ] Reenviar (forward) un mensaje de otro chat → ¿lo ignora limpio?
- [ ] Mensaje muy largo (>4096 chars Telegram) → ¿no crashea, responde algo útil?

---

### Notas
- Para automatizar audio/fotos reales haría falta un **userbot de Telethon**
  (necesita tu `api_id`/`api_hash` + login interactivo). Si querés, lo armamos y
  pasa a ser parte del harness automático.
- Todo lo **text-reachable** (sharing, gating por plan, presupuestos, stock,
  observaciones, reportes, memoria multi-turn, recovery) ya se testea
  automáticamente contra PROD vía el test-bot.
