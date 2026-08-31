// Tipos del modelo individual de animales. Espejo de los ENUMs de las
// migraciones 112-114. La capa de grupos (livestock.types.ts) no depende de
// esta: la relación es en un solo sentido.

import type { LivestockCategory } from './livestock.types.js';

export type AnimalStatus = 'activo' | 'vendido' | 'muerto' | 'extraviado' | 'transferido';
export type AnimalSex = 'M' | 'H';
export type AnimalSource = 'manual' | 'whatsapp' | 'csv_import' | 'rfid_reader' | 'form' | 'api' | 'derivado';
export type AnimalIdType = 'rfid' | 'caravana_visual' | 'cuig' | 'rp' | 'interno';

export type AnimalEventType =
  | 'identificacion' | 'reidentificacion'
  | 'ingreso' | 'egreso_venta' | 'egreso_muerte' | 'nacimiento'
  | 'movimiento' | 'cambio_grupo' | 'cambio_categoria' | 'cambio_establecimiento'
  | 'vacunacion' | 'desparasitacion' | 'tratamiento' | 'revision_sanitaria'
  | 'pesaje' | 'condicion_corporal'
  | 'servicio' | 'inseminacion' | 'diagnostico_prenez' | 'parto' | 'destete'
  | 'otro';

/**
 * Sexo implícito en cada categoría. Las categorías del rodeo argentino YA
 * codifican el sexo, así que pedírselo al usuario sería redundante en el 100%
 * de los casos. Se usa como DEFAULT, no como verdad inmutable: el campo `sex`
 * es explícito en la fila y se puede corregir (un "ternero" cargado que
 * resultó ser ternera).
 */
export const CATEGORY_SEX: Record<LivestockCategory, AnimalSex> = {
  vaca: 'H',
  vaquillona: 'H',
  ternera: 'H',
  ternero: 'M',
  novillo: 'M',
  novillito: 'M',
  toro: 'M',
  torito: 'M',
  buey: 'M',
};

export const ANIMAL_STATUS_LABEL: Record<AnimalStatus, { emoji: string; label: string }> = {
  activo: { emoji: '🐄', label: 'Activo' },
  vendido: { emoji: '💰', label: 'Vendido' },
  muerto: { emoji: '💀', label: 'Muerto' },
  extraviado: { emoji: '❓', label: 'Extraviado' },
  transferido: { emoji: '📤', label: 'Transferido' },
};

/** Estados en los que el animal ya NO forma parte del rodeo. */
export const TERMINAL_STATUSES: AnimalStatus[] = ['vendido', 'muerto', 'transferido'];

export const ANIMAL_EVENT_LABEL: Record<AnimalEventType, { emoji: string; label: string }> = {
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

export interface AnimalRow {
  id: string;
  user_id: number;
  field_id: number | null;
  plot_id: number | null;
  corral_id: number | null;
  group_id: string | null;
  category: LivestockCategory;
  sex: AnimalSex;
  breed_id: number | null;
  breed_text: string | null;
  birth_date: Date | null;
  status: AnimalStatus;
  origin: string | null;
  entry_date: Date;
  exit_date: Date | null;
  mother_animal_id: string | null;
  notes: string | null;
  source: AnimalSource;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  // Columnas joineadas (opcionales)
  field_name?: string | null;
  plot_name?: string | null;
  corral_name?: string | null;
  breed_name?: string | null;
  current_rfid?: string | null;
  current_visual_tag?: string | null;
}

export interface AnimalIdentificationRow {
  id: string;
  user_id: number;
  animal_id: string;
  id_type: AnimalIdType;
  device_type: string | null;
  value: string;
  value_normalized: string;
  is_current: boolean;
  assigned_date: Date;
  removed_date: Date | null;
  removal_reason: string | null;
  replaces_identification_id: string | null;
  senasa_declared_at: Date | null;
  source: AnimalSource;
  notes: string | null;
  created_by: number | null;
  created_at: Date;
}

export interface AnimalEventRow {
  id: string;
  user_id: number;
  animal_id: string;
  event_type: AnimalEventType;
  event_date: Date;
  domain_event_id: number | null;
  livestock_movement_id: string | null;
  numeric_value: string | number | null;
  text_value: string | null;
  unit: string | null;
  from_ref: string | null;
  to_ref: string | null;
  related_animal_id: string | null;
  source: AnimalSource;
  notes: string | null;
  created_by: number | null;
  created_at: Date;
  deleted_at: Date | null;
}

/**
 * Resultado de resolver una lista cruda de identificadores contra el padrón del
 * usuario. Las cuatro categorías son disjuntas y suman el total leído — el
 * productor tiene que poder cuadrar "leí 90, encontré 87" sin adivinar.
 */
export interface IdentificationResolution {
  /** Identificadores que resolvieron a un animal existente. */
  matched: Array<{ value: string; animal: AnimalRow }>;
  /** Bien formados pero sin animal en el padrón del usuario. */
  unknown: string[];
  /** Formato no interpretable (vacío, demasiado corto). */
  invalid: Array<{ value: string; reason: string }>;
  /** Repetidos dentro de la MISMA lectura (el mismo animal pasó dos veces). */
  duplicates: string[];
  /** Total de líneas con contenido en la entrada. */
  rawCount: number;
}
