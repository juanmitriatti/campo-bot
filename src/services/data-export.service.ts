import archiver from 'archiver';
import { pool } from '../config/db.js';
import type { Response } from 'express';
import type { UserId } from '../types/index.js';

interface ExportTable {
  filename: string;
  query: string;
  description: string;
}

/**
 * Per-domain table export queries. Each row is owned by `user_id` either
 * directly or via a join. Soft-deleted rows ARE included (deleted_at column
 * preserved when present) so the user has a complete trail.
 */
const EXPORT_TABLES: ExportTable[] = [
  // Account
  {
    filename: 'fields.csv',
    description: 'Campos creados por el usuario.',
    query: `SELECT id, name, city, province, hectares, latitude, longitude, location_method, deleted_at
            FROM fields WHERE user_id = $1 ORDER BY id`,
  },
  {
    filename: 'plots.csv',
    description: 'Lotes (subdivisiones de campos).',
    query: `SELECT p.id, p.name, p.field_id, f.name AS field_name,
                   p.area_hectares, p.grupo, p.soil_type, p.created_at, p.deleted_at
            FROM plots p
            JOIN fields f ON f.id = p.field_id
            WHERE f.user_id = $1
            ORDER BY p.id`,
  },
  {
    filename: 'plot_crops.csv',
    description: 'Campañas de cultivo (siembra → cosecha → cierre).',
    query: `SELECT pc.id, pc.plot_id, p.name AS plot_name, pc.crop, pc.season_year, pc.season_type,
                   pc.start_date, pc.harvested_at, pc.end_date, pc.sowed_hectares,
                   pc.yield_kg, pc.yield_notes, pc.created_at
            FROM plot_crops pc
            JOIN plots p ON p.id = pc.plot_id
            JOIN fields f ON f.id = p.field_id
            WHERE f.user_id = $1
            ORDER BY pc.id`,
  },

  // Financial
  {
    filename: 'expenses.csv',
    description: 'Gastos registrados.',
    query: `SELECT e.id, e.amount, e.currency, e.category, e.description,
                   e.expense_date, e.field_id, f.name AS field_name,
                   e.plot_id, p.name AS plot_name,
                   e.expense_type, e.product, e.quantity, e.unit, e.unit_price,
                   e.created_at, e.deleted_at
            FROM expenses e
            LEFT JOIN fields f ON f.id = e.field_id
            LEFT JOIN plots p ON p.id = e.plot_id
            WHERE e.user_id = $1
            ORDER BY e.id`,
  },
  {
    filename: 'incomes.csv',
    description: 'Ingresos registrados.',
    query: `SELECT i.id, i.amount, i.currency, i.category, i.description,
                   i.income_date, i.field_id, f.name AS field_name,
                   i.plot_id, p.name AS plot_name,
                   i.quantity, i.unit, i.unit_price,
                   i.created_at, i.deleted_at
            FROM incomes i
            LEFT JOIN fields f ON f.id = i.field_id
            LEFT JOIN plots p ON p.id = i.plot_id
            WHERE i.user_id = $1
            ORDER BY i.id`,
  },
  {
    filename: 'budgets.csv',
    description: 'Presupuestos mensuales por categoría.',
    query: `SELECT id, category, monthly_limit
            FROM budgets WHERE user_id = $1 ORDER BY id`,
  },
  {
    filename: 'expense_templates.csv',
    description: 'Plantillas de gastos recurrentes.',
    query: `SELECT id, name, amount, currency, category, description,
                   field_id, plot_id, expense_type, product, quantity, unit,
                   recurrence_type, recurrence_day, active, next_run_date, last_run_date, created_at
            FROM expense_templates WHERE user_id = $1 ORDER BY id`,
  },

  // Agronomy
  {
    filename: 'activities.csv',
    description: 'Actividades agronómicas y eventos de hacienda (siembra, fumigación, sanidad, repro, pesaje, etc.).',
    query: `SELECT de.id, de.event_type, de.crop, de.product, de.product_type,
                   de.quantity, de.unit, de.implement, de.notes,
                   de.event_date, de.plot_id, p.name AS plot_name,
                   p.field_id, f.name AS field_name,
                   de.corral_id, de.animal_category, de.animals_affected,
                   de.pregnant_count, de.open_count, de.uncertain_count,
                   de.created_at
            FROM domain_events de
            LEFT JOIN plots p ON p.id = de.plot_id
            LEFT JOIN fields f ON f.id = p.field_id
            WHERE de.user_id = $1
            ORDER BY de.id`,
  },
  {
    filename: 'observations.csv',
    description: 'Observaciones de campo (texto libre).',
    query: `SELECT ao.id, ao.observation_text, ao.normalized_text, ao.category, ao.source,
                   ao.observation_date,
                   ao.plot_id, p.name AS plot_name,
                   ao.field_id, f.name AS field_name, ao.created_at
            FROM agro_observations ao
            LEFT JOIN plots p ON p.id = ao.plot_id
            LEFT JOIN fields f ON f.id = ao.field_id
            WHERE ao.user_id = $1
            ORDER BY ao.id`,
  },
  {
    filename: 'scoutings.csv',
    description: 'Monitoreos estructurados de cultivo.',
    query: `SELECT cs.id, cs.scouting_date, cs.stage_code,
                   cs.weed_coverage_pct, cs.weed_species, cs.pest_species,
                   cs.pest_severity_1_5, cs.pest_affected_pct,
                   cs.soil_moisture_1_5, cs.emergence_pct, cs.plant_density_m2,
                   cs.notes, cs.source, cs.plot_id, p.name AS plot_name,
                   cs.field_id, f.name AS field_name, cs.created_at, cs.deleted_at
            FROM crop_scoutings cs
            LEFT JOIN plots p ON p.id = cs.plot_id
            LEFT JOIN fields f ON f.id = cs.field_id
            WHERE cs.user_id = $1
            ORDER BY cs.id`,
  },
  {
    filename: 'harvest_loads.csv',
    description: 'Cargas de cosecha por camión (chofer, kg, humedad, calidad).',
    query: `SELECT hl.id, hl.domain_event_id, hl.plot_crop_id,
                   hl.driver_name, hl.weight_kg, hl.destination, hl.destinatario,
                   hl.truck_plate, hl.humidity_pct, hl.quality_metrics, hl.notes,
                   de.event_date, de.plot_id, p.name AS plot_name,
                   p.field_id, f.name AS field_name, hl.created_at
            FROM harvest_loads hl
            JOIN domain_events de ON de.id = hl.domain_event_id
            LEFT JOIN plots p ON p.id = de.plot_id
            LEFT JOIN fields f ON f.id = p.field_id
            WHERE de.user_id = $1
            ORDER BY hl.id`,
  },
  {
    filename: 'rainfall.csv',
    description: 'Lluvias registradas.',
    query: `SELECT r.id, r.millimeters, r.rainfall_date,
                   r.field_id, f.name AS field_name,
                   r.plot_id, p.name AS plot_name, r.created_at
            FROM rainfall r
            LEFT JOIN fields f ON f.id = r.field_id
            LEFT JOIN plots p ON p.id = r.plot_id
            WHERE r.user_id = $1
            ORDER BY r.id`,
  },
  {
    filename: 'agronomic_reports.csv',
    description: 'Reportes agronómicos generados (metadata; los PDF binarios se eliminan al borrar la cuenta).',
    query: `SELECT id, field_id, plot_id, week_number, year, pdf_path, created_at
            FROM agronomic_reports WHERE user_id = $1 ORDER BY id`,
  },

  // Livestock
  {
    filename: 'livestock_groups.csv',
    description: 'Grupos de hacienda (vaca, ternero, novillo, etc.) por lote/corral.',
    query: `SELECT lg.id, lg.category, lg.count, lg.breed, lg.avg_weight_kg,
                   lg.field_id, f.name AS field_name,
                   lg.plot_id, p.name AS plot_name,
                   lg.corral_id, c.name AS corral_name,
                   lg.notes, lg.created_at, lg.deleted_at
            FROM livestock_groups lg
            LEFT JOIN fields f ON f.id = lg.field_id
            LEFT JOIN plots p ON p.id = lg.plot_id
            LEFT JOIN corrals c ON c.id = lg.corral_id
            WHERE lg.user_id = $1
            ORDER BY lg.id`,
  },
  {
    filename: 'livestock_movements.csv',
    description: 'Historial de movimientos de hacienda (entradas, salidas, transferencias, nacimientos, muertes, ajustes).',
    query: `SELECT id, movement_type, source_group_id, dest_group_id, count,
                   avg_weight_kg, unit_price_ars, unit_price_usd,
                   linked_expense_id, linked_income_id, reason, notes, movement_date, created_at
            FROM livestock_movements
            WHERE user_id = $1 ORDER BY id`,
  },
  {
    filename: 'feedlots.csv',
    description: 'Feedlots (engorde a corral).',
    query: `SELECT fl.id, fl.name, fl.field_id, f.name AS field_name,
                   fl.capacity, fl.notes, fl.created_at, fl.deleted_at
            FROM feedlots fl
            LEFT JOIN fields f ON f.id = fl.field_id
            WHERE fl.user_id = $1
            ORDER BY fl.id`,
  },
  {
    filename: 'corrals.csv',
    description: 'Corrales dentro de feedlots.',
    query: `SELECT c.id, c.feedlot_id, fl.name AS feedlot_name, c.name,
                   c.capacity, c.notes, c.created_at, c.deleted_at
            FROM corrals c
            JOIN feedlots fl ON fl.id = c.feedlot_id
            WHERE fl.user_id = $1
            ORDER BY c.id`,
  },

  // Stock
  {
    filename: 'warehouses.csv',
    description: 'Galpones / depósitos.',
    query: `SELECT w.id, w.name, w.field_id, f.name AS field_name, w.created_at, w.deleted_at
            FROM warehouses w
            JOIN fields f ON f.id = w.field_id
            WHERE f.user_id = $1
            ORDER BY w.id`,
  },
  {
    filename: 'stock_items.csv',
    description: 'Productos en stock (insumos, semillas, granos).',
    query: `SELECT si.id, si.name, si.category, si.unit, si.current_quantity, si.min_stock,
                   si.grade, si.humidity_pct,
                   si.warehouse_id, w.name AS warehouse_name,
                   si.created_at, si.deleted_at
            FROM stock_items si
            LEFT JOIN warehouses w ON w.id = si.warehouse_id
            WHERE si.user_id = $1
            ORDER BY si.id`,
  },
  {
    filename: 'stock_movements.csv',
    description: 'Historial de movimientos de stock (entradas, salidas, ajustes).',
    query: `SELECT id, stock_item_id, movement_type, quantity, reason, notes,
                   expense_id, domain_event_id, movement_date, created_at
            FROM stock_movements WHERE user_id = $1 ORDER BY id`,
  },

  // Documents (metadata only — no binaries)
  {
    filename: 'documents.csv',
    description: 'Metadata de documentos procesados (facturas/remitos). El binario NO se incluye en este export.',
    query: `SELECT id, document_type, source_channel, original_filename, mime_type, file_size_bytes,
                   processing_status, processing_error, linked_expense_id, extracted_data,
                   created_at, deleted_at
            FROM documents WHERE user_id = $1 ORDER BY id`,
  },

  // Sharing
  {
    filename: 'field_invites.csv',
    description: 'Invitaciones a campos compartidos generadas por el usuario.',
    query: `SELECT fi.id, fi.field_id, f.name AS field_name, fi.code,
                   fi.expires_at, fi.used_by, fi.used_at, fi.created_at
            FROM field_invites fi
            LEFT JOIN fields f ON f.id = fi.field_id
            WHERE fi.created_by = $1
            ORDER BY fi.id`,
  },
  {
    filename: 'field_members.csv',
    description: 'Miembros con acceso a los campos del usuario.',
    query: `SELECT fm.id, fm.field_id, f.name AS field_name, fm.user_id AS member_user_id,
                   fm.role, fm.invited_by, fm.created_at
            FROM field_members fm
            JOIN fields f ON f.id = fm.field_id
            WHERE f.user_id = $1
            ORDER BY fm.field_id, fm.user_id`,
  },
];

interface AccountMetadata {
  user: {
    id: number;
    name: string | null;
    last_name: string | null;
    email: string | null;
    role: string;
    city: string | null;
    province: string | null;
    phone_number: string | null;
    telegram_id: string | null;
    whatsapp_verified_at: string | null;
    telegram_verified_at: string | null;
  };
  plan: { id: number; name: string; display_name: string } | null;
  exported_at: string;
  notes: string;
}

export class DataExportService {
  /**
   * Stream a ZIP archive of every CSV table for this user to the response.
   * The response must NOT have been written to yet (we set headers + pipe).
   */
  async streamUserExport(userId: UserId, res: Response): Promise<void> {
    const filename = `campo-bot-export-user-${userId}-${new Date().toISOString().slice(0, 10)}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') console.error('[export] archive warning:', err);
    });
    archive.on('error', err => {
      console.error('[export] archive error:', err);
      throw err;
    });
    archive.pipe(res);

    // README
    const readme =
      'Campo Bot — Exportación de datos\n' +
      '================================\n\n' +
      'Este archivo contiene una copia de todos tus datos en formato CSV.\n' +
      'Cada archivo corresponde a una sección del bot:\n\n' +
      EXPORT_TABLES.map(t => `  • ${t.filename.padEnd(30)} ${t.description}`).join('\n') +
      '\n\n' +
      'metadata.json contiene información de tu cuenta y plan.\n' +
      '\n' +
      'Generado el ' + new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) + '.\n';
    archive.append(readme, { name: 'README.txt' });

    // Account metadata
    const metadata = await this.buildMetadata(userId);
    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });

    // Per-table CSVs
    for (const table of EXPORT_TABLES) {
      try {
        const { rows } = await pool.query(table.query, [userId]);
        const csv = rowsToCsv(rows);
        archive.append(csv, { name: table.filename });
      } catch (err) {
        // If a table query fails (schema mismatch, etc.) skip it but include a stub
        // so the export doesn't blow up entirely.
        console.error(`[export] failed to query ${table.filename}:`, err);
        archive.append(
          `# Esta sección no se pudo exportar.\n# Error: ${(err as Error).message}\n`,
          { name: table.filename },
        );
      }
    }

    await archive.finalize();
  }

  private async buildMetadata(userId: UserId): Promise<AccountMetadata> {
    const userQ = await pool.query(
      `SELECT id, name, last_name, email, role, city, province,
              phone_number, telegram_id,
              whatsapp_verified_at, telegram_verified_at
       FROM users WHERE id = $1`,
      [userId],
    );
    const user = userQ.rows[0] ?? null;

    const planQ = await pool.query(
      `SELECT p.id, p.name, p.display_name
       FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = $1`,
      [userId],
    );
    const plan = planQ.rows[0] ?? null;

    return {
      user: {
        id: user?.id ?? userId,
        name: user?.name ?? null,
        last_name: user?.last_name ?? null,
        email: user?.email ?? null,
        role: user?.role ?? 'end_user',
        city: user?.city ?? null,
        province: user?.province ?? null,
        phone_number: user?.phone_number ?? null,
        telegram_id: user?.telegram_id ?? null,
        whatsapp_verified_at: user?.whatsapp_verified_at?.toISOString?.() ?? null,
        telegram_verified_at: user?.telegram_verified_at?.toISOString?.() ?? null,
      },
      plan,
      exported_at: new Date().toISOString(),
      notes:
        'Esta exportación NO incluye los archivos binarios de documentos (facturas/remitos). ' +
        'Solo se incluye la metadata. Si necesitás los archivos originales, contactá soporte.',
    };
  }
}

// --- CSV serialization ---

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(headers.map(escapeCsv).join(','));
  for (const row of rows) {
    lines.push(headers.map(h => escapeCsv(formatCell(row[h]))).join(','));
  }
  return lines.join('\n') + '\n';
}

function formatCell(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeCsv(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
