# Bot UX Guidelines

Style guide for WhatsApp message formatting in campo-bot.

## General Rules

- **Language**: Argentine Spanish (vos, voseo, local slang)
- **Max length**: ~1000 characters per message (WhatsApp preview cutoff)
- **Bold**: Use `*text*` for emphasis on key data (amounts, names, labels)
- **Emoji**: One per line prefix, never stacked. Use as visual anchors.
- **Blank lines**: Separate logical sections with one blank line
- **No markdown links**: WhatsApp doesn't render them

## Message Structure

Every response follows this pattern:

1. **Confirmation** — What was done (emoji + bold action)
2. **Data** — Location, category, details
3. **Recommendation** (optional) — Contextual advice
4. **Suggestions** — Next actions (text hints or interactive buttons)

## Observation Response

```
[emoji] Observacion registrada

[location]
[category with emoji]
[observation text]

[recommendation if applicable]

Podes registrar ahora:
* [contextual suggestion 1]
* [contextual suggestion 2]
```

### Category Labels

| Category   | Label            |
|------------|------------------|
| sanidad    | Bug Sanidad      |
| malezas    | Herb Malezas     |
| nutricion  | Lab Nutricion    |
| fenologia  | Seedling Fenologia |
| clima      | Storm Clima      |
| general    | Memo General     |

### Category Recommendations

| Category   | Recommendation                                              |
|------------|-------------------------------------------------------------|
| sanidad    | Monitorear en los proximos dias para evaluar avance.        |
| malezas    | Evaluar aplicacion de herbicida segun estado de las malezas.|
| nutricion  | Considerar analisis foliar para confirmar deficiencia.      |
| fenologia  | Registrar proximo cambio de estado para seguimiento.        |
| clima      | Revisar pronostico y evaluar medidas preventivas.           |
| general    | (none)                                                      |

### Contextual Suggestions

| Category          | Suggestions                          |
|-------------------|--------------------------------------|
| sanidad / malezas | fumigacion [lote], otra observacion  |
| nutricion         | fertilizacion [lote], otra observacion|
| others            | otra observacion [lote]              |

## Agro Report Response

```
[clipboard] *Reporte Agronomico*
Campo: [name] -- Semana [N]

[chart] Observaciones: [count]

*Detalle por lote*

[seedling] [plot name]
* [observation 1]
* [observation 2]

*Actividad reciente*
* [label]: [detail] ([plot])
```

- Cap: 5 plots, 5 activities
- Hide empty sections entirely

## Activity Confirmation

```
[emoji] *[Activity]* registrada
[pin] [location]
[bottle] [product] ([type])
[ruler] [quantity] [unit]
[seedling] Cultivo: [crop]
[calendar] [date]
```

Only show lines with available data.

## Financial Confirmation

```
[emoji] [type] registrado
[pin] [location]
[category]
[amount with currency]
[description]
```

## Interactive Buttons ("¿Y ahora?")

After a completed action the handler sets `suggestionKey` (or the pipeline maps it from the command). The catalog lives in `src/middleware/contextual-suggestions.ts` — **it is the only source**; this doc does not list the ternas because they drifted before.

Rules (Sep 2026, see `docs/history`):
- Every button id has a route in `CALLBACK_MAP`; titles are ≤ 20 UTF-16 units (WhatsApp rejects the whole message otherwise); a `help_*` button says "Ejemplos". `validateCatalog()` + `contextual-suggestions.test.ts` enforce this.
- Buttons are filtered by plan (`BUTTON_FEATURE` → `FeatureGate`) before sending; nothing is sent if none survive.
- One appendix per response: an open question suppresses the suggestion; a form offer wins over it.
- A destructive button (`↩️ Borrar último`) asks the same confirmation as the text path — old keyboards stay tappable forever.
- No fallback menu: an unmapped command shows nothing.
- Admin settings (grupo bot, no deploy): `SUGGESTIONS_ENABLED`, `SUGGESTIONS_MAX_PER_DAY`, `SUGGESTIONS_DISABLED_KEYS`, `SUGGESTIONS_OVERRIDES` (JSON, validated).
- Every send and every tap is a row in `suggestion_events` (migration 117). Measure before redesigning.

## Tone

- Concise, friendly, professional
- Use "vos" form (podes, queres, escribi)
- No exclamation marks unless celebrating (cosecha, buen resultado)
- Errors: empathetic but direct ("No pude encontrar...")
