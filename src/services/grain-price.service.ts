/**
 * grain-price.service.ts — Pizarra de granos (Matba-Rofex, Rosario).
 *
 * Fuente: API pública https://apicem.matbarofex.com.ar/api/v2/closing-prices
 * (sin API key). Para cada grano tomamos:
 *   - Disponible (mercado de contado Rosario, ej "SOJ Disponible" →
 *     SOJ.ROS/DIS26): el precio que el productor entiende como "pizarra".
 *   - Los 2 futuros más cercanos ("SOJ Dolar MATba" → SOJ.ROS/JUL26...) como
 *     referencia forward.
 * Precios en USD/tn (convención del bot: USD nunca con "$").
 *
 * Cache en memoria 30 min — los settlements cambian una vez por rueda; no
 * tiene sentido pegarle a la API por cada consulta. Fallo de red/API → null
 * (el handler responde "no pude consultar la pizarra"), nunca rompe el flujo.
 */

import { getTodayISO } from '../utils/date.js';

export interface GrainFuture {
  position: string;   // "JUL26"
  priceUsd: number;   // settlement
}

export interface GrainQuote {
  crop: 'soja' | 'maíz' | 'trigo';
  spotUsd: number | null;   // Disponible (settlement)
  spotDate: string | null;  // "2026-07-03"
  futures: GrainFuture[];   // los 2 más cercanos
}

export interface GrainBoard {
  quotes: GrainQuote[];
  fetchedAt: number;
}

const API_BASE = 'https://apicem.matbarofex.com.ar/api/v2';
const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

const PRODUCTS: Array<{ crop: GrainQuote['crop']; disponible: string; futures: string }> = [
  { crop: 'soja', disponible: 'SOJ Disponible', futures: 'SOJ Dolar MATba' },
  { crop: 'maíz', disponible: 'MAI Disponible', futures: 'MAI Dolar MATba' },
  { crop: 'trigo', disponible: 'TRI Disponible', futures: 'TRI Dolar MATba' },
];

// Orden de vencimientos para parsear "JUL26" del símbolo "SOJ.ROS/JUL26".
const MONTHS: Record<string, number> = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6,
  JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12,
};

interface ClosingRow {
  dateTime: string;
  symbol: string;
  settlement: number | null;
}

function maturityKey(position: string): number | null {
  const m = position.match(/^([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const month = MONTHS[m[1]];
  if (!month) return null;
  return (2000 + Number(m[2])) * 100 + month;
}

export class GrainPriceService {
  private cache: GrainBoard | null = null;

  constructor(private fetchFn: typeof fetch = fetch) {}

  /** Pizarra completa (soja/maíz/trigo). null si la API no respondió nada útil. */
  async getBoard(): Promise<GrainBoard | null> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache;

    const quotes = await Promise.all(PRODUCTS.map(p => this.buildQuote(p)));
    const useful = quotes.filter((q): q is GrainQuote => q !== null && (q.spotUsd != null || q.futures.length > 0));
    if (useful.length === 0) return this.cache; // API caída: devolver cache viejo si hay

    const board: GrainBoard = { quotes: useful, fetchedAt: Date.now() };
    this.cache = board;
    return board;
  }

  private async buildQuote(p: { crop: GrainQuote['crop']; disponible: string; futures: string }): Promise<GrainQuote | null> {
    const [spotRows, futRows] = await Promise.all([
      this.fetchClosing(p.disponible),
      this.fetchClosing(p.futures),
    ]);
    if (spotRows === null && futRows === null) return null;

    // Disponible: la fila más reciente con settlement válido
    let spotUsd: number | null = null;
    let spotDate: string | null = null;
    for (const r of (spotRows ?? [])) {
      if (r.settlement == null || r.settlement <= 0) continue;
      const d = r.dateTime.slice(0, 10);
      if (spotDate === null || d > spotDate) { spotDate = d; spotUsd = r.settlement; }
    }

    // Futuros: última fila por símbolo → ordenar por vencimiento → 2 más cercanos
    const bySymbol = new Map<string, ClosingRow>();
    for (const r of (futRows ?? [])) {
      if (r.settlement == null || r.settlement <= 0) continue;
      const prev = bySymbol.get(r.symbol);
      if (!prev || r.dateTime > prev.dateTime) bySymbol.set(r.symbol, r);
    }
    const futures: GrainFuture[] = [...bySymbol.values()]
      .map(r => ({ position: r.symbol.split('/')[1] ?? r.symbol, priceUsd: r.settlement as number }))
      .filter(f => maturityKey(f.position) !== null)
      .sort((a, b) => (maturityKey(a.position)! - maturityKey(b.position)!))
      .slice(0, 2);

    return { crop: p.crop, spotUsd, spotDate, futures };
  }

  private async fetchClosing(product: string): Promise<ClosingRow[] | null> {
    const to = getTodayISO();
    const from = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const url = `${API_BASE}/closing-prices?product=${encodeURIComponent(product)}&from=${from}&to=${to}&pageSize=300`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const resp = await this.fetchFn(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const body = await resp.json() as { data?: ClosingRow[] };
      return Array.isArray(body.data) ? body.data : null;
    } catch {
      return null;
    }
  }
}

const CROP_EMOJI: Record<GrainQuote['crop'], string> = { soja: '🫘', 'maíz': '🌽', trigo: '🌾' };

function fmtDateAR(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
}

function fmtUsd(n: number): string {
  return n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

/** Normaliza el crop pedido a los soportados; null = pizarra completa. */
export function normalizeGrainCrop(raw: string | null | undefined): GrainQuote['crop'] | 'unsupported' | null {
  if (!raw) return null;
  const t = String(raw).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/soja|soy/.test(t)) return 'soja';
  if (/maiz|corn/.test(t)) return 'maíz';
  if (/trigo|wheat/.test(t)) return 'trigo';
  if (/girasol|sorgo|cebada|avena|centeno|algodon/.test(t)) return 'unsupported';
  return null;
}

/** Mensaje user-facing de la pizarra (completa o de un grano). */
export function formatGrainBoard(board: GrainBoard, crop: GrainQuote['crop'] | null = null): string {
  const quotes = crop ? board.quotes.filter(q => q.crop === crop) : board.quotes;
  if (quotes.length === 0) {
    return `No tengo cotización de ${crop ?? 'ese grano'} por ahora. Tengo: soja, maíz y trigo — pedime *pizarra*.`;
  }
  const lines: string[] = ['🌾 *Pizarra de granos* — Rosario (Matba-Rofex)', ''];
  for (const q of quotes) {
    const emoji = CROP_EMOJI[q.crop];
    const name = q.crop.charAt(0).toUpperCase() + q.crop.slice(1);
    if (q.spotUsd != null) {
      lines.push(`${emoji} *${name}*: ${fmtUsd(q.spotUsd)} USD/tn (disponible${q.spotDate ? ` ${fmtDateAR(q.spotDate)}` : ''})`);
    } else {
      lines.push(`${emoji} *${name}*: sin disponible`);
    }
    if (q.futures.length > 0) {
      lines.push(`   Futuros: ${q.futures.map(f => `${f.position} ${fmtUsd(f.priceUsd)}`).join(' · ')}`);
    }
  }
  lines.push('');
  lines.push('_Precios orientativos, en USD por tonelada._');
  return lines.join('\n');
}
