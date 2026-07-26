/**
 * Seed complementario de seed-dummy-data: llena los tabs que aquel no cubre
 * (Stock, Documentos, Recordatorios, Categorías, Reportes) para poder testear
 * consistencia entre el dashboard y el bot con el mismo usuario.
 *
 * Uso: npx tsx src/scripts/seed-extra-tabs.ts --user-id <id>
 * Idempotente: se saltea cada sección si el usuario ya tiene datos de ese tipo.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool } from '../config/db.js';

const args = process.argv.slice(2);
const uidIdx = args.indexOf('--user-id');
const userId = uidIdx >= 0 ? parseInt(args[uidIdx + 1], 10) : NaN;
if (isNaN(userId)) {
  console.error('Uso: npx tsx src/scripts/seed-extra-tabs.ts --user-id <id>');
  process.exit(1);
}

const DOC_STORAGE = process.env.DOCUMENT_STORAGE_PATH || '/data/documents';

// PNG 1x1 y PDF mínimo válidos — alcanzan para que el preview/descarga funcionen
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const TINY_PDF = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF\n`,
);

async function getFields(): Promise<Array<{ id: number; name: string }>> {
  const { rows } = await pool.query(
    `SELECT id, name FROM fields WHERE user_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [userId],
  );
  return rows;
}

async function seedStock(fields: Array<{ id: number; name: string }>): Promise<string> {
  const existing = await pool.query(`SELECT 1 FROM stock_items WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`, [userId]);
  if (existing.rows.length) return 'stock: ya tenía, salteado';
  if (!fields.length) return 'stock: sin campos, salteado';

  const wh = await pool.query(
    `INSERT INTO warehouses (field_id, name) VALUES ($1, $2) RETURNING id`,
    [fields[0].id, `Galpón ${fields[0].name}`],
  );
  const whId = wh.rows[0].id;

  const items: Array<[string, string, number, string, number | null]> = [
    ['Glifosato 48%', 'agroquimicos', 800, 'lt', 200],
    ['Urea granulada', 'fertilizantes', 5000, 'kg', 1000],
    ['Semilla soja DM53', 'semillas', 120, 'bolsas', null],
    ['Gasoil', 'combustibles', 400, 'lt', 500], // debajo del mínimo a propósito (alerta stock bajo)
    ['Ivermectina 1%', 'veterinaria', 12, 'lt', 5],
  ];
  for (const [name, category, qty, unit, min] of items) {
    const it = await pool.query(
      `INSERT INTO stock_items (user_id, warehouse_id, name, category, current_quantity, unit, min_stock)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [userId, whId, name, category, qty, unit, min],
    );
    await pool.query(
      `INSERT INTO stock_movements (stock_item_id, user_id, movement_type, quantity, reason, movement_date)
       VALUES ($1, $2, 'entrada', $3, 'Compra inicial', CURRENT_DATE - 20),
              ($1, $2, 'salida', $4, 'Aplicación en lote', CURRENT_DATE - 5)`,
      [it.rows[0].id, userId, qty * 1.5, qty * 0.5],
    );
  }
  return `stock: 1 galpón + ${items.length} insumos (Gasoil quedó bajo mínimo) + ${items.length * 2} movimientos`;
}

async function seedDocuments(): Promise<string> {
  const existing = await pool.query(`SELECT 1 FROM documents WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`, [userId]);
  if (existing.rows.length) return 'documentos: ya tenía, salteado';

  fs.mkdirSync(DOC_STORAGE, { recursive: true });
  const docs: Array<[string, string, Buffer, string, Record<string, unknown>]> = [
    ['factura', 'factura-agroquimicos.png', TINY_PNG, 'image/png', {
      tipo: 'factura', proveedor: 'Agroinsumos del Sur SA', total: 1250000, moneda: 'ARS',
      items: [{ descripcion: 'Glifosato 48% x 200lt', importe: 1250000 }], fecha: '2026-07-10',
    }],
    ['remito', 'remito-semillas.pdf', TINY_PDF, 'application/pdf', {
      tipo: 'remito', origen: 'Semillería Central', items: [{ producto: 'Semilla soja DM53', cantidad: 120, unidad: 'bolsas' }], fecha: '2026-07-15',
    }],
  ];
  for (const [docType, filename, buf, mime, extracted] of docs) {
    const stored = `seed_${userId}_${filename}`;
    fs.writeFileSync(path.join(DOC_STORAGE, stored), buf);
    await pool.query(
      `INSERT INTO documents (user_id, document_type, original_filename, mime_type, file_size_bytes,
                              compressed_path, file_hash, extracted_data, processing_status, source_channel)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', 'telegram')`,
      [userId, docType, filename, mime, buf.length, stored,
       crypto.createHash('sha256').update(buf).digest('hex'), JSON.stringify(extracted)],
    );
  }
  return `documentos: 1 factura (png) + 1 remito (pdf) procesados`;
}

async function seedReminders(fields: Array<{ id: number; name: string }>): Promise<string> {
  const existing = await pool.query(`SELECT 1 FROM task_reminders WHERE user_id = $1 LIMIT 1`, [userId]);
  if (existing.rows.length) return 'recordatorios: ya tenía, salteado';

  const fieldId = fields[0]?.id ?? null;
  await pool.query(
    `INSERT INTO task_reminders (user_id, description, due_date, due_time, field_id, status) VALUES
     ($1, 'Fumigar lote 1A contra rama negra', CURRENT_DATE + 1, '08:00', $2, 'pending'),
     ($1, 'Pagar arrendamiento a Don Pedro', CURRENT_DATE + 3, NULL, $2, 'pending'),
     ($1, 'Vacunar terneros contra aftosa', CURRENT_DATE + 10, '09:30', $2, 'pending'),
     ($1, 'Comprar repuestos de la sembradora', CURRENT_DATE - 2, NULL, $2, 'completed')`,
    [userId, fieldId],
  );
  return 'recordatorios: 3 pendientes + 1 completado';
}

async function seedCategories(): Promise<string> {
  const existing = await pool.query(`SELECT 1 FROM user_categories WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1`, [userId]);
  if (existing.rows.length) return 'categorías: ya tenía, salteado';

  // Derivadas de los gastos/ingresos reales del usuario para que sean consistentes
  await pool.query(
    `INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at)
     SELECT $1, 'expense', category, COUNT(*), MAX(created_at)
     FROM expenses WHERE user_id = $1 AND deleted_at IS NULL AND category IS NOT NULL
     GROUP BY category`,
    [userId],
  );
  await pool.query(
    `INSERT INTO user_categories (user_id, kind, name, usage_count, last_used_at)
     SELECT $1, 'income', category, COUNT(*), MAX(created_at)
     FROM incomes WHERE user_id = $1 AND deleted_at IS NULL AND category IS NOT NULL
     GROUP BY category`,
    [userId],
  );
  const n = await pool.query(`SELECT count(*) FROM user_categories WHERE user_id = $1`, [userId]);
  return `categorías: ${n.rows[0].count} derivadas de gastos/ingresos reales`;
}

async function seedReports(fields: Array<{ id: number; name: string }>): Promise<string> {
  const existing = await pool.query(`SELECT 1 FROM agronomic_reports WHERE user_id = $1 LIMIT 1`, [userId]);
  if (existing.rows.length) return 'reportes: ya tenía, salteado';
  const { generateWeeklyReport } = await import('../services/agro-report.js');
  let ok = 0;
  for (const f of fields) {
    try {
      await generateWeeklyReport(userId, f.id);
      ok++;
    } catch (err) {
      console.error(`  reporte de ${f.name} falló:`, (err as Error).message);
    }
  }
  return `reportes: ${ok} PDF semanales reales generados`;
}

async function main() {
  const fields = await getFields();
  console.log(`Seed extra para user ${userId} (${fields.length} campos)`);
  console.log('  ' + await seedStock(fields));
  console.log('  ' + await seedDocuments());
  console.log('  ' + await seedReminders(fields));
  console.log('  ' + await seedCategories());
  console.log('  ' + await seedReports(fields));
  console.log('Listo.');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
