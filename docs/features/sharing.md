# Campos compartidos

Darle acceso a otra persona (socio, empleado, ingeniero) a un campo, para que
registre sobre los mismos datos. Feature `sharing`, plan mínimo **pro_plus** —
es el único escalón entre Pro y Pro+.

## Cómo funciona

1. El dueño invita **por número de teléfono**, desde el tab *Compartir* del
   dashboard o diciéndole al bot `compartir campo La Esperanza con 11 2345 6789`.
2. El sistema emite una invitación: un código de 6 caracteres **atado a ese
   número**, válido 7 días, de un solo uso.
3. La entrega es un **link `wa.me`** que el dueño reenvía por su propio WhatsApp.
   El invitado lo toca, se le abre el chat con el bot con `unirme <CÓDIGO>` ya
   escrito, y lo manda.
4. El invitado queda como `member` del campo y puede registrar y consultar todo.
   Solo el dueño puede borrar, renombrar y volver a compartir.

### Por qué un link y no un mensaje del bot

`services/whatsapp.js` **no tiene soporte de plantillas** (`type:"template"`).
Todo envío es free-form, y Meta solo entrega free-form dentro de la ventana de
24 h desde el último mensaje **del usuario**. Alguien a quien recién invitás, por
definición, nunca le escribió al bot: cualquier envío directo se rechaza.

El link es el análogo WhatsApp del deep-link de Telegram que ya se usa para
vincular cuenta. `src/domain/sharing/invite-notifier.ts` deja el punto de
extensión para el día que haya una plantilla aprobada: la ruta ya lee el
resultado (`delivery: 'sent' | 'link'`) y no habría que tocar ni la UI.

Setting **`WHATSAPP_BOT_NUMBER`** (grupo `system`, público — no es el
`WHATSAPP_PHONE_NUMBER_ID` de Meta). Vacío → se entrega el código pelado, como
antes; la falta de configuración nunca rompe el flujo.

## Fuentes únicas

| Qué | Dónde |
|---|---|
| Normalización de teléfonos | `src/utils/phone.ts` + espejo SQL `canonical_phone_ar()` (migración 122) |
| Link y texto de la invitación | `src/domain/sharing/invite-link.ts` |
| "Qué campos ve este usuario" | `src/domain/shared/accessible-fields.ts` |
| Guards de acceso y fila `owner` | `src/domain/shared/field-access.ts` |
| Reglas de invitación / membresía | `src/domain/sharing/field-sharing.service.ts` |

El bot y el dashboard usan **el mismo servicio**: dos caminos para dar acceso a
un campo serían dos reglas distintas.

## Teléfonos: el bug que obligó a la migración 122

`users.phone_number` es UNIQUE y tres caminos lo escribían distinto:

- el webhook de WhatsApp guardaba `message.from` crudo → `549XXXXXXXXXX`;
- el OTP de la web guardaba `+54…` y, peor, **sin el 9 de celular**;
- el alta manual del admin, lo que tipeara el operador.

Consecuencia en prod: quien vinculaba WhatsApp desde el dashboard quedaba con un
número que el webhook no volvía a encontrar (`findVerifiedByPhone` comparaba con
`=`), y al escribirle al bot recibía "creá tu cuenta" para siempre. Y sin forma
canónica, "invitar por número" es inconstruible: no hay con qué comparar.

La canónica es `549` + 10 dígitos nacionales, **sin `+`** — es lo que manda Meta,
lo que ya tenía la mayoría de las filas, y de lo que se derivan las claves de los
pending stores (`wa:<phone>`).

**Las colisiones no las arregla la migración.** Si `549X` y `+549X` son dos
cuentas distintas de la misma persona, fusionarlas mueve campos, gastos e
historial entre usuarios, y eso no puede correr solo al arrancar el proceso
(mismo criterio que `merge-duplicate-breeds.ts`). La migración las lista por
NOTICE y las resuelve `src/scripts/merge-duplicate-phone-users.ts` (dry-run por
default, `--apply` para aplicar). El script **no** fusiona si los dos lados
tienen email real y distinto: son dos personas.

## Seguridad de la invitación

- **Atada al teléfono** (`invited_phone`): solo ese número la redime. Antes el
  código era una llave al portador — el dueño lo manda por WhatsApp, donde queda
  reenviable para siempre.
- **Revocable** (`revoked_at`): reenviar revoca automáticamente la anterior
  (índice único parcial sobre las invitaciones vivas), así no quedan dos códigos
  válidos sueltos.
- `invited_phone` NULL = **código abierto**, el comportamiento legacy. Los
  invites viejos siguen funcionando.
- El estado (`pending` / `used` / `revoked` / `expired`) es **derivado** y se
  deriva en un solo lugar (`STATUS_SQL`). Una columna `status` habría que
  mantenerla sincronizada con tres fuentes.

## Plan del colaborador

El invitado tiene su propia cuenta, con su propia prueba de 14 días. Al vencer
quedaba en solo-lectura y no podía cargar nada en el campo del dueño **aunque el
dueño pagara Pro+**, que es el plan que incluye compartir: el empleado se volvía
inútil a las dos semanas.

Ahora `getUserAccessMode` (STEP 0) chequea, antes de bloquear, si el usuario es
miembro de algún campo cuyo **dueño** está al día; si sí, devuelve `full` y
loguea `[ACCESS] heredado de owner=<id>`. El dueño paga para que su equipo
cargue. No hay recursión: se mira el modo propio del dueño, para que encadenar
cuentas vencidas no sea una forma de saltarse el pago.

Además, `unirme <CÓDIGO>` es comando **regex** (no depende del agente, ni de la
cuota de IA) y está en `EXPIRED_ALLOWED_COMMANDS`: si no, el invitado no podía ni
entrar al campo que le compartieron.

## Autoría — "quién cargó esto"

**`user_id` ya es el AUTOR.** Ningún camino de escritura resuelve al dueño: si B
escribe en el campo de A, queda `user_id = B`. El dato era correcto en el 100 %
de las filas; lo que estaba mal era la lectura, que usaba la misma columna como
clave de pertenencia. Eso se arregla en `accessible-fields.ts`, no con columnas
nuevas — por eso **no** se agregaron `created_by` (los de las migraciones 112-115
valen siempre lo mismo que `user_id` y no los lee nadie).

Dos excepciones, en la migración 124:

- **`harvest_loads.created_by`**: la tabla no tiene `user_id` (cuelga de
  `domain_event_id`) y el dedup de cosecha **anexa** camiones al evento del mismo
  día y lote, así que los camiones que carga el socio se le atribuían al dueño.
- **`plot_crops` NO lleva columna**: el actor de una siembra es su
  `domain_events` de tipo siembra. Una columna paralela sería una segunda fuente
  de verdad del mismo hecho.

La regla quedó escrita en `COMMENT ON COLUMN` sobre `expenses`, `incomes`,
`domain_events`, `agro_observations`, `crop_scoutings` y `rainfall`.

En la UI, `RegisteredBy.tsx` muestra el autor **solo cuando es otro usuario**: en
un campo propio todas las filas son tuyas y repetir tu nombre en cada tarjeta es
ruido puro.

## API

Todo bajo `/api/auth` (`src/routes/sharing.routes.ts`).

| Método | Ruta | Gate |
|---|---|---|
| GET | `/sharing/overview` | `sharing` |
| POST | `/sharing/fields/:fieldId/invites` `{phone}` | `sharing` + dueño |
| DELETE | `/sharing/invites/:inviteId` | `sharing` + dueño |
| DELETE | `/sharing/fields/:fieldId/members/:memberId` | solo auth |
| POST | `/sharing/join` `{code}` | solo auth |

Dos rutas **sin** `requireFeature`, a propósito:

- **salir de un campo**: si el dueño baja de plan, el miembro tiene que poder
  irse igual — quedar atrapado en un campo ajeno no es un estado válido;
- **`/join`**: paridad con `accept_invite`, desgateado desde siempre. El que paga
  la función de compartir es el dueño, no el invitado.

## Dónde vive cada regresión

| Archivo | Cubre |
|---|---|
| `src/utils/__tests__/phone.test.ts` | Casos canónicos + **paridad JS ↔ SQL** |
| `src/domain/users/__tests__/phone-lookup.integration.test.ts` | El bug de identidad: formato legacy encontrado con lo que manda Meta |
| `src/scripts/__tests__/merge-duplicate-phone-users.test.ts` | Planificador de fusión (sin DB) |
| `src/domain/sharing/__tests__/sharing.integration.test.ts` | Invitación atada al número, revocación, reenvío, vencimiento, permisos |
| `src/domain/sharing/__tests__/invite-link.test.ts` | Link con y sin setting; mismo código en link y mensaje |
| `src/routes/__tests__/sharing.routes.test.ts` | Contrato HTTP: gate de plan, 400 con motivo, salir sin gate |
| `src/services/__tests__/access-gate.test.ts` | Herencia del acceso del dueño |
| `src/services/__tests__/overview.integration.test.ts` | Los 3 bugs de scoping del Resumen |
| `pipeline.integration.test.ts` § "campos compartidos" | Flujo completo por el bot, con pending de teléfono |
