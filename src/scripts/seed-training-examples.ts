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
    expected_output: { intent: 'field_report', confidence: 0.93, field: 'norte' },
    intent: 'field_report',
  },
  {
    input: 'cuánto gasté en el lote 5?',
    expected_output: { intent: 'plot_report', confidence: 0.92, plot: 'lote 5' },
    intent: 'plot_report',
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
    expected_output: { intent: 'monthly_report', confidence: 0.95 },
    intent: 'monthly_report',
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
