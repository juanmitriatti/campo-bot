import { pool } from '../../config/db.js';
import type { DocumentRow, DocumentExtraction, UserId } from '../../types/index.js';

export class DocumentRepository {
  async create(data: {
    userId: number;
    mimeType: string;
    fileSizeBytes: number;
    originalFilename?: string;
    fileHash?: string;
    sourceChannel: string;
  }): Promise<DocumentRow> {
    const result = await pool.query(
      `INSERT INTO documents (user_id, mime_type, file_size_bytes, original_filename, file_hash, source_channel)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [data.userId, data.mimeType, data.fileSizeBytes, data.originalFilename ?? null, data.fileHash ?? null, data.sourceChannel],
    );
    return result.rows[0];
  }

  async updateExtraction(
    docId: number,
    extraction: DocumentExtraction,
    compressedPath: string,
    documentType: string,
    processingTimeMs: number,
  ): Promise<void> {
    await pool.query(
      `UPDATE documents SET extracted_data = $1, compressed_path = $2, document_type = $3,
       processing_status = 'processed', processing_time_ms = $4 WHERE id = $5`,
      [JSON.stringify(extraction), compressedPath, documentType, processingTimeMs, docId],
    );
  }

  async updateError(docId: number, error: string): Promise<void> {
    await pool.query(
      `UPDATE documents SET processing_status = 'error', processing_error = $1 WHERE id = $2`,
      [error, docId],
    );
  }

  async linkToExpense(docId: number, expenseId: number, userId: number): Promise<boolean> {
    const result = await pool.query(
      `UPDATE documents SET linked_expense_id = $1 WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL RETURNING id`,
      [expenseId, docId, userId],
    );
    return result.rows.length > 0;
  }

  async findByHash(userId: number, hash: string): Promise<DocumentRow | null> {
    const result = await pool.query(
      `SELECT * FROM documents WHERE user_id = $1 AND file_hash = $2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [userId, hash],
    );
    return result.rows[0] ?? null;
  }

  async findById(docId: number, userId: number): Promise<DocumentRow | null> {
    const result = await pool.query(
      `SELECT * FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [docId, userId],
    );
    return result.rows[0] ?? null;
  }

  async getUserDocuments(
    userId: number,
    page: number,
    limit: number,
    filters?: { documentType?: string; desde?: string; hasta?: string },
  ): Promise<{ rows: DocumentRow[]; total: number }> {
    const conditions = ['user_id = $1', 'deleted_at IS NULL'];
    const params: (string | number)[] = [userId];
    let idx = 1;

    if (filters?.documentType) {
      idx++;
      conditions.push(`document_type = $${idx}`);
      params.push(filters.documentType);
    }
    if (filters?.desde) {
      idx++;
      conditions.push(`created_at >= $${idx}::date`);
      params.push(filters.desde);
    }
    if (filters?.hasta) {
      idx++;
      conditions.push(`created_at < ($${idx}::date + interval '1 day')`);
      params.push(filters.hasta);
    }

    const where = conditions.join(' AND ');

    const countResult = await pool.query(`SELECT count(*)::int FROM documents WHERE ${where}`, params);
    const total = countResult.rows[0].count;

    idx++;
    params.push(limit);
    idx++;
    params.push((page - 1) * limit);

    const result = await pool.query(
      `SELECT * FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT $${idx - 1} OFFSET $${idx}`,
      params,
    );

    return { rows: result.rows, total };
  }

  async getDailyDocumentCount(userId: number): Promise<number> {
    const result = await pool.query(
      `SELECT count(*)::int FROM document_usage WHERE user_id = $1 AND created_at >= CURRENT_DATE`,
      [userId],
    );
    return result.rows[0].count;
  }

  async trackUsage(userId: number, documentId: number): Promise<void> {
    await pool.query(
      `INSERT INTO document_usage (user_id, document_id) VALUES ($1, $2)`,
      [userId, documentId],
    );
  }

  async getDocumentDailyLimit(userId: number): Promise<number> {
    const result = await pool.query(
      `SELECT COALESCE(p.daily_document_limit, 1) AS lim
       FROM users u LEFT JOIN plans p ON u.plan_id = p.id
       WHERE u.id = $1`,
      [userId],
    );
    return result.rows[0]?.lim ?? 1;
  }
}
