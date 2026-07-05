/**
 * document-pipeline — procesamiento de documentos (facturas/remitos) compartido
 * entre telegram y whatsapp. Antes cada controller duplicaba estos ~350 LOC
 * (processDocumentWithIntentTg/Wa, saveDocExpensesTg/Wa, loadRemitoStockTg/Wa
 * y los 7 branches de callbacks doc_*) — idénticos salvo la función de descarga
 * de media y el label del canal.
 *
 * El controller provee solo `downloadFile(mediaId)` vía makeDocCallbackHandler.
 */

import { logError } from './error-logger.js';
import { DocumentService, DocumentError } from '../domain/documents/document.service.js';
import type { DocumentUploadIntent } from '../middleware/pending-document-upload.js';
import type { PendingDocumentAction } from '../middleware/pending-documents.js';
import { formatExtractionSummary, buildSuggestedExpenses, buildPostExtractionButtons } from '../domain/documents/document.helpers.js';
import type { UserId } from '../types/index.js';
import {
  interactiveButtons,
  financialService,
  featureGate,
  conversationLogger,
  pendingDocumentStore,
  pendingDocUploadStore,
} from './message-pipeline.js';
import type { BotResponseItem, ChannelContext } from './message-pipeline.js';

export const documentService = new DocumentService();

export type DownloadFileFn = (mediaId: string) => Promise<Buffer>;

/**
 * Resolve field/plot for document expense saving.
 * Returns { fieldId, plotId } if auto-resolved, or { plots } if user must pick.
 */
export async function resolveDocPlot(userId: UserId): Promise<
  | { resolved: true; fieldId: number; plotId: number }
  | { resolved: false; plots: Array<{ id: number; name: string; field_name: string }> }
  | { resolved: true; fieldId: null; plotId: null }
> {
  const allPlots = await financialService.findAllUserPlots(userId);
  if (allPlots.length === 0) return { resolved: true, fieldId: null, plotId: null };
  if (allPlots.length === 1) {
    const p = allPlots[0] as unknown as { id: number; field_id: number };
    return { resolved: true, fieldId: p.field_id, plotId: p.id };
  }
  // Check recent financial context
  const recent = await financialService.getRecentFinancialContext(userId);
  if (recent?.plotId) return { resolved: true, fieldId: recent.fieldId, plotId: recent.plotId };
  // Multiple plots, no recent context → user must pick
  return { resolved: false, plots: allPlots };
}

/** OCR + extracción + botones post-extracción. */
export async function processDocumentWithIntent(
  ctx: ChannelContext, buffer: Buffer, mediaMime: string,
  filename: string | undefined, caption: string, docIntent: DocumentUploadIntent | undefined,
): Promise<BotResponseItem[]> {
  const { userId, phone, startTime } = ctx;
  // Phase 3 — block OCR for trial-expired users (Vision API costs real money).
  const { getUserAccessMode, trialExpiredCopy } = await import('./access-gate.service.js');
  if (await getUserAccessMode(Number(userId)) === 'trial_expired_readonly') {
    console.log(`[TRIAL_EXPIRED] user=${userId} channel=document source=${ctx.channel}`);
    return [{ type: 'text', text: await trialExpiredCopy() }];
  }
  const { document: doc, extraction, isExisting } = await documentService.processDocument(
    userId, buffer, mediaMime, filename, ctx.channel, caption,
  );

  if (isExisting) {
    return [{ type: 'text', text: `📄 Este documento ya fue procesado (#${doc.id}).` }];
  }

  const summary = formatExtractionSummary(extraction, doc.id, doc.document_type || 'otro');
  const items: BotResponseItem[] = [{ type: 'text', text: summary }];

  const hasStock = await featureGate.hasFeature(userId, 'stock');
  const buttonConfig = buildPostExtractionButtons(extraction, doc.id, docIntent, hasStock);

  if (buttonConfig) {
    const suggestedExpenses = buildSuggestedExpenses(extraction);
    pendingDocumentStore.set(phone, {
      documentId: doc.id,
      extraction,
      suggestedExpenses,
      timestamp: Date.now(),
    });
    items.push(interactiveButtons(buttonConfig.body, buttonConfig.buttons));
  }

  conversationLogger.log(userId, phone, `[document:${mediaMime}]`, summary.slice(0, 200), 'command', 'process_document', null, null, true, Date.now() - startTime, true, null, null, null, ctx.channel).catch(() => {});
  return items;
}

/** Save document expenses, then check for product discovery (missing products in stock). */
export async function saveDocExpenses(
  ctx: ChannelContext, pending: PendingDocumentAction,
  fieldId: number | null, plotId: number | null,
): Promise<BotResponseItem[]> {
  const { userId, phone } = ctx;
  const { saveExpense } = await import('./expenses.js');
  const { formatMoney } = await import('../utils/format-money.js');
  const messages: string[] = [];
  let firstExpenseId: number | null = null;
  for (const exp of pending.suggestedExpenses) {
    const saved = await saveExpense(userId, {
      amount: exp.amount!,
      category: exp.category || 'Otros',
      description: exp.description || 'Factura procesada',
      currency: exp.currency || 'ARS',
      expenseDate: exp.expenseDate || null,
      expenseType: exp.expenseType || 'varios',
      product: exp.product || null,
      quantity: exp.quantity || null,
      unit: exp.unit || null,
    }, fieldId, plotId);
    if (!firstExpenseId && saved?.id) firstExpenseId = saved.id;
    messages.push(`✅ Gasto registrado: ${formatMoney(Number(exp.amount), exp.currency || 'ARS')} - ${exp.description}`);
  }
  if (firstExpenseId) {
    await documentService.linkToExpense(pending.documentId, firstExpenseId, userId).catch(() => {});
  }
  const items: BotResponseItem[] = [{ type: 'text', text: messages.join('\n') }];

  // Product discovery: check if any line item products are missing from stock
  try {
    const lineItems = pending.extraction.line_items;
    if (lineItems && lineItems.length > 0) {
      const { StockService } = await import('../domain/stock/stock.service.js');
      const stockService = new StockService();
      const hasStock = await featureGate.hasFeature(userId, 'stock');
      if (hasStock) {
        const products = lineItems.map(li => ({ name: li.product, unit: li.unit, category: li.category }));
        const missing = await stockService.findMissingProducts(userId, products);
        if (missing.length > 0) {
          pending.missingProducts = missing;
          pendingDocumentStore.set(phone, pending);
          const names = missing.map(p => p.name).join(', ');
          items.push(interactiveButtons(
            `Encontré ${missing.length} producto${missing.length > 1 ? 's' : ''} que no está${missing.length > 1 ? 'n' : ''} en tu stock: *${names}*. ¿Querés darlos de alta?`,
            [
              { id: `doc_create_products_yes_${pending.documentId}`, title: 'Sí, crear' },
              { id: `doc_create_products_no_${pending.documentId}`, title: 'No' },
            ],
          ));
          return items;
        }
      }
    }
  } catch {
    // Product discovery is best-effort, don't fail the expense save
  }

  pendingDocumentStore.clear(phone);
  return items;
}

/** Load remito line items into stock (optionally into a specific warehouse). */
export async function loadRemitoStock(
  ctx: ChannelContext, pending: PendingDocumentAction,
  stockService: import('../domain/stock/stock.service.js').StockService,
  warehouseId?: number,
): Promise<BotResponseItem[]> {
  const { userId, phone } = ctx;
  const messages: string[] = [];
  for (const item of pending.extraction.line_items!) {
    try {
      if (warehouseId) {
        const { item: stockItem } = await stockService.addStockToWarehouse(
          userId, warehouseId, item.product, item.category || 'otros',
          item.quantity || 1, item.unit || 'u',
          `Remito ${pending.extraction.supplier || ''}`.trim(),
        );
        messages.push(`📦 +${item.quantity || 1}${item.unit || 'u'} de ${stockItem.name} (${stockItem.current_quantity}${stockItem.unit} total)`);
      } else {
        const { item: stockItem } = await stockService.addStock(userId, item.product, item.quantity || 1, item.unit || 'u', {
          category: item.category || 'otros',
          reason: `Remito ${pending.extraction.supplier || ''}`.trim(),
        });
        messages.push(`📦 +${item.quantity || 1}${item.unit || 'u'} de ${stockItem.name} (${stockItem.current_quantity}${stockItem.unit} total)`);
      }
    } catch {
      messages.push(`⚠️ No pude cargar ${item.product} al stock`);
    }
  }
  pendingDocumentStore.clear(phone);
  return [{ type: 'text', text: messages.join('\n') }];
}

/**
 * Fabrica el hook `handleDocCallback` para el pipeline: los 7 branches doc_*
 * (upload intent, classify, stock, warehouse, product discovery, expense, plot).
 * Devuelve null cuando el callback no es de documentos.
 */
export function makeDocCallbackHandler(downloadFile: DownloadFileFn) {
  return async function handleDocCallback(callbackId: string, ctx: ChannelContext): Promise<BotResponseItem[] | null> {
    const { userId, phone } = ctx;

    // --- Document upload intent (menu entry) ---
    if (callbackId === 'doc_upload_factura' || callbackId === 'doc_upload_remito') {
      const docType = callbackId === 'doc_upload_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
      const hasDocuments = await featureGate.hasFeature(userId, 'documents');
      if (!hasDocuments) {
        return [{ type: 'text', text: '🔒 El procesamiento de documentos no está disponible en tu plan actual.\n\nEscribí *plan* para ver las opciones.' }];
      }
      const label = docType === 'factura' ? '🧾 factura' : '📋 remito';
      pendingDocUploadStore.set(phone, { intent: docType, timestamp: Date.now() });
      return [{ type: 'text', text: `Enviame la foto o PDF del ${label} y lo proceso.` }];
    }

    // --- Document classify callback (unprompted image → user chose type) ---
    if (callbackId === 'doc_classify_factura' || callbackId === 'doc_classify_remito' || callbackId === 'doc_classify_skip') {
      const pendingUpload = pendingDocUploadStore.get(phone);
      pendingDocUploadStore.clear(phone);

      if (callbackId === 'doc_classify_skip') {
        return [{ type: 'text', text: '👌 Imagen ignorada.' }];
      }

      if (!pendingUpload?.mediaRef) {
        return [{ type: 'text', text: '⚠️ La imagen expiró. Enviala de nuevo.' }];
      }

      const docType = callbackId === 'doc_classify_factura' ? 'factura' : 'remito' as DocumentUploadIntent;
      try {
        const buffer = await downloadFile(pendingUpload.mediaRef.mediaId);
        const items: BotResponseItem[] = [{ type: 'text', text: '🔍 Procesando documento...' }];
        const result = await processDocumentWithIntent(
          ctx, buffer, pendingUpload.mediaRef.mimeType,
          pendingUpload.mediaRef.filename, pendingUpload.mediaRef.caption || '',
          docType,
        );
        items.push(...result);
        return items;
      } catch (err: unknown) {
        const error = err as Error;
        console.error(`[${ctx.channel}] doc classify error:`, error.message);
        logError(ctx.channel, 'DOC_CLASSIFY_CALLBACK', error, { userId });
        if (err instanceof DocumentError) {
          return [{ type: 'text', text: `⚠️ ${error.message}` }];
        }
        return [{ type: 'text', text: 'No pude procesar el documento. Intentá con otra imagen o PDF.' }];
      }
    }

    // --- Document stock-only callback (remito → warehouse selection) ---
    if (callbackId.startsWith('doc_stock_yes_')) {
      try {
        const pending = pendingDocumentStore.get(phone);
        if (!pending || !pending.extraction.line_items || pending.extraction.line_items.length === 0) {
          return [{ type: 'text', text: '⚠️ No hay items para cargar al stock.' }];
        }
        const { StockService } = await import('../domain/stock/stock.service.js');
        const stockService = new StockService();
        const warehouses = await stockService.listWarehouses(userId);
        if (warehouses.length <= 1) {
          // 0 or 1 warehouse → auto-resolve and load
          return await loadRemitoStock(ctx, pending, stockService);
        }
        // Multiple warehouses → ask user to pick
        const buttons = warehouses.slice(0, 3).map(w => ({
          id: `doc_warehouse_${w.id}_${pending.documentId}`,
          title: `${w.name} (${w.field_name || ''})`.slice(0, 20),
        }));
        return [interactiveButtons('¿En qué galpón cargamos el stock?', buttons)];
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Error al cargar stock';
        return [{ type: 'text', text: `❌ ${msg}` }];
      }
    }

    // --- Document warehouse selection callback (remito → specific warehouse) ---
    if (callbackId.startsWith('doc_warehouse_')) {
      const match = callbackId.match(/^doc_warehouse_(\d+)_(\d+)$/);
      if (match) {
        const warehouseId = parseInt(match[1], 10);
        try {
          const pending = pendingDocumentStore.get(phone);
          if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
          const { StockService } = await import('../domain/stock/stock.service.js');
          const stockService = new StockService();
          return await loadRemitoStock(ctx, pending, stockService, warehouseId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Error al cargar stock';
          return [{ type: 'text', text: `❌ ${msg}` }];
        }
      }
    }

    // --- Document product discovery callbacks ---
    if (callbackId.startsWith('doc_create_products_yes_') || callbackId.startsWith('doc_create_products_no_')) {
      const accepted = callbackId.startsWith('doc_create_products_yes_');
      if (accepted) {
        try {
          const pending = pendingDocumentStore.get(phone);
          if (!pending?.missingProducts || pending.missingProducts.length === 0) {
            pendingDocumentStore.clear(phone);
            return [{ type: 'text', text: '⚠️ No hay productos pendientes.' }];
          }
          const { StockService } = await import('../domain/stock/stock.service.js');
          const stockService = new StockService();
          const warehouse = await stockService.resolveWarehouse(userId);
          const messages: string[] = [];
          for (const p of pending.missingProducts) {
            try {
              await stockService.createProductOnly(userId, warehouse.id, p.name, p.category || 'otros', p.unit || 'u');
              messages.push(`📋 Producto creado: *${p.name}* (${p.unit || 'u'}) - qty 0`);
            } catch {
              messages.push(`⚠️ No pude crear ${p.name}`);
            }
          }
          pendingDocumentStore.clear(phone);
          return [{ type: 'text', text: messages.join('\n') }];
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Error al crear productos';
          pendingDocumentStore.clear(phone);
          return [{ type: 'text', text: `❌ ${msg}` }];
        }
      }
      pendingDocumentStore.clear(phone);
      return [{ type: 'text', text: '👌 OK, no se crearon productos en el stock.' }];
    }

    // --- Document expense callback ---
    if (callbackId.startsWith('doc_expense_yes_') || callbackId.startsWith('doc_expense_no_')) {
      const accepted = callbackId.startsWith('doc_expense_yes_');
      if (accepted) {
        try {
          const pending = pendingDocumentStore.get(phone);
          if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
          // Resolve plot before saving
          const plotRes = await resolveDocPlot(userId);
          if (!plotRes.resolved) {
            pending.deferredAction = 'expense';
            pendingDocumentStore.set(phone, pending);
            const buttons = plotRes.plots.slice(0, 3).map(p => ({
              id: `doc_plot_${p.id}`,
              title: `${p.name} (${p.field_name})`.slice(0, 20),
            }));
            return [interactiveButtons('¿En qué lote registramos los gastos?', buttons)];
          }
          return await saveDocExpenses(ctx, pending, plotRes.fieldId, plotRes.plotId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Error al registrar gasto';
          return [{ type: 'text', text: `❌ ${msg}` }];
        }
      }
      pendingDocumentStore.clear(phone);
      return [{ type: 'text', text: '👌 Documento guardado sin registrar gasto.' }];
    }

    // --- Document plot selection callback (deferred expense saving) ---
    if (callbackId.startsWith('doc_plot_')) {
      const plotId = parseInt(callbackId.replace('doc_plot_', ''), 10);
      if (!isNaN(plotId)) {
        try {
          const pending = pendingDocumentStore.get(phone);
          if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
          const allPlots = await financialService.findAllUserPlots(userId);
          const plot = allPlots.find((p: { id: number }) => p.id === plotId) as { field_id?: number } | undefined;
          const fieldId = plot?.field_id ?? null;
          return await saveDocExpenses(ctx, pending, fieldId, plotId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Error al registrar';
          return [{ type: 'text', text: `❌ ${msg}` }];
        }
      }
    }

    return null; // no es un callback de documentos → pipeline común
  };
}
