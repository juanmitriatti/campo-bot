import type { ActivityType, PlotCropRow } from '../../types/index.js';
import { PRODUCT_CROP_MAP, ACTIVITY_LABEL_MAP } from '../../constants/agro-terms.js';

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

const ACTIVITY_TYPE_ALIASES: Record<string, string> = {
  sow_crop: 'planting',
  harvest_crop: 'harvest',
};

export function getActivityLabel(type: string): { emoji: string; label: string } {
  return ACTIVITY_LABEL_MAP[type]
    || ACTIVITY_LABEL_MAP[type.replace(/^log_/, '')]
    || ACTIVITY_LABEL_MAP[ACTIVITY_TYPE_ALIASES[type] ?? '']
    || { emoji: '\ud83d\udccc', label: type };
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
    const dateStr = details.eventDate.toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    lines.push(`\ud83d\udcc5 ${dateStr}`);
  }

  return lines.join('\n');
}
