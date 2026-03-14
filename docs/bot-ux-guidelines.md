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

## Interactive Buttons

After saving data, send follow-up buttons via `suggestionKey`:
- `observation_logged` -> Registrar Actividad, Reporte Agro, Menu
- `activity_logged` -> Otra Actividad, Reporte Agro, Menu
- `expense_saved` -> Otro Gasto, Resumen Mes, Menu
- `income_saved` -> Otro Ingreso, Resultado Mes, Menu

## Tone

- Concise, friendly, professional
- Use "vos" form (podes, queres, escribi)
- No exclamation marks unless celebrating (cosecha, buen resultado)
- Errors: empathetic but direct ("No pude encontrar...")
