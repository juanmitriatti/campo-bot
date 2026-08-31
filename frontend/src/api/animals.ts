/**
 * Tipos y helpers de la capa individual de hacienda.
 *
 * El formato del identificador está definido por la Res. SENASA 530/2025
 * Art. 15: CII = 15 dígitos = 032 (país) + 01 (especie bovina) + NII (10).
 * `formatTag` lo separa en esos tres bloques para que sea legible; cualquier
 * otro largo se muestra tal cual (el sistema acepta caravanas visuales que no
 * siguen el estándar).
 */

export type AnimalStatus = 'activo' | 'vendido' | 'muerto' | 'extraviado' | 'transferido';

export interface Animal {
  id: string;
  category: string;
  sex: 'M' | 'H';
  status: AnimalStatus;
  breed_id: number | null;
  breed_text: string | null;
  breed_name: string | null;
  birth_date: string | null;
  entry_date: string;
  exit_date: string | null;
  origin: string | null;
  notes: string | null;
  field_name: string | null;
  plot_name: string | null;
  corral_name: string | null;
  current_rfid: string | null;
  current_visual_tag: string | null;
}

export interface AnimalsResponse {
  items: Animal[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AnimalIdentification {
  id: string;
  id_type: string;
  device_type: string | null;
  value: string;
  is_current: boolean;
  assigned_date: string;
  removed_date: string | null;
  removal_reason: string | null;
  replaces_identification_id: string | null;
  senasa_declared_at: string | null;
}

export interface AnimalEvent {
  id: string;
  event_type: string;
  event_date: string;
  numeric_value: string | number | null;
  text_value: string | null;
  unit: string | null;
  from_ref: string | null;
  to_ref: string | null;
  notes: string | null;
}

export interface WeightGain {
  weighings: Array<{ date: string; weightKg: number }>;
  segments: Array<{ fromDate: string; toDate: string; days: number; gainKg: number; gdpKgDay: number }>;
  overallGdpKgDay: number | null;
}

export interface AnimalDetail {
  animal: Animal;
  identifications: AnimalIdentification[];
  weights: WeightGain;
}

export interface ImportPreview {
  batchId: string;
  summary: { raw: number; matched: number; unknown: number; duplicates: number; invalid: number };
  matched: Array<{ value: string; animalId: string; category: string; location: string | null }>;
  unknown: string[];
  invalid: Array<{ value: string; reason: string }>;
  duplicates: string[];
}

export interface FiltersResponse {
  fields: Array<{ id: number; name: string; plots: Array<{ id: number; name: string }> }>;
  corrals: Array<{ id: number; name: string; feedlot_name?: string; field_name?: string }>;
  categories: string[];
}

export const CATEGORY_LABELS: Record<string, string> = {
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

export const STATUS_LABELS: Record<string, { emoji: string; label: string }> = {
  activo: { emoji: '🐄', label: 'Activo' },
  vendido: { emoji: '💰', label: 'Vendido' },
  muerto: { emoji: '💀', label: 'Muerto' },
  extraviado: { emoji: '❓', label: 'Extraviado' },
  transferido: { emoji: '📤', label: 'Transferido' },
};

export const EVENT_LABELS: Record<string, { emoji: string; label: string }> = {
  identificacion: { emoji: '🏷️', label: 'Identificación' },
  reidentificacion: { emoji: '🔁', label: 'Re-identificación' },
  ingreso: { emoji: '📥', label: 'Ingreso' },
  egreso_venta: { emoji: '💰', label: 'Venta' },
  egreso_muerte: { emoji: '💀', label: 'Muerte' },
  nacimiento: { emoji: '🐣', label: 'Nacimiento' },
  movimiento: { emoji: '🔄', label: 'Movimiento' },
  cambio_grupo: { emoji: '👥', label: 'Cambio de grupo' },
  cambio_categoria: { emoji: '🔀', label: 'Cambio de categoría' },
  cambio_establecimiento: { emoji: '🚚', label: 'Cambio de establecimiento' },
  vacunacion: { emoji: '💉', label: 'Vacunación' },
  desparasitacion: { emoji: '🪱', label: 'Desparasitación' },
  tratamiento: { emoji: '🩺', label: 'Tratamiento' },
  revision_sanitaria: { emoji: '🔎', label: 'Revisión sanitaria' },
  pesaje: { emoji: '⚖️', label: 'Pesaje' },
  condicion_corporal: { emoji: '📊', label: 'Condición corporal' },
  servicio: { emoji: '🐂', label: 'Servicio' },
  inseminacion: { emoji: '🧪', label: 'Inseminación' },
  diagnostico_prenez: { emoji: '🤰', label: 'Diagnóstico de preñez' },
  parto: { emoji: '🐮', label: 'Parto' },
  destete: { emoji: '🍼', label: 'Destete' },
  otro: { emoji: '•', label: 'Otro' },
};

/** La caravana que identifica al animal: la electrónica manda sobre la visual. */
export function animalTag(a: Animal): string | null {
  return a.current_rfid ?? a.current_visual_tag ?? null;
}

/** "032010001234567" → "032 01 0001234567". Otros largos se devuelven tal cual. */
export function formatTag(raw: string): string {
  const digits = raw.replace(/[^0-9A-Za-z]/g, '');
  if (/^\d{15}$/.test(digits)) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5)}`;
  }
  return raw;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${m[3]}/${m[2]}/${m[1]}`;
}
