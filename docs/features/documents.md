# Document Processing System

Feature-gated with daily limits per plan: free=1, pro=10, pro_plus=25, enterprise=100.

## Code (`src/domain/documents/`)

- **DocumentRepository** — DB CRUD
- **DocumentService** — Validate → hash dedup → compress (sharp) → store to disk → Claude Vision extraction → classify
- **DocumentHandler** — `list_documents`, `link_document_to_expense`
- **document.helpers** — `formatExtractionSummary`, `buildSuggestedExpenses`, `buildPostExtractionButtons`, `isInsumoCategory`

Files stored at `$DOCUMENT_STORAGE_PATH/{userId}/{date}/{docId}.{ext}`.

## Factura vs Remito Flows

| Type | Purpose | Post-extraction | Stock interaction |
|------|---------|-----------------|-------------------|
| **Factura** | Expenses ONLY | "Registrar gasto" / "Solo guardar" | Never updates stock. Offers product discovery after save. |
| **Remito** | Stock ONLY | "Cargar stock" / "Solo guardar" | Never creates expenses. Asks which warehouse if multiple. |

## UX Flow

1. Menu entries ("Cargar Factura"/"Cargar Remito") or text triggers set intent
2. User sends image → Claude Vision extracts data
3. Post-extraction buttons presented based on document type
4. Unprompted images prompt for intent first

**`PendingDocumentUploadStore`** (`src/middleware/pending-document-upload.ts`) tracks two states:
- Intent-waiting-for-image (user said "cargar factura", waiting for photo)
- Image-waiting-for-intent (user sent photo without context)
- 5-minute TTL

## Post-Save Flows

### Factura → Product Discovery
After expense save, `StockService.findMissingProducts()` checks which line item products don't exist in stock → offers to create them (qty=0, no movement) via `createProductOnly()`.

### Remito → Warehouse Selection
- 0/1 warehouses: auto-resolve
- Multiple warehouses: buttons per warehouse
- `addStockToWarehouse()` loads items into specific warehouse

### Plot Resolution
Expenses from documents resolve field/plot before saving:
- Auto-assign if 1 plot or recent context
- Ask user if multiple plots

## AI Tools (3)

`upload_document`, `list_documents`, `link_document_to_expense`
