// Livestock (hacienda) domain types
// Mirrors the ENUMs defined in migration 053_livestock.sql

export type LivestockCategory =
  | 'vaca'
  | 'vaquillona'
  | 'ternero'
  | 'ternera'
  | 'novillo'
  | 'novillito'
  | 'toro'
  | 'torito'
  | 'buey';

export type LivestockMovementType =
  | 'entrada'
  | 'salida'
  | 'transferencia'
  | 'muerte'
  | 'nacimiento'
  | 'recategorizacion'
  | 'ajuste';

export const LIVESTOCK_CATEGORIES: LivestockCategory[] = [
  'vaca',
  'vaquillona',
  'ternero',
  'ternera',
  'novillo',
  'novillito',
  'toro',
  'torito',
  'buey',
];

/** Pretty label for a category */
export const LIVESTOCK_CATEGORY_LABEL: Record<LivestockCategory, string> = {
  vaca: 'Vaca',
  vaquillona: 'Vaquillona',
  ternero: 'Ternero',
  ternera: 'Ternera',
  novillo: 'Novillo',
  novillito: 'Novillito',
  toro: 'Toro',
  torito: 'Torito',
  buey: 'Buey',
};

/** Pretty label + emoji for a movement */
export const LIVESTOCK_MOVEMENT_LABEL: Record<LivestockMovementType, { emoji: string; label: string }> = {
  entrada: { emoji: '📥', label: 'Entrada' },
  salida: { emoji: '📤', label: 'Salida' },
  transferencia: { emoji: '🔄', label: 'Transferencia' },
  muerte: { emoji: '💀', label: 'Muerte' },
  nacimiento: { emoji: '🐣', label: 'Nacimiento' },
  recategorizacion: { emoji: '🔁', label: 'Recategorización' },
  ajuste: { emoji: '📊', label: 'Ajuste' },
};

/** Pretty labels for health event subtypes */
export const HEALTH_TYPE_LABEL: Record<string, string> = {
  vacunacion: 'Vacunación',
  desparasitacion: 'Desparasitación',
  tratamiento: 'Tratamiento',
  revision_sanitaria: 'Revisión sanitaria',
};

/** Pretty labels for reproductive event subtypes */
export const REPRO_TYPE_LABEL: Record<string, string> = {
  servicio: 'Servicio (entore)',
  destete: 'Destete',
  inseminacion: 'Inseminación artificial',
  deteccion_celo: 'Detección de celo',
};

export interface LivestockGroupRow {
  id: string;
  user_id: number;
  field_id: number;
  plot_id: number | null;
  corral_id: number | null;
  category: LivestockCategory;
  breed: string | null;
  count: number;
  avg_weight_kg: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // Joined columns (optional)
  field_name?: string;
  plot_name?: string;
  corral_name?: string;
  feedlot_name?: string;
}

export interface LivestockMovementRow {
  id: string;
  user_id: number;
  movement_type: LivestockMovementType;
  source_group_id: string | null;
  dest_group_id: string | null;
  count: number;
  avg_weight_kg: number | null;
  unit_price_ars: number | null;
  unit_price_usd: number | null;
  linked_expense_id: number | null;
  linked_income_id: number | null;
  reason: string | null;
  notes: string | null;
  movement_date: Date;
  created_at: Date;
}
