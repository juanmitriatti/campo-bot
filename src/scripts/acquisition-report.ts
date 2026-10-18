/**
 * De dónde llegaron los usuarios nuevos: altas, activados y pagos por origen.
 *
 *   npx tsx src/scripts/acquisition-report.ts            # últimos 30 días
 *   npx tsx src/scripts/acquisition-report.ts --days 7
 *
 * Contra prod: `railway run --service campo-bot -- npx tsx src/scripts/acquisition-report.ts`.
 */
import 'dotenv/config';
import { pool } from '../config/db.js';
import { acquisitionReport } from '../services/acquisition.service.js';

const i = process.argv.indexOf('--days');
const days = i >= 0 ? Number(process.argv[i + 1]) || 30 : 30;

const rows = await acquisitionReport(days);
console.log(`Altas de los últimos ${days} días por primer origen\n`);
console.table(rows.map((r) => ({
  canal: r.channel, origen: r.source, campaña: r.campaign, anuncio: r.ad,
  altas: r.signups, activados: r.activated, pagan: r.paying,
})));
await pool.end();
