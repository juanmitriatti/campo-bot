import type { DocumentExtraction, ParsedExpense, Currency } from '../../types/index.js';
import type { DocumentUploadIntent } from '../../middleware/pending-document-upload.js';
import { formatMoney } from '../../utils/format-money.js';

const TYPE_LABELS: Record<string, string> = {
  factura: '🧾 Factura',
  remito: '📋 Remito',
  ticket: '🎫 Ticket',
  otro: '📄 Documento',
};

export function formatExtractionSummary(extraction: DocumentExtraction, docId: number, documentType: string): string {
  const parts: string[] = [];
  const typeLabel = TYPE_LABELS[documentType] || TYPE_LABELS.otro;

  const procesado = documentType === 'factura' ? 'procesada' : 'procesado';
  parts.push(`${typeLabel} ${procesado} (#${docId})`);

  if (extraction.supplier) parts.push(`*Proveedor:* ${extraction.supplier}`);
  if (extraction.document_number) parts.push(`*Nº:* ${extraction.document_number}`);
  if (extraction.date) {
    const [y, m, d] = extraction.date.split('-');
    parts.push(`*Fecha:* ${d}/${m}/${y}`);
  }

  if (extraction.line_items && extraction.line_items.length > 0) {
    parts.push('');
    parts.push('*Detalle:*');
    const curr = extraction.currency || 'ARS';
    for (const item of extraction.line_items) {
      const qty = item.quantity ? `${item.quantity}${item.unit ? ' ' + item.unit : ''}` : '';
      const price = item.total ? ` - ${formatMoney(item.total, curr)}` : '';
      parts.push(`  • ${item.product}${qty ? ' (' + qty + ')' : ''}${price}`);
    }
  }

  if (extraction.total_amount) {
    const curr = extraction.currency || 'ARS';
    parts.push('');
    parts.push(`*Total: ${formatMoney(extraction.total_amount, curr)}*`);
  }

  if (extraction.tax_amount) {
    parts.push(`_IVA: ${formatMoney(extraction.tax_amount, extraction.currency || 'ARS')}_`);
  }

  if (!extraction.total_amount && extraction.raw_text_summary) {
    parts.push('');
    parts.push(`_${extraction.raw_text_summary.slice(0, 200)}_`);
  }

  return parts.join('\n');
}

export function buildSuggestedExpenses(extraction: DocumentExtraction): Array<Partial<ParsedExpense> & { field?: string; plot?: string }> {
  const currency: Currency = extraction.currency || 'ARS';

  // If line items exist, create one expense per item
  if (extraction.line_items && extraction.line_items.length > 0) {
    return extraction.line_items
      .filter(item => item.total && item.total > 0)
      .map(item => ({
        type: 'expense' as const,
        amount: item.total!,
        category: mapCategory(item.category),
        description: `${item.product}${extraction.supplier ? ' - ' + extraction.supplier : ''}`,
        currency,
        expenseDate: extraction.date || undefined,
        product: item.product,
        quantity: item.quantity || undefined,
        unit: item.unit || undefined,
        expenseType: isInsumoCategory(item.category) ? 'insumo' as const : 'varios' as const,
      }));
  }

  // Fallback: single expense from total
  if (extraction.total_amount && extraction.total_amount > 0) {
    return [{
      type: 'expense' as const,
      amount: extraction.total_amount,
      category: 'Otros',
      description: extraction.supplier ? `Factura ${extraction.supplier}` : 'Factura procesada',
      currency,
      expenseDate: extraction.date || undefined,
    }];
  }

  return [];
}

function mapCategory(raw?: string): string {
  if (!raw) return 'Otros';
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (lower.includes('agroquimico') || lower.includes('herbicida') || lower.includes('insecticida') || lower.includes('fungicida')) return 'Agroquímicos';
  if (lower.includes('fertilizante')) return 'Fertilizantes';
  if (lower.includes('semilla')) return 'Semillas';
  if (lower.includes('combustible') || lower.includes('gasoil') || lower.includes('nafta')) return 'Combustible';
  if (lower.includes('repuesto')) return 'Repuestos';
  if (lower.includes('servicio')) return 'Servicios';
  return 'Otros';
}

export function isInsumoCategory(raw?: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return ['agroquimicos', 'fertilizantes', 'semillas', 'combustible'].some(c => lower.includes(c));
}

/**
 * Build smart post-extraction action buttons based on document content and context.
 * Returns null if no actionable buttons can be offered.
 */
export function buildPostExtractionButtons(
  extraction: DocumentExtraction,
  docId: number,
  docIntent: DocumentUploadIntent | undefined,
  hasStockFeature: boolean,
): { body: string; buttons: Array<{ id: string; title: string }> } | null {
  const hasAmount = !!(extraction.total_amount && extraction.total_amount > 0);
  const hasLineItems = !!(extraction.line_items && extraction.line_items.length > 0);

  // Case 1: Factura with amount → Registrar gasto / Solo guardar (never stock)
  // Remito with amount should NOT show "Registrar gasto"
  if (hasAmount && docIntent !== 'remito') {
    return {
      body: '¿Querés registrar esto como gasto?',
      buttons: [
        { id: `doc_expense_yes_${docId}`, title: 'Registrar gasto' },
        { id: `doc_expense_no_${docId}`, title: 'Solo guardar' },
      ],
    };
  }

  // Case 2: Remito with line items + stock feature → Cargar stock / Solo guardar
  if (docIntent === 'remito' && hasLineItems && hasStockFeature) {
    return {
      body: '¿Querés cargar estos items al stock?',
      buttons: [
        { id: `doc_stock_yes_${docId}`, title: 'Cargar stock' },
        { id: `doc_expense_no_${docId}`, title: 'Solo guardar' },
      ],
    };
  }

  // No structured data or remito without stock feature → no buttons
  return null;
}
