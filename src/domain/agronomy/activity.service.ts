import type { ActivityType, PlotCropRow } from '../../types/index.js';

// --- Product → crop inference ---

const PRODUCT_CROP_MAP: Record<string, string> = {
  Atrazina: 'Maíz',
  Imazetapir: 'Soja',
  Cletodim: 'Soja',
  Haloxifop: 'Soja',
};

export function inferCrop(
  explicitCrop: string | null,
  activeCrop: PlotCropRow | null,
  productName: string | null,
): string | null {
  if (explicitCrop) return explicitCrop;
  if (activeCrop) return activeCrop.crop;
  if (productName && PRODUCT_CROP_MAP[productName]) return PRODUCT_CROP_MAP[productName];
  return null;
}

// --- Activity labels ---

const ACTIVITY_LABELS: Record<string, { emoji: string; label: string }> = {
  spraying: { emoji: '\ud83d\udca8', label: 'Pulverizaci\u00f3n' },
  fertilization: { emoji: '\ud83e\uddea', label: 'Fertilizaci\u00f3n' },
  tillage: { emoji: '\ud83d\ude9c', label: 'Labranza' },
  irrigation: { emoji: '\ud83d\udca7', label: 'Riego' },
  planting: { emoji: '\ud83c\udf31', label: 'Siembra' },
  harvest: { emoji: '\ud83c\udf3e', label: 'Cosecha' },
};

export function getActivityLabel(type: string): { emoji: string; label: string } {
  return ACTIVITY_LABELS[type] || { emoji: '\ud83d\udccc', label: type };
}

// --- Confirmation formatting ---

export function formatActivityConfirmation(
  type: ActivityType,
  plotLabel: string | null,
  details: {
    product?: string | null;
    productType?: string | null;
    quantity?: number | null;
    unit?: string | null;
    crop?: string | null;
    implement?: string | null;
    eventDate?: Date | null;
  },
): string {
  const { emoji, label } = getActivityLabel(type);
  const lines: string[] = [];

  lines.push(`${emoji} *${label}* registrada`);

  if (plotLabel) {
    lines.push(`\ud83d\udccd ${plotLabel}`);
  }

  if (details.product) {
    const typeLabel = details.productType ? ` (${details.productType})` : '';
    lines.push(`\ud83e\uddf4 ${details.product}${typeLabel}`);
  }

  if (details.quantity && details.unit) {
    lines.push(`\ud83d\udccf ${details.quantity} ${details.unit}`);
  }

  if (details.crop) {
    lines.push(`\ud83c\udf31 Cultivo: ${details.crop}`);
  }

  if (details.implement) {
    lines.push(`\ud83d\udee0\ufe0f ${details.implement}`);
  }

  if (details.eventDate) {
    const dateStr = details.eventDate.toLocaleDateString('es-AR');
    lines.push(`\ud83d\udcc5 ${dateStr}`);
  }

  return lines.join('\n');
}
