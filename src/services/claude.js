import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { getSetting, getSettingNumber, getSettingBool } from "./settings.service.js";
import { logError } from "./error-logger.js";

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

export async function analyzeMessage(text) {
  const [fallbackEnabled, model, maxTokens] = await Promise.all([
    getSettingBool('CLAUDE_FALLBACK_ENABLED'),
    getSetting('CLAUDE_FALLBACK_MODEL'),
    getSettingNumber('CLAUDE_FALLBACK_MAX_TOKENS'),
  ]);

  if (fallbackEnabled === false) {
    return { data: { type: "unknown" }, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  let response;
  try {
    response = await anthropic.messages.create({
      model: model || "claude-haiku-4-5-20251001",
      max_tokens: maxTokens || 250,
    temperature: 0,
    system: `Sos un asistente de gestión agrícola argentina. Extraé datos financieros o de actividades del mensaje. Respondé SOLO JSON, sin texto adicional.

GASTO: {"type":"expense","category":"X","amount":N,"description":"X","field":null}
Categorías gasto: Combustible,Fertilizantes,Semillas,Agroquímicos,Sueldos,Maquinaria,Arrendamiento,Impuestos,Otros.

INGRESO/VENTA: {"type":"income","category":"X","amount":N,"description":"X","field":null,"quantity":null,"unit":null,"unit_price":null}
Categorías ingreso: Soja,Maíz,Trigo,Girasol,Sorgo,Cebada,Hacienda,Arrendamiento,Otros.
Si dice "vendí 30 tn de soja a 250 USD", amount=30*250=7500, quantity=30, unit="tn", unit_price=250, currency="USD".

ACTIVIDAD AGRÍCOLA: {"type":"activity","task":"spraying|fertilization|tillage|irrigation","product":"X","product_type":"herbicida|insecticida|fungicida|fertilizante","quantity":N,"unit":"kg|lt|cc|bolsas|tn","crop":"X","field":null,"plot":null}
Detectar aplicación de agroquímicos, fertilización, labranza, riego.
Verbos: aplicar, tirar, echar, fumigar, pulverizar, curar, fertilizar, abonar, arar, pasar cincel/rastra/disco, regar, irrigar.
Si dice "lote X" → extraer en "plot". Si dice "campo X" → extraer en "field".

Moneda: si dice dólares/USD → currency:"USD", sino → currency:"ARS".
lucas=miles, mil=1000, palos/millones=1000000. Cantidad x precio = total.
Si menciona "campo X" o "parcela X", extraé en "field". Si menciona "lote X", extraé en "plot".

COMANDO: {"type":"command","command":"X","field":null,"city":null}
Comandos válidos: list_fields, add_field, field_info, set_field_city, help, weather_full, monthly_report, weekly_report.
"info de mis lotes" → {"type":"command","command":"list_fields"}
"agregar campo X" → {"type":"command","command":"add_field","field":"X"}
"campo X esta en Y" → {"type":"command","command":"set_field_city","field":"X","city":"Y"}
"mostrame mis campos" → {"type":"command","command":"list_fields"}

No entendido: {"type":"unknown"}`,
    messages: [{ role: "user", content: text }]
    });
  } catch (apiErr) {
    logError('claude', 'API_ERROR', apiErr, {
      context: { action: 'analyzeMessage', model: model || 'claude-haiku-4-5-20251001' },
    });
    throw apiErr;
  }

  let data = null;
  try {
    // Extract JSON even if Claude adds extra text
    const rawText = response.content[0].text;
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      data = JSON.parse(jsonMatch[0]);
    } else {
      data = { type: "unknown" };
    }
  } catch (e) {
    console.error("PARSE ERROR:", response.content[0].text);
    logError('claude', 'PARSE_ERROR', e, {
      context: { rawResponse: response.content[0].text.slice(0, 200) },
    });
    data = { type: "unknown" };
  }

  console.log("CLAUDE:", data, "TOKENS:", response.usage.input_tokens, "in /", response.usage.output_tokens, "out");

  return {
    data,
    usage: response.usage
  };
}
