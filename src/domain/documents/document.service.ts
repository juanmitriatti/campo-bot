import { createHash } from 'crypto';
import { mkdir, writeFile, readFile } from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { DocumentRepository } from './document.repository.js';
import { getSetting, getSettingNumber } from '../../services/settings.service.js';
import { logError } from '../../services/error-logger.js';
import { getTodayISO } from '../../utils/date.js';
import type { DocumentExtraction, DocumentRow, ParsedExpense, Currency } from '../../types/index.js';

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);

const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const STORAGE_PATH = process.env.DOCUMENT_STORAGE_PATH || '/data/documents';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export class DocumentService {
  private repo: DocumentRepository;

  constructor(repo?: DocumentRepository) {
    this.repo = repo ?? new DocumentRepository();
  }

  async checkDailyLimit(userId: number): Promise<{ allowed: boolean; current: number; limit: number }> {
    const [current, limit] = await Promise.all([
      this.repo.getDailyDocumentCount(userId),
      this.repo.getDocumentDailyLimit(userId),
    ]);
    return { allowed: current < limit, current, limit };
  }

  async processDocument(
    userId: number,
    buffer: Buffer,
    mimeType: string,
    filename: string | undefined,
    channel: string,
    contextText?: string,
  ): Promise<{ document: DocumentRow; extraction: DocumentExtraction; isExisting: boolean }> {
    const startTime = Date.now();

    // Validate mime type
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new DocumentError('Formato no soportado. Enviá JPG, PNG o PDF.', 400);
    }

    // Validate file size
    if (buffer.length > MAX_FILE_SIZE) {
      throw new DocumentError('El archivo es demasiado grande (máximo 10MB).', 400);
    }

    // Validate magic bytes
    this.validateMagicBytes(buffer, mimeType);

    // SHA-256 hash for dedup
    const fileHash = createHash('sha256').update(buffer).digest('hex');

    // Dedup check
    const existing = await this.repo.findByHash(userId, fileHash);
    if (existing && existing.extracted_data) {
      return { document: existing, extraction: existing.extracted_data, isExisting: true };
    }

    // Create DB record
    const doc = await this.repo.create({
      userId,
      mimeType,
      fileSizeBytes: buffer.length,
      originalFilename: filename,
      fileHash,
      sourceChannel: channel,
    });

    try {
      // Compress/sanitize image
      let processedBuffer: Buffer;
      let storedMime: string;
      let ext: string;

      if (mimeType.startsWith('image/')) {
        const sharp = (await import('sharp')).default;
        processedBuffer = await sharp(buffer)
          .resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
        storedMime = 'image/jpeg';
        ext = 'jpg';
      } else {
        // PDF: keep as-is
        processedBuffer = buffer;
        storedMime = mimeType;
        ext = 'pdf';
      }

      // Store to disk
      const dateDir = getTodayISO();
      const dirPath = path.join(STORAGE_PATH, String(userId), dateDir);
      await mkdir(dirPath, { recursive: true });
      const filePath = path.join(dirPath, `${doc.id}_compressed.${ext}`);
      await writeFile(filePath, processedBuffer);

      const compressedPath = path.relative(STORAGE_PATH, filePath);

      // Claude Vision extraction
      const extraction = await this.extractWithVision(processedBuffer, storedMime, contextText);

      // Classify document type
      const documentType = this.classifyDocumentType(extraction);

      const processingTimeMs = Date.now() - startTime;
      await this.repo.updateExtraction(doc.id, extraction, compressedPath, documentType, processingTimeMs);

      // Track usage
      await this.repo.trackUsage(userId, doc.id);

      const updatedDoc = await this.repo.findById(doc.id, userId);
      return { document: updatedDoc!, extraction, isExisting: false };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.repo.updateError(doc.id, errorMsg);
      logError('documents', 'PROCESSING_FAILED', err as Error, { userId, context: { docId: doc.id } });
      throw err;
    }
  }

  async getDocumentFile(docId: number, userId: number): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
    const doc = await this.repo.findById(docId, userId);
    if (!doc || !doc.compressed_path) return null;

    const fullPath = path.join(STORAGE_PATH, doc.compressed_path);
    try {
      const buffer = await readFile(fullPath);
      const ext = path.extname(doc.compressed_path).slice(1);
      const mime = ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
      return { buffer, mime, filename: `documento_${docId}.${ext}` };
    } catch {
      return null;
    }
  }

  async linkToExpense(docId: number, expenseId: number, userId: number): Promise<boolean> {
    return this.repo.linkToExpense(docId, expenseId, userId);
  }

  async listDocuments(userId: number, page: number, limit: number, filters?: { documentType?: string; desde?: string; hasta?: string }) {
    return this.repo.getUserDocuments(userId, page, limit, filters);
  }

  async findById(docId: number, userId: number) {
    return this.repo.findById(docId, userId);
  }

  private validateMagicBytes(buffer: Buffer, mimeType: string): void {
    const expected = MAGIC_BYTES[mimeType];
    if (!expected) return; // webp has no check in our list
    for (let i = 0; i < expected.length; i++) {
      if (buffer[i] !== expected[i]) {
        throw new DocumentError('El archivo no es válido. Verificá que sea una imagen o PDF real.', 400);
      }
    }
  }

  private async extractWithVision(
    buffer: Buffer,
    mimeType: string,
    contextText?: string,
  ): Promise<DocumentExtraction> {
    // Reusa AGENT_MODEL a propósito: no hay setting propio de modelo para
    // documentos. OJO — cambiarlo para mejorar el OCR de facturas también
    // cambia el agente conversacional. Si hace falta desacoplarlos, agregar
    // DOCUMENT_MODEL con fallback a AGENT_MODEL.
    const model = (await getSetting('AGENT_MODEL')) || 'claude-haiku-4-5-20251001';
    // Fijo, no atado a AGENT_MAX_TOKENS: la extracción devuelve un JSON con
    // todos los campos del comprobante, bastante más largo que una tool call.
    const maxTokens = 1500;

    const mediaType = mimeType === 'application/pdf' ? 'application/pdf' as const : mimeType as 'image/jpeg' | 'image/png' | 'image/webp';
    const sourceType = mimeType === 'application/pdf' ? 'base64' as const : 'base64' as const;

    const contextLine = contextText ? `\nContexto del usuario: "${contextText}"` : '';

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: mimeType === 'application/pdf' ? 'document' : 'image',
            source: { type: sourceType, media_type: mediaType, data: buffer.toString('base64') },
          } as any,
          {
            type: 'text',
            text: `Analizá esta factura/comprobante/remito agrícola argentino. Extraé los datos en JSON:
{"supplier","date" (YYYY-MM-DD),"document_number","total_amount","currency" (ARS o USD),"tax_amount","line_items":[{"product","quantity","unit","unit_price","total","category"}],"raw_text_summary"}
Categorías de line_items: Agroquímicos, Fertilizantes, Semillas, Combustible, Repuestos, Servicios, Otros.
Si no es factura/comprobante, devolvé {"raw_text_summary":"descripción breve"}.
Respondé SOLO JSON válido, sin markdown.${contextLine}`,
          },
        ],
      }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { raw_text_summary: 'No se pudo extraer información.' };
    }

    try {
      // Strip possible markdown fences
      let jsonStr = textBlock.text.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      }
      return JSON.parse(jsonStr) as DocumentExtraction;
    } catch {
      // JSON parse failed (likely truncated) — try to salvage partial data
      const raw = textBlock.text.trim();
      const partial: DocumentExtraction = {};

      // Extract top-level fields from partial JSON
      const supplierMatch = raw.match(/"supplier"\s*:\s*"([^"]+)"/);
      if (supplierMatch) partial.supplier = supplierMatch[1];

      const totalMatch = raw.match(/"total_amount"\s*:\s*([\d.]+)/);
      if (totalMatch) partial.total_amount = parseFloat(totalMatch[1]);

      const currencyMatch = raw.match(/"currency"\s*:\s*"([^"]+)"/);
      if (currencyMatch) partial.currency = currencyMatch[1] as 'ARS' | 'USD';

      const dateMatch = raw.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
      if (dateMatch) partial.date = dateMatch[1];

      const docNumMatch = raw.match(/"document_number"\s*:\s*"([^"]+)"/);
      if (docNumMatch) partial.document_number = docNumMatch[1];

      const taxMatch = raw.match(/"tax_amount"\s*:\s*([\d.]+)/);
      if (taxMatch) partial.tax_amount = parseFloat(taxMatch[1]);

      if (!partial.supplier && !partial.total_amount) {
        partial.raw_text_summary = 'No se pudo extraer la información completa del documento.';
      }

      return partial;
    }
  }

  private classifyDocumentType(extraction: DocumentExtraction): string {
    const summary = (extraction.raw_text_summary || '').toLowerCase();
    if (extraction.document_number) {
      if (summary.includes('remito')) return 'remito';
      if (summary.includes('ticket') || summary.includes('tkt')) return 'ticket';
      return 'factura';
    }
    if (extraction.total_amount && extraction.total_amount > 0) return 'factura';
    if (summary.includes('remito')) return 'remito';
    if (summary.includes('ticket')) return 'ticket';
    return 'otro';
  }
}

export class DocumentError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'DocumentError';
  }
}
