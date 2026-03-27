import { pool } from '../config/db.js';
import type { UserId } from '../types/index.js';

interface ValidationResult {
  valid: boolean;
  suggestion?: string;
  alternatives?: string[];
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function normalize(text: string): string {
  return text.toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export class EntityValidator {
  async validateField(userId: UserId, fieldName: string): Promise<ValidationResult> {
    const result = await pool.query(
      'SELECT name FROM fields WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );
    const fields: string[] = result.rows.map((r: { name: string }) => r.name);

    if (fields.length === 0) {
      return { valid: true }; // No fields yet — skip validation
    }

    const normalizedInput = normalize(fieldName);

    // Exact match (case-insensitive, accent-insensitive)
    for (const f of fields) {
      if (normalize(f) === normalizedInput) return { valid: true };
    }

    // Fuzzy match (Levenshtein ≤ 2)
    for (const f of fields) {
      if (levenshtein(normalize(f), normalizedInput) <= 2) {
        return { valid: false, suggestion: f, alternatives: fields };
      }
    }

    // No match
    return { valid: false, alternatives: fields };
  }

  async getUserFieldNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      'SELECT name FROM fields WHERE user_id = $1 AND deleted_at IS NULL ORDER BY name',
      [userId]
    );
    return result.rows.map((r: { name: string }) => r.name);
  }

  async getUserPlotNames(userId: UserId): Promise<string[]> {
    const result = await pool.query(
      `SELECT p.name FROM plots p
       JOIN fields f ON p.field_id = f.id
       WHERE f.user_id = $1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL
       ORDER BY p.name`,
      [userId]
    );
    return result.rows.map((r: { name: string }) => r.name);
  }

  async getUserPlotsWithFields(userId: UserId): Promise<{ plotName: string; fieldName: string }[]> {
    const result = await pool.query(
      `SELECT p.name AS plot_name, f.name AS field_name FROM plots p
       JOIN fields f ON p.field_id = f.id
       WHERE f.user_id = $1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL
       ORDER BY f.name, p.name`,
      [userId]
    );
    return result.rows.map((r: { plot_name: string; field_name: string }) => ({
      plotName: r.plot_name,
      fieldName: r.field_name,
    }));
  }

  async validatePlot(userId: UserId, plotName: string): Promise<ValidationResult> {
    const result = await pool.query(
      `SELECT p.name FROM plots p
       JOIN fields f ON p.field_id = f.id
       WHERE f.user_id = $1 AND p.deleted_at IS NULL AND f.deleted_at IS NULL`,
      [userId]
    );
    const plots: string[] = result.rows.map((r: { name: string }) => r.name);

    if (plots.length === 0) {
      return { valid: true }; // No plots yet — skip validation
    }

    const normalizedInput = normalize(plotName);

    // Exact match
    for (const p of plots) {
      if (normalize(p) === normalizedInput) return { valid: true };
    }

    // Fuzzy match
    for (const p of plots) {
      if (levenshtein(normalize(p), normalizedInput) <= 2) {
        return { valid: false, suggestion: p, alternatives: plots };
      }
    }

    return { valid: false, alternatives: plots };
  }
}
