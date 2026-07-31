# Runbook — Piloto con productores reales

Objetivo: 10-20 productores reales usando campo-bot 4 semanas, para decidir con datos
qué construir después (recomendaciones agronómicas / inteligencia financiera / otra cosa).

## Antes de invitar a nadie (bloqueantes)

- [ ] **Sentry activo**: setear `SENTRY_DSN` en Railway (el SDK ya está integrado).
      Verificar: forzar un error y verlo llegar al proyecto de Sentry.
- [ ] **Casilla de soporte real**: reemplazar `SUPPORT_CONTACT` (hoy apunta a duvips.com
      temporal) en admin → Settings → system.
- [ ] **Flip de alertas**: admin → Settings → bot → `PROACTIVE_ALERTS_ENABLED = true`.
      (El deploy sale con `false`; las alertas quedan dark hasta este flip. Cada usuario
      puede apagarlas con "no más alertas".)
- [ ] **Guía lista**: `docs/guia-productor-campo-bot.pdf` generada y revisada.
- [ ] Deploy verde: `curl https://campo-bot-production.up.railway.app/api/health`.

## Selección e invitación

- Perfil: productor mixto o agrícola de zona núcleo, que use WhatsApp/Telegram a diario.
  Ideal 3-4 conocidos directos (feedback brutal) + el resto por referidos.
- Canal: Telegram (WhatsApp todavía no está en prod).
- Mensaje de invitación (adaptar):

> Hola [nombre]! Estoy lanzando campo-bot, un asistente para llevar el campo por chat:
> le escribís "gasté 500 mil en gasoil" o "sembré soja en el lote norte" y él registra
> todo y te arma los números. Te doy acceso completo gratis por ser de los primeros —
> lo único que pido es que lo uses de verdad 2-3 semanas y me digas qué le falta.
> Te paso la guía en PDF y el link para arrancar: [PUBLIC_URL/register]

- Alta: registro en la web → vincular Telegram desde "Mi cuenta" (deep-link) → primer
  mensaje sugerido: que carguen su campo con la frase de la guía ("Tengo el campo X en...").

## Ritual semanal (20-30 min, lunes)

1. **Logs sospechosos**: `/admin → AI Training → Logs → filtro "⚠️ Sospechosas"` →
   marcar OK/Mal en bulk → "Promover" los casos que merezcan training example.
2. **Actividad** (psql prod):
   ```sql
   SELECT u.id, u.name, count(cl.id) AS msgs_7d, max(cl.created_at)::date AS ultimo
     FROM users u LEFT JOIN conversation_logs cl
       ON cl.user_id = u.id AND cl.created_at > now() - interval '7 days'
    WHERE u.deleted_at IS NULL AND u.phone_number NOT LIKE 'testbot%'
    GROUP BY u.id, u.name ORDER BY msgs_7d DESC;
   ```
3. **Silencios**: usuario del piloto con 0 mensajes en 7 días → mensaje personal
   ("¿te trabó algo?") — en piloto, el churn es feedback, no ruido.
4. **Errores**: bandeja de Sentry + `railway logs --deployment | grep -i "error\|INTERCEPT"`.
5. **Opt-outs de alertas**:
   ```sql
   SELECT count(*) FROM user_settings WHERE alerts_enabled = FALSE;
   ```
   Si más del 30% de los activos apagó las alertas en la semana 1, revisar frecuencia/tono
   antes de seguir sumando gente.

## Métricas de éxito (evaluar en semana 4)

| Métrica | Verde | Amarillo | Rojo |
|---|---|---|---|
| Activación (cargó campo + 1 registro en día 1) | ≥ 70% | 40-70% | < 40% |
| Retención semana 2 (≥ 1 mensaje) | ≥ 50% | 30-50% | < 30% |
| Dominios usados por usuario activo | ≥ 3 | 2 | 1 |
| Usuarios que pedirían una feature concreta | ≥ 5 | 2-4 | 0-1 |

## Decisión post-piloto

- **Verde** → abrir registro público + retomar backlog priorizado por lo que pidieron
  (candidatos ya identificados: recomendaciones agronómicas asistidas, inteligencia
  financiera de tendencias — ver análisis de feedback Jul 2026).
- **Amarillo** → segunda cohorte con los fixes de fricción encontrados; no abrir público.
- **Rojo** → entrevistas 1:1 con los que abandonaron antes de escribir una línea más de código.

## Registro de feedback

Cada pedido/queja de un productor → issue en GitHub con label `piloto` + quién lo pidió.
La prioridad post-piloto se decide contando quiénes pidieron qué, no por intuición.

## Configuración relevante (admin → Settings → bot)

| Setting | Default | Qué hace |
|---|---|---|
| `PROACTIVE_ALERTS_ENABLED` | false | Kill switch de todas las alertas proactivas |
| `MONTHLY_INSIGHTS_ENABLED` | true | Bloque "📈 Tendencias" en el resumen mensual |
| `MONTHLY_INSIGHTS_MIN_PCT` | 15 | Variación mínima (%) para listar una categoría |
| `TIPS_ENABLED` / `TIPS_MAX_PER_DAY` | true / 1 | Tips de descubrimiento |
