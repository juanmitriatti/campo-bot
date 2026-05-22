/**
 * Seed curated AI training examples for few-shot learning.
 * Run: npx tsx src/scripts/seed-training-examples.ts
 */

import { pool } from '../config/db.js';

interface Example {
  input: string;
  expected_output: Record<string, unknown>;
  intent: string;
}

const EXAMPLES: Example[] = [
  // --- Expenses ---
  {
    input: 'gasté 50000 en herbicida para lote norte',
    expected_output: { intent: 'log_expense', confidence: 0.95, amount: 50000, category: 'herbicida', description: 'herbicida', currency: 'ARS', plot: 'norte' },
    intent: 'log_expense',
  },
  {
    input: 'compré semilla de soja por 200 dólares',
    expected_output: { intent: 'log_expense', confidence: 0.95, amount: 200, category: 'semillas', description: 'semilla de soja', currency: 'USD' },
    intent: 'log_expense',
  },
  // --- Incomes ---
  {
    input: 'vendí 30 toneladas de trigo a 180 usd la tonelada',
    expected_output: { intent: 'log_income', confidence: 0.95, amount: 5400, category: 'venta_granos', description: 'trigo', currency: 'USD', quantity: 30, unit: 'toneladas', unit_price: 180 },
    intent: 'log_income',
  },
  {
    input: 'cobré 500mil por el servicio de fumigación',
    expected_output: { intent: 'log_income', confidence: 0.92, amount: 500000, category: 'servicios', description: 'servicio de fumigación', currency: 'ARS' },
    intent: 'log_income',
  },
  // --- Activities ---
  {
    input: 'fumigué con glifosato el lote 5 del campo san martin',
    expected_output: { intent: 'log_spraying', confidence: 0.95, product: 'glifosato', product_type: 'herbicida', plot: 'lote 5', field: 'san martin' },
    intent: 'log_spraying',
  },
  {
    input: 'fertilicé con urea 100kg/ha en lote sur',
    expected_output: { intent: 'log_fertilization', confidence: 0.95, product: 'urea', quantity: 100, unit: 'kg/ha', plot: 'sur' },
    intent: 'log_fertilization',
  },
  {
    input: 'sembré soja en el lote 3',
    expected_output: { intent: 'sow_crop', confidence: 0.95, crop: 'soja', plot: 'lote 3' },
    intent: 'sow_crop',
  },
  {
    input: 'cosechamos maíz hoy, rindió 8500 kg/ha',
    expected_output: { intent: 'harvest_crop', confidence: 0.93, crop: 'maíz', quantity: 8500, unit: 'kg/ha' },
    intent: 'harvest_crop',
  },
  {
    input: 'pasé la rastra en el lote norte',
    expected_output: { intent: 'log_tillage', confidence: 0.92, product: 'rastra', plot: 'norte' },
    intent: 'log_tillage',
  },
  // --- Tacto (pregnancy check) ---
  {
    input: 'hice tacto en el lote 3, revisé 80 vacas, 60 preñadas y 20 vacías',
    expected_output: { intent: 'log_tacto', confidence: 0.95, total_checked: 80, pregnant_count: 60, open_count: 20, category: 'vaca', plot: 'lote 3' },
    intent: 'log_tacto',
  },
  {
    input: 'se hizo tacto y dio 135 preñadas y 6 vacías',
    expected_output: { intent: 'log_tacto', confidence: 0.95, pregnant_count: 135, open_count: 6 },
    intent: 'log_tacto',
  },
  // --- Observations ---
  {
    input: 'observación: vi presencia de oruga militar en lote 2',
    expected_output: { intent: 'log_observation', confidence: 0.98, text: 'presencia de oruga militar', category: 'plaga', plot: 'lote 2' },
    intent: 'log_observation',
  },
  // --- Rainfall ---
  {
    input: 'cayeron 25mm ayer en campo la esperanza',
    expected_output: { intent: 'log_rainfall', confidence: 0.95, amount: 25, field: 'la esperanza' },
    intent: 'log_rainfall',
  },
  // --- Weather ---
  {
    input: 'cómo va a estar el clima esta semana?',
    expected_output: { intent: 'weather_full', confidence: 0.95 },
    intent: 'weather_full',
  },
  // --- Reports ---
  {
    input: 'mostrame el reporte financiero del campo norte',
    expected_output: { intent: 'financial_report', confidence: 0.93, field: 'norte' },
    intent: 'financial_report',
  },
  {
    input: 'cuánto gasté en el lote 5?',
    expected_output: { intent: 'financial_report', confidence: 0.92, plot: 'lote 5' },
    intent: 'financial_report',
  },
  // --- Query history ---
  {
    input: 'cuándo fue la última fumigación en lote sur?',
    expected_output: { intent: 'query_plot_history', confidence: 0.93, activityFilter: 'log_spraying', plot: 'sur' },
    intent: 'query_plot_history',
  },
  // --- Rainfall report ---
  {
    input: 'cuánto llovió este mes?',
    expected_output: { intent: 'rainfall_report', confidence: 0.94 },
    intent: 'rainfall_report',
  },
  // --- Monthly report ---
  {
    input: 'reporte mensual',
    expected_output: { intent: 'financial_report', confidence: 0.95 },
    intent: 'financial_report',
  },
  // --- Greeting ---
  {
    input: 'hola buen día',
    expected_output: { intent: 'greeting', confidence: 0.99 },
    intent: 'greeting',
  },
  // --- Plot management ---
  {
    input: 'agregar lote "este" en campo la esperanza',
    expected_output: { intent: 'add_plot', confidence: 0.95, plotName: 'este', field: 'la esperanza' },
    intent: 'add_plot',
  },

  // ─── Compound actions (multi-tool) ─────────────────────────────────────────
  // Teach the agent that one user turn can fire N tool calls. Without these
  // demonstrations Haiku copies the single-tool pattern and silently drops
  // the second/third action of a compound message.

  // 2× log_income (granos diferentes)
  {
    input: 'vendí 25 toneladas de maíz a 900 dólares y 10 toneladas de soja a 1000 dólares',
    expected_output: {
      tool_calls: [
        { tool: 'log_income', input: { category: 'Maíz', quantity: 25, unit: 'tn', unit_price: 900, currency: 'USD', description: 'venta maíz' } },
        { tool: 'log_income', input: { category: 'Soja', quantity: 10, unit: 'tn', unit_price: 1000, currency: 'USD', description: 'venta soja' } },
      ],
    },
    intent: 'log_income,log_income',
  },

  // 2× log_income — uno con precio + uno sin precio (compound parcial)
  // Esta demo es CRÍTICA: enseña al agente a NO dropear el ítem sin precio
  // y a NO atribuir el precio del segundo ítem al primero.
  {
    input: 'vendí 5 toneladas de soja y 1 tonelada de maíz a 400 dólares',
    expected_output: {
      tool_calls: [
        { tool: 'log_income', input: { category: 'Soja', quantity: 5, unit: 'tn', currency: 'USD', description: 'venta soja' } },
        { tool: 'log_income', input: { category: 'Maíz', quantity: 1, unit: 'tn', unit_price: 400, currency: 'USD', description: 'venta maíz' } },
      ],
    },
    intent: 'log_income,log_income',
  },

  // 2× log_expense (insumos diferentes)
  {
    input: 'compré 20 bolsas de urea a 8000 cada una y 100 litros de glifosato a 950 el litro',
    expected_output: {
      tool_calls: [
        { tool: 'log_expense', input: { category: 'fertilizantes', expense_type: 'insumo', product: 'urea', quantity: 20, unit: 'bolsas', unit_price: 8000, amount: 160000, currency: 'ARS', description: 'urea' } },
        { tool: 'log_expense', input: { category: 'agroquimicos', expense_type: 'insumo', product: 'glifosato', quantity: 100, unit: 'lt', unit_price: 950, amount: 95000, currency: 'ARS', description: 'glifosato' } },
      ],
    },
    intent: 'log_expense,log_expense',
  },

  // 2× sow_crop (lotes diferentes)
  {
    input: 'sembré soja en el lote A1 y maíz en el lote B2',
    expected_output: {
      tool_calls: [
        { tool: 'sow_crop', input: { crop: 'soja', plot: 'A1' } },
        { tool: 'sow_crop', input: { crop: 'maíz', plot: 'B2' } },
      ],
    },
    intent: 'sow_crop,sow_crop',
  },

  // 2× harvest_crop (cosechas con rinde)
  {
    input: 'cosechamos soja en A1 con 4000 kg por hectárea y maíz en B2 con 8500 kg/ha',
    expected_output: {
      tool_calls: [
        { tool: 'harvest_crop', input: { crop: 'soja', plot: 'A1', yield_kg_per_ha: 4000 } },
        { tool: 'harvest_crop', input: { crop: 'maíz', plot: 'B2', yield_kg_per_ha: 8500 } },
      ],
    },
    intent: 'harvest_crop,harvest_crop',
  },

  // sow_crop + log_expense (actividad + costo asociado)
  {
    input: 'sembré soja en el lote norte y la semilla costó 500 mil pesos',
    expected_output: {
      tool_calls: [
        { tool: 'sow_crop', input: { crop: 'soja', plot: 'norte' } },
        { tool: 'log_expense', input: { category: 'semillas', expense_type: 'insumo', product: 'semilla soja', amount: 500000, currency: 'ARS', description: 'semilla soja', plot: 'norte' } },
      ],
    },
    intent: 'sow_crop,log_expense',
  },

  // log_spraying + log_fertilization (dos actividades agronómicas en distintos lotes)
  {
    input: 'fumigué el lote A1 con glifosato y fertilicé el B2 con urea',
    expected_output: {
      tool_calls: [
        { tool: 'log_spraying', input: { product: 'glifosato', product_type: 'herbicida', plot: 'A1' } },
        { tool: 'log_fertilization', input: { product: 'urea', plot: 'B2' } },
      ],
    },
    intent: 'log_spraying,log_fertilization',
  },

  // add_field + add_plot + sow_crop (creación + actividad, 3 tools)
  {
    input: 'agregá el campo La Esperanza en Pergamino, lote A de 50 hectáreas y sembré soja en A',
    expected_output: {
      tool_calls: [
        { tool: 'add_field', input: { name: 'La Esperanza', city: 'Pergamino' } },
        { tool: 'add_plot', input: { plotName: 'A', hectares: 50, field: 'La Esperanza' } },
        { tool: 'sow_crop', input: { crop: 'soja', plot: 'A', field: 'La Esperanza' } },
      ],
    },
    intent: 'add_field,add_plot,sow_crop',
  },

  // 2× add_livestock (categorías de hacienda diferentes)
  {
    input: 'ingresaron 50 vacas y 20 novillos al feedlot principal',
    expected_output: {
      tool_calls: [
        { tool: 'add_livestock', input: { category: 'vaca', count: 50, location_type: 'feedlot', location_name: 'principal' } },
        { tool: 'add_livestock', input: { category: 'novillo', count: 20, location_type: 'feedlot', location_name: 'principal' } },
      ],
    },
    intent: 'add_livestock,add_livestock',
  },

  // Multi-rainfall (varios días en un mensaje)
  {
    input: 'llovió 20mm el lunes, 35mm el martes y 12mm el miércoles en La Esperanza',
    expected_output: {
      tool_calls: [
        { tool: 'log_rainfall', input: { amount: 20, field: 'La Esperanza', event_date_relative: 'lunes' } },
        { tool: 'log_rainfall', input: { amount: 35, field: 'La Esperanza', event_date_relative: 'martes' } },
        { tool: 'log_rainfall', input: { amount: 12, field: 'La Esperanza', event_date_relative: 'miércoles' } },
      ],
    },
    intent: 'log_rainfall,log_rainfall,log_rainfall',
  },
];

async function seed() {
  console.log(`Seeding ${EXAMPLES.length} training examples...`);

  for (const ex of EXAMPLES) {
    // Upsert: skip if same input already exists
    const existing = await pool.query(
      `SELECT id FROM ai_training_examples WHERE input = $1`,
      [ex.input],
    );
    if (existing.rows.length > 0) {
      console.log(`  SKIP (exists): "${ex.input.slice(0, 50)}..."`);
      continue;
    }

    await pool.query(
      `INSERT INTO ai_training_examples (input, expected_output, intent, is_active, source)
       VALUES ($1, $2, $3, true, 'manual')`,
      [ex.input, JSON.stringify(ex.expected_output), ex.intent],
    );
    console.log(`  ADDED: [${ex.intent}] "${ex.input.slice(0, 50)}"`);
  }

  console.log('Done.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
