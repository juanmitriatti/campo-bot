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
  // Varios lotes: se PREGUNTA. Antes la factura iba sola al lote del último
  // registro, sin mostrarlo (STK-17). El lote reciente va primero en los botones.
  const recent = await financialService.getRecentFinancialContext(userId);
  const plots = [...allPlots].sort((a, b) =>
    Number((b as { id: number }).id === recent?.plotId) - Number((a as { id: number }).id === recent?.plotId));
  return { resolved: false, plots };
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
    // Un solo documento pendiente por usuario: si llegan dos fotos juntas, el
    // anterior se reemplaza — avisarlo en vez de perderlo en silencio (STK-19).
    const previous = pendingDocumentStore.get(phone);
    if (previous && previous.documentId !== doc.id && !previous.expensesSaved) {
      console.log(`[INTERCEPT] documento ${previous.documentId} reemplazado por ${doc.id} sin confirmar: user=${userId}`);
      items.unshift({ type: 'text', text: `ℹ️ El documento #${previous.documentId} quedó guardado sin registrar el gasto: llegó este otro. Mandalos de a uno para registrar cada uno.` });
    }
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
  if (pending.expensesSaved) {
    console.log(`[INTERCEPT] doc expense ya guardado (doble tap): user=${userId} doc=${pending.documentId}`);
    return [{ type: 'text', text: '✅ Los gastos de este documento ya estaban registrados.' }];
  }
  if (pending.suggestedExpenses.length === 0) {
    // Nunca una respuesta vacía (STK-7).
    pendingDocumentStore.clear(phone);
    return [{ type: 'text', text: '⚠️ No encontré montos en el documento para registrar como gasto. Quedó guardado; cargá el gasto escribiéndolo (ej: "gasté 150 mil en semillas").' }];
  }
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
  pending.expensesSaved = true;
  pendingDocumentStore.set(phone, pending);
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
    // Sin cantidad no se inventa "1 u" (STK-16): se informa y se sigue.
    if (!item.quantity || !(Number(item.quantity) > 0)) {
      messages.push(`⚠️ ${item.product}: sin cantidad en el remito, no lo cargué`);
      continue;
    }
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'error';
      console.warn(`[INTERCEPT] remito → stock falló: ${item.product}: ${reason}`);
      messages.push(`⚠️ No pude cargar ${item.product} al stock: ${reason}`);
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
        if (pending && !sameDocument(callbackId, pending.documentId, userId)) return [otherDocReply];
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
          // El galpón y el documento vienen en el id del botón: un botón de otro
          // documento, o armado a mano con el galpón de otro usuario, sumaba
          // stock ahí (auditoría oct 2026, AIS-3).
          if (String(pending.documentId) !== match[2]) {
            console.log(`[INTERCEPT] doc_warehouse de otro documento: user=${userId} botón=${match[2]} pendiente=${pending.documentId}`);
            return [{ type: 'text', text: '⏰ Ese botón era de otro documento. No cargué nada.' }];
          }
          const { findInaccessibleLocation } = await import('../domain/shared/field-access.js');
          if (await findInaccessibleLocation(Number(userId), { warehouseId })) {
            console.log(`[INTERCEPT] doc_warehouse con galpón ajeno: user=${userId} warehouse=${warehouseId}`);
            return [{ type: 'text', text: '⚠️ No encontré ese galpón. No cargué nada.' }];
          }
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
          if (pending && !sameDocument(callbackId, pending.documentId, userId)) return [otherDocReply];
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
          if (!sameDocument(callbackId, pending.documentId, userId)) return [otherDocReply];
          // Resolve plot before saving
          const plotRes = await resolveDocPlot(userId);
          if (!plotRes.resolved) {
            pending.deferredAction = 'expense';
            pendingDocumentStore.set(phone, pending);
            const buttons = plotRes.plots.slice(0, 3).map(p => ({
              id: `doc_plot_${p.id}_${pending.documentId}`,
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
      const pendingNo = pendingDocumentStore.get(phone);
      if (pendingNo && !sameDocument(callbackId, pendingNo.documentId, userId)) return [otherDocReply];
      pendingDocumentStore.clear(phone);
      return [{ type: 'text', text: '👌 Documento guardado sin registrar gasto.' }];
    }

    // --- Document plot selection callback (deferred expense saving) ---
    if (callbackId.startsWith('doc_plot_')) {
      const plotMatch = callbackId.match(/^doc_plot_(\d+)(?:_(\d+))?$/);
      const plotId = plotMatch ? parseInt(plotMatch[1], 10) : NaN;
      if (!isNaN(plotId)) {
        try {
          const pending = pendingDocumentStore.get(phone);
          if (!pending) return [{ type: 'text', text: '⚠️ No hay documento pendiente.' }];
          if (plotMatch?.[2] && plotMatch[2] !== String(pending.documentId)) {
            console.log(`[INTERCEPT] doc_plot de otro documento: user=${userId} botón=${plotMatch[2]} pendiente=${pending.documentId}`);
            return [otherDocReply];
          }
          const allPlots = await financialService.findAllUserPlots(userId);
          const plot = allPlots.find((p: { id: number }) => Number(p.id) === plotId) as { field_id?: number } | undefined;
          // Un lote que no está entre los del usuario no se usa: antes se
          // guardaba el gasto con el plot_id crudo del botón (AIS-4).
          if (!plot) {
            console.log(`[INTERCEPT] doc_plot con lote ajeno o inexistente: user=${userId} plot=${plotId}`);
            return [{ type: 'text', text: '⚠️ No encontré ese lote. No registré el gasto; elegí uno de los botones de nuevo.' }];
          }
          const fieldId = plot.field_id ?? null;
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

/**
 * ¿El botón es del documento pendiente? Los ids doc_* terminan en el id del
 * documento. Con un solo pendiente por usuario, el tap del documento A guardaba
 * el B cuando llegaban dos seguidos (STK-5, auditoría oct 2026).
 */
function sameDocument(callbackId: string, pendingDocId: number, userId: UserId): boolean {
  const m = callbackId.match(/_(\d+)$/);
  if (!m || m[1] === String(pendingDocId)) return true;
  console.log(`[INTERCEPT] botón de otro documento: user=${userId} botón=${m[1]} pendiente=${pendingDocId} (${callbackId.slice(0, 30)})`);
  return false;
}

const otherDocReply: BotResponseItem = { type: 'text', text: '⏰ Ese botón era de otro documento. No registré nada: usá los botones del último que mandaste.' };
