import { DocumentService } from './document.service.js';
import { formatExtractionSummary, buildSuggestedExpenses } from './document.helpers.js';
import { formatMoney } from '../../utils/format-money.js';
import type { ParsedCommand, UserId, User, UserSettings, HandlerResponse } from '../../types/index.js';

export class DocumentHandler {
  private service: DocumentService;

  constructor(service?: DocumentService) {
    this.service = service ?? new DocumentService();
  }

  async handleCommand(
    cmd: ParsedCommand,
    userId: UserId,
    _user: User,
    _settings: UserSettings,
  ): Promise<HandlerResponse> {
    switch (cmd.command) {
      case 'list_documents':
        return this.listDocuments(userId, cmd);
      case 'link_document_to_expense':
        return this.linkDocumentToExpense(userId, cmd);
      default:
        return { messages: ['Comando de documentos no reconocido.'] };
    }
  }

  private async listDocuments(userId: UserId, cmd: ParsedCommand): Promise<HandlerResponse> {
    const { rows, total } = await this.service.listDocuments(userId, 1, 10, {
      documentType: cmd.documentType as string | undefined,
    });

    if (rows.length === 0) {
      return { messages: ['No tenés documentos procesados. Enviá una foto de factura para empezar.'] };
    }

    const typeEmojis: Record<string, string> = {
      factura: '🧾', remito: '📋', ticket: '🎫', otro: '📄',
    };

    const lines = rows.map(d => {
      const emoji = typeEmojis[d.document_type] || '📄';
      const ext = d.extracted_data ?? {};
      // Tolerant key matching: support both EN (supplier/total_amount) + ES (proveedor/monto)
      const supplierRaw = ext.supplier ?? ext.proveedor ?? ext.vendor ?? ext.emisor ?? null;
      const amountRaw = ext.total_amount ?? ext.monto ?? ext.amount ?? ext.total ?? null;
      const docCurrency = ext.currency ?? ext.moneda ?? 'ARS';
      const fileName = d.original_filename ?? null;
      const supplier = supplierRaw ? ` — *${supplierRaw}*` : fileName ? ` — _${fileName}_` : '';
      const amount = amountRaw && !isNaN(Number(amountRaw)) ? ` · ${formatMoney(Number(amountRaw), docCurrency)}` : '';
      const date = new Date(d.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
      const linked = d.linked_expense_id ? ' ✅ vinculado' : '';
      return `${emoji} #${d.id}${supplier}${amount}\n   📅 ${date}${linked}`;
    });

    return {
      messages: [`📂 *Tus documentos* (${total} total)\n\n${lines.join('\n\n')}`],
    };
  }

  private async linkDocumentToExpense(userId: UserId, cmd: ParsedCommand): Promise<HandlerResponse> {
    const docId = typeof cmd.documentId === 'number' ? cmd.documentId : parseInt(String(cmd.documentId), 10);
    const expenseId = typeof cmd.expenseId === 'number' ? cmd.expenseId : parseInt(String(cmd.expenseId), 10);

    if (isNaN(docId) || isNaN(expenseId)) {
      return { messages: ['Necesito el ID del documento y del gasto. Ej: "vincular factura 5 al gasto 42"'] };
    }

    const linked = await this.service.linkToExpense(docId, expenseId, userId);
    if (!linked) {
      return { messages: ['No encontré ese documento o gasto. Verificá los IDs.'] };
    }

    return { messages: [`✅ Documento #${docId} vinculado al gasto #${expenseId}.`] };
  }
}
