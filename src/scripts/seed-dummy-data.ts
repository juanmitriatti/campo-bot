#!/usr/bin/env tsx
/**
 * Seed realistic dummy data for QA testing.
 *
 * Usage:
 *   npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]
 *
 *   --user-id: target user ID (required)
 *   --reset:   clear existing data first (same logic as test-bot reset)
 *
 * Creates a realistic Southern Santa Fe farm structure with 3-4 months of
 * backdated data (expenses, incomes, rainfall, activities, observations).
 *
 * Requires DATABASE_URL env var (or .env file).
 */

import dotenv from 'dotenv';
import { pool } from '../config/db.js';
import type { PoolClient } from 'pg';

dotenv.config();

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(): { userId: number; reset: boolean } {
  const args = process.argv.slice(2);
  const map = new Map<string, string>();
  let reset = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--reset') {
      reset = true;
      continue;
    }
    const key = args[i]?.replace(/^--/, '');
    const val = args[i + 1];
    if (key && val && !val.startsWith('--')) {
      map.set(key, val);
      i++;
    }
  }

  const userId = parseInt(map.get('user-id') || '', 10);
  if (!userId || isNaN(userId)) {
    console.error('Usage: npx tsx src/scripts/seed-dummy-data.ts --user-id <id> [--reset]');
    process.exit(1);
  }

  return { userId, reset };
}

// ---------------------------------------------------------------------------
// Reset (mirrors test-bot /reset endpoint)
// ---------------------------------------------------------------------------

async function resetUserData(client: PoolClient, userId: number): Promise<void> {
  console.log(`  Resetting all data for user ${userId}...`);

  // Layer 1: FK to agro_observations + harvest_loads (FK to domain_events) + stock_movements (FK to domain_events)
  await client.query(
    `DELETE FROM observation_history WHERE observation_id IN (SELECT id FROM agro_observations WHERE user_id = $1)`,
    [userId],
  );
  await client.query(
    `DELETE FROM harvest_loads WHERE domain_event_id IN (SELECT id FROM domain_events WHERE user_id = $1)`,
    [userId],
  );
  await client.query(`DELETE FROM stock_movements WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM stock_items WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM warehouses WHERE field_id IN (SELECT id FROM fields WHERE user_id = $1)`, [userId]);

  // Livestock movements + groups (movements have FK to groups so order matters)
  await client.query(`DELETE FROM livestock_movements WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM livestock_groups WHERE user_id = $1`, [userId]);

  // Layer 2: tables with FK to fields/plots
  await client.query(`DELETE FROM crop_scoutings WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM alert_history WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM agronomic_reports WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM documents WHERE user_id = $1`, [userId]).catch(() => {});
  await client.query(`DELETE FROM domain_events WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM agro_observations WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM expenses WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM incomes WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM rainfall WHERE user_id = $1`, [userId]);
  await client.query(`DELETE FROM expense_templates WHERE user_id = $1`, [userId]).catch(() => {});

  // Layer 3: conversation state
  await client.query(`DELETE FROM conversation_state WHERE user_id = $1`, [userId]);

  // Layer 4: fields (CASCADE → plots → plot_aliases, plot_crops)
  await client.query(`DELETE FROM fields WHERE user_id = $1`, [userId]);

  // Layer 5: non-FK user data
  for (const table of [
    'budgets', 'unparsed_messages', 'ai_usage', 'ai_fallback_logs',
    'conversation_events', 'conversation_logs', 'parser_errors',
    'deletion_log', 'farmer_vocabulary', 'message_patterns',
    'audio_transcription_logs',
  ]) {
    await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
  }

  console.log('  Reset complete.');
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Return 'YYYY-MM-DD' for a given year, month (1-based), day */
function d(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Return ISO timestamp for a given date + hour */
function ts(year: number, month: number, day: number, hour = 10): string {
  return `${d(year, month, day)} ${String(hour).padStart(2, '0')}:00:00`;
}

// ---------------------------------------------------------------------------
// Seed data definitions
// ---------------------------------------------------------------------------

interface FieldDef {
  name: string;
  city: string;
  plots: PlotDef[];
}

interface PlotDef {
  name: string;
  crop?: string;
  seasonYear?: number;
  seasonType?: 'gruesa' | 'fina';
  areaHa?: number;
}

const FIELDS: FieldDef[] = [
  {
    name: 'Don Pedro',
    city: 'Venado Tuerto',
    plots: [
      { name: '1A', crop: 'Soja', seasonYear: 2026, seasonType: 'gruesa', areaHa: 120 },
      { name: '1B', crop: 'Maíz', seasonYear: 2026, seasonType: 'gruesa', areaHa: 95 },
      { name: '1C', areaHa: 80 },
    ],
  },
  {
    name: 'La Esperanza',
    city: 'Rufino',
    plots: [
      { name: 'Norte', crop: 'Trigo', seasonYear: 2025, seasonType: 'fina', areaHa: 150 },
      { name: 'Sur', crop: 'Girasol', seasonYear: 2026, seasonType: 'gruesa', areaHa: 110 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Main seed logic
// ---------------------------------------------------------------------------

async function seed(client: PoolClient, userId: number): Promise<void> {
  // Track IDs
  const fieldIds: Record<string, number> = {};
  const plotIds: Record<string, number> = {};
  const cropIds: Record<string, number> = {};

  // =========================================================================
  // 1. Fields + Plots + Crops
  // =========================================================================
  console.log('\n1. Creating fields, plots, and crops...');

  for (const f of FIELDS) {
    const { rows: [field] } = await client.query(
      `INSERT INTO fields (user_id, name, city) VALUES ($1, $2, $3) RETURNING id`,
      [userId, f.name, f.city],
    );
    // Production add_field creates a field_members owner row — replicate so
    // accessibleFieldsSql() (which only checks field_members, not fields.user_id)
    // returns this field. Without this, list_fields/getFieldByName see 0 fields.
    await client.query(
      `INSERT INTO field_members (field_id, user_id, role, invited_by) VALUES ($1, $2, 'owner', $2) ON CONFLICT (field_id, user_id) DO NOTHING`,
      [field.id, userId],
    );
    fieldIds[f.name] = field.id;
    console.log(`   Campo "${f.name}" (${f.city}) → id=${field.id}`);

    for (const p of f.plots) {
      const { rows: [plot] } = await client.query(
        `INSERT INTO plots (field_id, name, area_hectares) VALUES ($1, $2, $3) RETURNING id`,
        [field.id, p.name, p.areaHa || null],
      );
      const key = `${f.name}/${p.name}`;
      plotIds[key] = plot.id;
      console.log(`     Lote "${p.name}" (${p.areaHa || '?'} ha) → id=${plot.id}`);

      if (p.crop) {
        const startDate = p.seasonType === 'fina'
          ? d(2025, 6, 15) // June for fina
          : d(2025, 11, 1); // November for gruesa
        const { rows: [pc] } = await client.query(
          `INSERT INTO plot_crops (plot_id, crop, season_year, season_type, start_date)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [plot.id, p.crop, p.seasonYear, p.seasonType, startDate],
        );
        cropIds[key] = pc.id;
        console.log(`       Cultivo: ${p.crop} (${p.seasonType} ${p.seasonYear})`);
      }
    }
  }

  // =========================================================================
  // 2. Expenses (~20 records)
  // =========================================================================
  console.log('\n2. Inserting expenses...');

  const expenses: Array<{
    category: string; description: string; amount: number; currency: string;
    plotKey: string; date: string;
  }> = [
    // Combustible
    { category: 'Combustible', description: 'Gasoil 500lt', amount: 450000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2025, 12, 5) },
    { category: 'Combustible', description: 'Gasoil 300lt', amount: 270000, currency: 'ARS', plotKey: 'Don Pedro/1B', date: d(2026, 1, 10) },
    { category: 'Combustible', description: 'Nafta camioneta', amount: 85000, currency: 'ARS', plotKey: 'La Esperanza/Norte', date: d(2026, 2, 3) },
    { category: 'Combustible', description: 'Gasoil 400lt', amount: 380000, currency: 'ARS', plotKey: 'La Esperanza/Sur', date: d(2026, 3, 8) },

    // Semillas
    { category: 'Semillas', description: 'Semilla soja DM 40R16', amount: 180, currency: 'USD', plotKey: 'Don Pedro/1A', date: d(2025, 11, 20) },
    { category: 'Semillas', description: 'Semilla maíz DK 72-10', amount: 250, currency: 'USD', plotKey: 'Don Pedro/1B', date: d(2025, 12, 1) },
    { category: 'Semillas', description: 'Semilla girasol Paraíso 20', amount: 140, currency: 'USD', plotKey: 'La Esperanza/Sur', date: d(2025, 12, 10) },

    // Agroquímicos
    { category: 'Agroquímicos', description: 'Glifosato 20lt', amount: 125000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2026, 1, 15) },
    { category: 'Agroquímicos', description: 'Cipermetrina 5lt', amount: 48000, currency: 'ARS', plotKey: 'La Esperanza/Norte', date: d(2026, 2, 8) },
    { category: 'Agroquímicos', description: 'Fungicida Opera 10lt', amount: 92000, currency: 'ARS', plotKey: 'Don Pedro/1B', date: d(2026, 2, 20) },

    // Fertilizantes
    { category: 'Fertilizantes', description: 'Urea granulada 2tn', amount: 520000, currency: 'ARS', plotKey: 'Don Pedro/1B', date: d(2026, 1, 8) },
    { category: 'Fertilizantes', description: 'Fosfato diamónico 1.5tn', amount: 680000, currency: 'ARS', plotKey: 'La Esperanza/Sur', date: d(2026, 2, 5) },

    // Sueldos
    { category: 'Sueldos', description: 'Peón mensual diciembre', amount: 350000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2025, 12, 28) },
    { category: 'Sueldos', description: 'Peón mensual enero', amount: 350000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2026, 1, 28) },
    { category: 'Sueldos', description: 'Peón mensual febrero', amount: 380000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2026, 2, 28) },
    { category: 'Sueldos', description: 'Peón mensual marzo', amount: 380000, currency: 'ARS', plotKey: 'Don Pedro/1A', date: d(2026, 3, 15) },

    // Maquinaria
    { category: 'Maquinaria', description: 'Repuesto bomba hidráulica', amount: 195000, currency: 'ARS', plotKey: 'Don Pedro/1C', date: d(2026, 1, 22) },
    { category: 'Maquinaria', description: 'Service tractor', amount: 280000, currency: 'ARS', plotKey: 'La Esperanza/Norte', date: d(2026, 3, 5) },

    // Arrendamiento
    { category: 'Arrendamiento', description: 'Alquiler campo trimestral', amount: 8500, currency: 'USD', plotKey: 'La Esperanza/Norte', date: d(2026, 3, 1) },

    // Otros (flete)
    { category: 'Otros', description: 'Flete cosecha trigo 120tn', amount: 420000, currency: 'ARS', plotKey: 'La Esperanza/Norte', date: d(2026, 2, 25) },
  ];

  let expCount = 0;
  for (const e of expenses) {
    const plotId = plotIds[e.plotKey];
    const fieldKey = e.plotKey.split('/')[0];
    const fieldId = fieldIds[fieldKey];
    await client.query(
      `INSERT INTO expenses (user_id, category, description, amount, currency, field_id, plot_id, expense_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [userId, e.category, e.description, e.amount, e.currency, fieldId, plotId, e.date, ts(
        parseInt(e.date.slice(0, 4)), parseInt(e.date.slice(5, 7)), parseInt(e.date.slice(8, 10))
      )],
    );
    expCount++;
  }
  console.log(`   ${expCount} expenses inserted.`);

  // =========================================================================
  // 3. Incomes (~8 records)
  // =========================================================================
  console.log('\n3. Inserting incomes...');

  const incomes: Array<{
    category: string; description: string; amount: number; currency: string;
    quantity?: number; unit?: string; unitPrice?: number;
    plotKey: string; date: string;
  }> = [
    // Trigo harvest sale
    { category: 'Trigo', description: 'Venta trigo campaña 24/25', amount: 26400, currency: 'USD', quantity: 120, unit: 'tn', unitPrice: 220, plotKey: 'La Esperanza/Norte', date: d(2026, 2, 15) },
    // Soja partial sale
    { category: 'Soja', description: 'Venta parcial soja', amount: 15000, currency: 'USD', quantity: 50, unit: 'tn', unitPrice: 300, plotKey: 'Don Pedro/1A', date: d(2026, 3, 10) },
    // Girasol sale
    { category: 'Girasol', description: 'Venta girasol', amount: 10500, currency: 'USD', quantity: 30, unit: 'tn', unitPrice: 350, plotKey: 'La Esperanza/Sur', date: d(2026, 3, 18) },
    // Sublease income
    { category: 'Arrendamiento', description: 'Subarriendo potrero', amount: 850000, currency: 'ARS', plotKey: 'Don Pedro/1C', date: d(2026, 1, 5) },
    // Second trigo sale (different buyer)
    { category: 'Trigo', description: 'Venta trigo remanente', amount: 5500, currency: 'USD', quantity: 25, unit: 'tn', unitPrice: 220, plotKey: 'La Esperanza/Norte', date: d(2026, 3, 1) },
    // Maíz early sale
    { category: 'Maíz', description: 'Venta maíz forward', amount: 9600, currency: 'USD', quantity: 60, unit: 'tn', unitPrice: 160, plotKey: 'Don Pedro/1B', date: d(2026, 3, 20) },
    // Hacienda income
    { category: 'Hacienda', description: 'Venta 10 novillos', amount: 2500000, currency: 'ARS', quantity: 10, unit: 'cab', unitPrice: 250000, plotKey: 'Don Pedro/1C', date: d(2026, 1, 20) },
    // Another soja sale
    { category: 'Soja', description: 'Venta soja pizarra', amount: 9300, currency: 'USD', quantity: 30, unit: 'tn', unitPrice: 310, plotKey: 'Don Pedro/1A', date: d(2026, 3, 25) },
  ];

  let incCount = 0;
  for (const i of incomes) {
    const plotId = plotIds[i.plotKey];
    const fieldKey = i.plotKey.split('/')[0];
    const fieldId = fieldIds[fieldKey];
    await client.query(
      `INSERT INTO incomes (user_id, category, description, amount, currency, quantity, unit, unit_price, field_id, plot_id, income_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, i.category, i.description, i.amount, i.currency,
        i.quantity || null, i.unit || null, i.unitPrice || null,
        fieldId, plotId, i.date, ts(
          parseInt(i.date.slice(0, 4)), parseInt(i.date.slice(5, 7)), parseInt(i.date.slice(8, 10))
        )],
    );
    incCount++;
  }
  console.log(`   ${incCount} incomes inserted.`);

  // =========================================================================
  // 4. Rainfall (~25 records, per campo)
  // =========================================================================
  console.log('\n4. Inserting rainfall...');

  // Realistic Pampa Húmeda rainfall pattern
  const rainfallData: Array<{ fieldName: string; mm: number; date: string }> = [
    // Don Pedro — December (summer storms: ~110mm total)
    { fieldName: 'Don Pedro', mm: 35, date: d(2025, 12, 3) },
    { fieldName: 'Don Pedro', mm: 8, date: d(2025, 12, 10) },
    { fieldName: 'Don Pedro', mm: 22, date: d(2025, 12, 15) },
    { fieldName: 'Don Pedro', mm: 45, date: d(2025, 12, 23) },
    // Don Pedro — January (~85mm)
    { fieldName: 'Don Pedro', mm: 18, date: d(2026, 1, 4) },
    { fieldName: 'Don Pedro', mm: 30, date: d(2026, 1, 12) },
    { fieldName: 'Don Pedro', mm: 12, date: d(2026, 1, 20) },
    { fieldName: 'Don Pedro', mm: 25, date: d(2026, 1, 28) },
    // Don Pedro — February (~75mm)
    { fieldName: 'Don Pedro', mm: 15, date: d(2026, 2, 5) },
    { fieldName: 'Don Pedro', mm: 40, date: d(2026, 2, 14) },
    { fieldName: 'Don Pedro', mm: 20, date: d(2026, 2, 22) },
    // Don Pedro — March (~50mm)
    { fieldName: 'Don Pedro', mm: 10, date: d(2026, 3, 3) },
    { fieldName: 'Don Pedro', mm: 28, date: d(2026, 3, 15) },
    { fieldName: 'Don Pedro', mm: 12, date: d(2026, 3, 24) },

    // La Esperanza — December (~95mm)
    { fieldName: 'La Esperanza', mm: 28, date: d(2025, 12, 4) },
    { fieldName: 'La Esperanza', mm: 42, date: d(2025, 12, 16) },
    { fieldName: 'La Esperanza', mm: 25, date: d(2025, 12, 27) },
    // La Esperanza — January (~70mm)
    { fieldName: 'La Esperanza', mm: 15, date: d(2026, 1, 6) },
    { fieldName: 'La Esperanza', mm: 35, date: d(2026, 1, 18) },
    { fieldName: 'La Esperanza', mm: 20, date: d(2026, 1, 29) },
    // La Esperanza — February (~80mm)
    { fieldName: 'La Esperanza', mm: 22, date: d(2026, 2, 7) },
    { fieldName: 'La Esperanza', mm: 38, date: d(2026, 2, 18) },
    { fieldName: 'La Esperanza', mm: 20, date: d(2026, 2, 26) },
    // La Esperanza — March (~45mm)
    { fieldName: 'La Esperanza', mm: 18, date: d(2026, 3, 6) },
    { fieldName: 'La Esperanza', mm: 27, date: d(2026, 3, 20) },
  ];

  let rainCount = 0;
  for (const r of rainfallData) {
    const fieldId = fieldIds[r.fieldName];
    await client.query(
      `INSERT INTO rainfall (user_id, field_id, millimeters, rainfall_date, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, fieldId, r.mm, r.date, ts(
        parseInt(r.date.slice(0, 4)), parseInt(r.date.slice(5, 7)), parseInt(r.date.slice(8, 10)), 8
      )],
    );
    rainCount++;
  }
  console.log(`   ${rainCount} rainfall records inserted.`);

  // =========================================================================
  // 5. Activities (domain_events) ~15 records
  // =========================================================================
  console.log('\n5. Inserting activities (domain_events)...');

  const activities: Array<{
    plotKey: string; eventType: string; eventDate: string;
    crop?: string; product?: string; productType?: string;
    quantity?: number; unit?: string; implement?: string; notes?: string;
  }> = [
    // Siembra
    { plotKey: 'Don Pedro/1A', eventType: 'planting', eventDate: d(2025, 11, 15), crop: 'Soja', notes: 'Siembra directa DM 40R16' },
    { plotKey: 'Don Pedro/1B', eventType: 'planting', eventDate: d(2025, 12, 1), crop: 'Maíz', notes: 'Siembra DK 72-10, 5.2 pl/m' },
    { plotKey: 'La Esperanza/Sur', eventType: 'planting', eventDate: d(2025, 12, 10), crop: 'Girasol', notes: 'Siembra Paraíso 20' },

    // Fumigación
    { plotKey: 'Don Pedro/1A', eventType: 'spraying', eventDate: d(2026, 1, 15), product: 'Glifosato', productType: 'herbicida', quantity: 3, unit: 'lt/ha', crop: 'Soja' },
    { plotKey: 'La Esperanza/Norte', eventType: 'spraying', eventDate: d(2026, 2, 8), product: 'Cipermetrina', productType: 'insecticida', quantity: 0.25, unit: 'lt/ha', crop: 'Trigo' },
    { plotKey: 'Don Pedro/1B', eventType: 'spraying', eventDate: d(2026, 2, 20), product: 'Opera', productType: 'fungicida', quantity: 0.5, unit: 'lt/ha', crop: 'Maíz' },
    { plotKey: 'Don Pedro/1A', eventType: 'spraying', eventDate: d(2026, 3, 5), product: 'Dicamba', productType: 'herbicida', quantity: 0.3, unit: 'lt/ha', crop: 'Soja', notes: 'Control rama negra' },

    // Fertilización
    { plotKey: 'Don Pedro/1B', eventType: 'fertilization', eventDate: d(2026, 1, 8), product: 'Urea granulada', productType: 'fertilizante', quantity: 200, unit: 'kg/ha', crop: 'Maíz' },
    { plotKey: 'La Esperanza/Sur', eventType: 'fertilization', eventDate: d(2026, 2, 5), product: 'Fosfato diamónico', productType: 'fertilizante', quantity: 100, unit: 'kg/ha', crop: 'Girasol' },

    // Labranza
    { plotKey: 'Don Pedro/1C', eventType: 'tillage', eventDate: d(2025, 12, 8), implement: 'Disco', notes: 'Pasada de disco doble' },

    // Cosecha
    { plotKey: 'La Esperanza/Norte', eventType: 'harvest', eventDate: d(2026, 2, 10), crop: 'Trigo', quantity: 120, unit: 'tn', notes: 'Rinde 4.0 tn/ha' },

    // Riego
    { plotKey: 'La Esperanza/Sur', eventType: 'irrigation', eventDate: d(2026, 1, 25), quantity: 30, unit: 'mm', notes: 'Riego complementario por déficit hídrico' },

    // More activities for March (current month data)
    { plotKey: 'Don Pedro/1A', eventType: 'spraying', eventDate: d(2026, 3, 18), product: 'Clorpirifos', productType: 'insecticida', quantity: 1, unit: 'lt/ha', crop: 'Soja', notes: 'Control chinche' },
    { plotKey: 'Don Pedro/1B', eventType: 'fertilization', eventDate: d(2026, 3, 10), product: 'KCl', productType: 'fertilizante', quantity: 80, unit: 'kg/ha', crop: 'Maíz', notes: 'Refuerzo potasio' },
  ];

  let actCount = 0;
  // Track harvest event ids by plot_crop_id so we can attach loads later
  const harvestEventByCropId: Record<number, number> = {};
  for (const a of activities) {
    const plotId = plotIds[a.plotKey];
    const cropKey = a.plotKey;
    const plotCropId = cropIds[cropKey] || null;
    const { rows: [evt] } = await client.query(
      `INSERT INTO domain_events (user_id, plot_id, plot_crop_id, event_type, event_date, crop, product, product_type, quantity, unit, implement, notes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [userId, plotId, plotCropId, a.eventType, a.eventDate,
        a.crop || null, a.product || null, a.productType || null,
        a.quantity || null, a.unit || null, a.implement || null,
        a.notes || null, ts(
          parseInt(a.eventDate.slice(0, 4)), parseInt(a.eventDate.slice(5, 7)), parseInt(a.eventDate.slice(8, 10)), 9
        )],
    );
    if (a.eventType === 'harvest' && plotCropId) {
      harvestEventByCropId[plotCropId] = evt.id;
    }
    actCount++;
  }
  console.log(`   ${actCount} activities inserted.`);

  // =========================================================================
  // 6. Observations (agro_observations) ~12 records
  // =========================================================================
  console.log('\n6. Inserting observations...');

  const observations: Array<{
    plotKey: string; text: string; normalizedText: string;
    category: string; date: string;
  }> = [
    // Malezas
    { plotKey: 'Don Pedro/1A', text: 'Rama negra en cabecera del lote', normalizedText: 'rama negra en cabecera del lote', category: 'malezas', date: d(2026, 1, 10) },
    { plotKey: 'La Esperanza/Sur', text: 'Yuyo colorado emergente en sectores bajos', normalizedText: 'yuyo colorado emergente en sectores bajos', category: 'malezas', date: d(2026, 2, 12) },

    // Sanidad
    { plotKey: 'La Esperanza/Norte', text: 'Presencia de roya anaranjada en hojas basales', normalizedText: 'presencia de roya anaranjada en hojas basales', category: 'sanidad', date: d(2026, 1, 18) },
    { plotKey: 'Don Pedro/1B', text: 'Isoca bolillera detectada, umbral cercano', normalizedText: 'isoca bolillera detectada umbral cercano', category: 'sanidad', date: d(2026, 2, 15) },

    // Fenología
    { plotKey: 'Don Pedro/1A', text: 'Soja en V4, buen desarrollo radicular', normalizedText: 'soja en v4 buen desarrollo radicular', category: 'fenologia', date: d(2026, 1, 5) },
    { plotKey: 'Don Pedro/1B', text: 'Maíz en V8, inicio panojamiento', normalizedText: 'maiz en v8 inicio panojamiento', category: 'fenologia', date: d(2026, 2, 1) },
    { plotKey: 'La Esperanza/Norte', text: 'Trigo en espigazón completa', normalizedText: 'trigo en espigazon completa', category: 'fenologia', date: d(2026, 1, 20) },

    // Nutrición
    { plotKey: 'Don Pedro/1B', text: 'Hojas amarillas en sector norte, posible deficiencia de N', normalizedText: 'hojas amarillas en sector norte posible deficiencia de n', category: 'nutricion', date: d(2026, 3, 2) },

    // Clima
    { plotKey: 'La Esperanza/Norte', text: 'Helada leve -2°C al amanecer', normalizedText: 'helada leve -2c al amanecer', category: 'clima', date: d(2026, 1, 3) },
    { plotKey: 'Don Pedro/1C', text: 'Granizo parcial, daño leve en rastrojo', normalizedText: 'granizo parcial dano leve en rastrojo', category: 'clima', date: d(2026, 2, 18) },

    // General
    { plotKey: 'Don Pedro/1A', text: 'Buen stand de plantas, 32 pl/m lineal', normalizedText: 'buen stand de plantas 32 pl/m lineal', category: 'general', date: d(2025, 12, 20) },
    { plotKey: 'La Esperanza/Sur', text: 'Piso húmedo dificulta acceso con maquinaria', normalizedText: 'piso humedo dificulta acceso con maquinaria', category: 'general', date: d(2026, 3, 12) },
  ];

  let obsCount = 0;
  for (const o of observations) {
    const plotId = plotIds[o.plotKey];
    const fieldKey = o.plotKey.split('/')[0];
    const fieldId = fieldIds[fieldKey];
    await client.query(
      `INSERT INTO agro_observations (user_id, field_id, plot_id, observation_text, normalized_text, category, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, fieldId, plotId, o.text, o.normalizedText, o.category, 'text', ts(
        parseInt(o.date.slice(0, 4)), parseInt(o.date.slice(5, 7)), parseInt(o.date.slice(8, 10)), 11
      )],
    );
    obsCount++;
  }
  console.log(`   ${obsCount} observations inserted.`);

  // =========================================================================
  // 7. Crop scoutings (structured monitoring) ~10 records
  // =========================================================================
  console.log('\n7. Inserting crop scoutings...');

  const scoutings: Array<{
    plotKey: string; scoutingDate: string; stageCode?: string;
    weedCoveragePct?: number; weedSpecies?: string[];
    pestSpecies?: string; pestSeverity?: number; pestAffectedPct?: number;
    soilMoisture?: number; emergencePct?: number; plantDensityM2?: number;
    notes?: string;
  }> = [
    { plotKey: 'Don Pedro/1A', scoutingDate: d(2026, 1, 5), stageCode: 'V4', emergencePct: 95, plantDensityM2: 28, soilMoisture: 3, notes: 'Buena implantación' },
    { plotKey: 'Don Pedro/1A', scoutingDate: d(2026, 1, 22), stageCode: 'V6', weedCoveragePct: 12, weedSpecies: ['rama negra', 'yuyo colorado'], pestSpecies: 'chinche', pestSeverity: 2 },
    { plotKey: 'Don Pedro/1A', scoutingDate: d(2026, 2, 18), stageCode: 'R3', weedCoveragePct: 8, pestSpecies: 'chinche', pestSeverity: 3, pestAffectedPct: 25, soilMoisture: 2, notes: 'Subió la presión, evaluar control' },
    { plotKey: 'Don Pedro/1A', scoutingDate: d(2026, 3, 10), stageCode: 'R5', weedCoveragePct: 5, pestSpecies: 'chinche', pestSeverity: 1, soilMoisture: 4 },
    { plotKey: 'Don Pedro/1B', scoutingDate: d(2026, 1, 28), stageCode: 'V8', emergencePct: 92, plantDensityM2: 6, soilMoisture: 3 },
    { plotKey: 'Don Pedro/1B', scoutingDate: d(2026, 2, 15), stageCode: 'V12', pestSpecies: 'isoca bolillera', pestSeverity: 3, pestAffectedPct: 15, notes: 'Cerca del umbral de daño económico' },
    { plotKey: 'Don Pedro/1B', scoutingDate: d(2026, 3, 5), stageCode: 'R2', weedCoveragePct: 3, soilMoisture: 4 },
    { plotKey: 'La Esperanza/Norte', scoutingDate: d(2026, 1, 18), stageCode: 'Z5', pestSpecies: 'roya anaranjada', pestSeverity: 2, pestAffectedPct: 10 },
    { plotKey: 'La Esperanza/Norte', scoutingDate: d(2026, 2, 5), stageCode: 'Z7', pestSpecies: 'roya anaranjada', pestSeverity: 4, pestAffectedPct: 35, notes: 'Aplicar fungicida urgente' },
    { plotKey: 'La Esperanza/Sur', scoutingDate: d(2026, 1, 30), stageCode: 'V6', emergencePct: 88, plantDensityM2: 5, weedCoveragePct: 18, weedSpecies: ['yuyo colorado'] },
    { plotKey: 'La Esperanza/Sur', scoutingDate: d(2026, 2, 22), stageCode: 'R1', soilMoisture: 2, notes: 'Floración, déficit hídrico' },
  ];

  let scoutCount = 0;
  for (const s of scoutings) {
    const plotId = plotIds[s.plotKey];
    const fieldKey = s.plotKey.split('/')[0];
    const fieldId = fieldIds[fieldKey];
    const cropId = cropIds[s.plotKey] || null;
    await client.query(
      `INSERT INTO crop_scoutings (
         user_id, field_id, plot_id, plot_crop_id, scouting_date,
         stage_code, weed_coverage_pct, weed_species,
         pest_species, pest_severity_1_5, pest_affected_pct,
         soil_moisture_1_5, emergence_pct, plant_density_m2,
         notes, source, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'text',$16)`,
      [
        userId, fieldId, plotId, cropId, s.scoutingDate,
        s.stageCode || null, s.weedCoveragePct ?? null,
        s.weedSpecies && s.weedSpecies.length ? s.weedSpecies : null,
        s.pestSpecies || null, s.pestSeverity ?? null, s.pestAffectedPct ?? null,
        s.soilMoisture ?? null, s.emergencePct ?? null, s.plantDensityM2 ?? null,
        s.notes || null,
        ts(parseInt(s.scoutingDate.slice(0,4)), parseInt(s.scoutingDate.slice(5,7)), parseInt(s.scoutingDate.slice(8,10)), 8),
      ],
    );
    scoutCount++;
  }
  console.log(`   ${scoutCount} scoutings inserted.`);

  // =========================================================================
  // 8. Harvest loads (per-truck for the existing trigo harvest)
  // =========================================================================
  console.log('\n8. Inserting harvest loads...');

  const trigoCropId = cropIds['La Esperanza/Norte'] ?? null;
  const trigoHarvestEventId = trigoCropId ? harvestEventByCropId[trigoCropId] : null;
  let loadsCount = 0;
  if (trigoHarvestEventId && trigoCropId) {
    const trigoLoads = [
      { driver: 'Britos', kg: 31320, dest: 'Cargill',  hum: 13.5, qual: { protein_pct: 11.8, gluten_pct: 24, test_weight_kg_hl: 78 } },
      { driver: 'Contreras', kg: 30580, dest: 'Cargill', hum: 14.0, qual: null },
      { driver: 'Vitali', kg: 29950, dest: 'ACA', hum: 13.8, qual: { protein_pct: 12.1, gluten_pct: 25 } },
      { driver: 'Medero', kg: 28640, dest: 'ACA', hum: 14.2, qual: null },
    ];
    for (const ld of trigoLoads) {
      await client.query(
        `INSERT INTO harvest_loads (domain_event_id, plot_crop_id, driver_name, weight_kg, destination, destinatario, truck_plate, humidity_pct, quality_metrics)
         VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7)`,
        [trigoHarvestEventId, trigoCropId, ld.driver, ld.kg, ld.dest, ld.hum, ld.qual ? JSON.stringify(ld.qual) : null],
      );
      loadsCount++;
    }
    // Update plot_crops.yield_kg by summing loads
    await client.query(
      `UPDATE plot_crops SET yield_kg = (SELECT COALESCE(SUM(weight_kg),0) FROM harvest_loads WHERE plot_crop_id = $1) WHERE id = $1`,
      [trigoCropId],
    );
  }
  console.log(`   ${loadsCount} harvest loads inserted.`);

  // =========================================================================
  // 9. Livestock (groups + movements) — ~3 groups, ~6 movements
  // =========================================================================
  console.log('\n9. Inserting livestock data...');

  const livestockSeed: Array<{
    plotKey: string; category: 'vaca' | 'novillo' | 'ternero'; breed: string;
    initialCount: number; movements: Array<{
      type: 'entrada' | 'salida' | 'nacimiento' | 'muerte';
      count: number; date: string;
      unit_price_ars?: number; unit_price_usd?: number;
    }>;
  }> = [
    {
      plotKey: 'Don Pedro/1C', category: 'vaca', breed: 'Angus', initialCount: 0,
      movements: [
        { type: 'entrada', count: 25, date: d(2025, 12, 5), unit_price_ars: 600000 },
        { type: 'nacimiento', count: 8, date: d(2026, 2, 10) },
        { type: 'salida', count: 4, date: d(2026, 3, 18), unit_price_ars: 720000 },
      ],
    },
    {
      plotKey: 'Don Pedro/1C', category: 'novillo', breed: 'Angus', initialCount: 0,
      movements: [
        { type: 'entrada', count: 30, date: d(2025, 11, 20), unit_price_usd: 800 },
        { type: 'salida', count: 10, date: d(2026, 3, 25), unit_price_usd: 950 },
      ],
    },
    {
      plotKey: 'Don Pedro/1C', category: 'ternero', breed: 'Angus', initialCount: 0,
      movements: [
        { type: 'entrada', count: 12, date: d(2026, 1, 15), unit_price_ars: 280000 },
        { type: 'muerte', count: 1, date: d(2026, 2, 28) },
      ],
    },
  ];

  let groupCount = 0;
  let movCount = 0;
  for (const g of livestockSeed) {
    const plotId = plotIds[g.plotKey];
    const fieldKey = g.plotKey.split('/')[0];
    const fieldId = fieldIds[fieldKey];
    // Compute final count from movements
    let finalCount = g.initialCount;
    for (const m of g.movements) {
      if (m.type === 'entrada' || m.type === 'nacimiento') finalCount += m.count;
      else finalCount -= m.count;
    }
    const { rows: [grp] } = await client.query(
      `INSERT INTO livestock_groups (user_id, field_id, plot_id, category, breed, count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, fieldId, plotId, g.category, g.breed, finalCount],
    );
    groupCount++;
    // Insert movements
    for (const m of g.movements) {
      const isIncoming = m.type === 'entrada' || m.type === 'nacimiento';
      const sourceId = isIncoming ? null : grp.id;
      const destId = isIncoming ? grp.id : null;
      await client.query(
        `INSERT INTO livestock_movements
         (user_id, movement_type, source_group_id, dest_group_id, count,
          unit_price_ars, unit_price_usd, movement_date, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId, m.type, sourceId, destId, m.count,
          m.unit_price_ars ?? null, m.unit_price_usd ?? null, m.date,
          ts(parseInt(m.date.slice(0,4)), parseInt(m.date.slice(5,7)), parseInt(m.date.slice(8,10)), 14),
        ],
      );
      movCount++;
    }
  }
  console.log(`   ${groupCount} livestock groups, ${movCount} movements inserted.`);

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n========================================');
  console.log('Seed complete!');
  console.log('========================================');
  console.log(`  User ID:       ${userId}`);
  console.log(`  Fields:        ${Object.keys(fieldIds).length}`);
  console.log(`  Plots:         ${Object.keys(plotIds).length}`);
  console.log(`  Crops:         ${Object.keys(cropIds).length}`);
  console.log(`  Expenses:      ${expCount}`);
  console.log(`  Incomes:       ${incCount}`);
  console.log(`  Rainfall:      ${rainCount}`);
  console.log(`  Activities:    ${actCount}`);
  console.log(`  Observations:  ${obsCount}`);
  console.log(`  Scoutings:     ${scoutCount}`);
  console.log(`  Harvest loads: ${loadsCount}`);
  console.log(`  Livestock:     ${groupCount} grupos / ${movCount} movimientos`);
  console.log('========================================');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { userId, reset } = parseArgs();

  // Verify user exists
  const { rows: [user] } = await pool.query(
    `SELECT id, name, email FROM users WHERE id = $1`,
    [userId],
  );
  if (!user) {
    console.error(`Error: User with id=${userId} not found.`);
    process.exit(1);
  }
  console.log(`Target user: id=${user.id}, name="${user.name || '(none)'}", email="${user.email || '(none)'}"`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (reset) {
      await resetUserData(client, userId);
    }

    await seed(client, userId);

    await client.query('COMMIT');
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    const error = err as Error;
    console.error('\nError during seeding:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
