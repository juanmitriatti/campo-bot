// ============================================================================
// Agricultural Term Lists — Single Source of Truth
// ============================================================================
// To add a new term, edit THIS file. All consumers import from here.
// See docs/agro-terms-reference.md for the full developer reference.
// ============================================================================

// ============================================================================
// EXPENSE CATEGORIES
// ============================================================================

export const EXPENSE_CATEGORIES = [
  'Combustible', 'Fertilizantes', 'Semillas', 'Agroquímicos',
  'Labranzas', 'Sueldos', 'Maquinaria', 'Arrendamiento', 'Impuestos', 'Hacienda', 'Otros',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_SET = new Set<string>(EXPENSE_CATEGORIES);

/** Keyword → category mapping for fuzzy detection (post-normalization, no accents) */
export const EXPENSE_KEYWORD_MAP: Record<string, string> = {
  gasoil: 'Combustible', diesel: 'Combustible', nafta: 'Combustible', combustible: 'Combustible',
  fertilizante: 'Fertilizantes', fertilizantes: 'Fertilizantes', urea: 'Fertilizantes',
  semilla: 'Semillas', semillas: 'Semillas',
  agroquimico: 'Agroquímicos', agroquimicos: 'Agroquímicos', herbicida: 'Agroquímicos', insecticida: 'Agroquímicos', fungicida: 'Agroquímicos', glifosato: 'Agroquímicos', fumigacion: 'Agroquímicos',
  labranza: 'Labranzas', labranzas: 'Labranzas', 'siembra directa': 'Labranzas', 'pulverizacion terrestre': 'Labranzas', 'pulverizacion aerea': 'Labranzas', 'servicio de aplicacion': 'Labranzas',
  sueldo: 'Sueldos', sueldos: 'Sueldos', jornal: 'Sueldos', peon: 'Sueldos',
  repuesto: 'Maquinaria', repuestos: 'Maquinaria', tractor: 'Maquinaria', maquinaria: 'Maquinaria', cosechadora: 'Maquinaria', contratista: 'Maquinaria', laboreo: 'Maquinaria',
  alquiler: 'Arrendamiento', arrendamiento: 'Arrendamiento', arriendo: 'Arrendamiento',
  impuesto: 'Impuestos', impuestos: 'Impuestos', inmobiliario: 'Impuestos', iibb: 'Impuestos',
  hacienda: 'Hacienda', vacas: 'Hacienda', novillos: 'Hacienda', novillitos: 'Hacienda', terneros: 'Hacienda', vaquillonas: 'Hacienda', toros: 'Hacienda',
  flete: 'Otros', transporte: 'Otros', seguro: 'Otros', veterinario: 'Otros', silobolsa: 'Otros',
};

// ============================================================================
// EXPENSE TYPE CLASSIFICATION
// ============================================================================

/** Categories that represent storable inputs (insumos) */
export const INSUMO_CATEGORIES = new Set(['Agroquímicos', 'Fertilizantes', 'Semillas', 'Combustible']);

/** Categories that represent services/overheads (varios) */
export const VARIOS_CATEGORIES = new Set(['Labranzas', 'Sueldos', 'Maquinaria', 'Arrendamiento', 'Impuestos', 'Otros']);

export type ExpenseType = 'insumo' | 'varios';

// ============================================================================
// INCOME CATEGORIES
// ============================================================================

export const INCOME_CATEGORIES = [
  'Soja', 'Maíz', 'Trigo', 'Girasol', 'Sorgo',
  'Cebada', 'Hacienda', 'Arrendamiento', 'Otros',
] as const;

export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const INCOME_CATEGORY_SET = new Set<string>(INCOME_CATEGORIES);

/** Keyword → category mapping for income detection (post-normalization) */
export const INCOME_KEYWORD_MAP: Record<string, string> = {
  soja: 'Soja', soya: 'Soja',
  maiz: 'Maíz',
  trigo: 'Trigo',
  girasol: 'Girasol',
  sorgo: 'Sorgo',
  cebada: 'Cebada',
  hacienda: 'Hacienda', ganado: 'Hacienda', novillo: 'Hacienda', vaca: 'Hacienda',
  alquiler: 'Arrendamiento', arrendamiento: 'Arrendamiento',
};

// ============================================================================
// CROPS
// ============================================================================

/** Keyword → normalized crop name (post-normalization, no accents) */
export const CROPS: Record<string, string> = {
  soja: 'Soja', soya: 'Soja',
  maiz: 'Maíz',
  trigo: 'Trigo',
  girasol: 'Girasol',
  sorgo: 'Sorgo',
  cebada: 'Cebada',
  avena: 'Avena',
  centeno: 'Centeno',
  alfalfa: 'Alfalfa',
};

/** Season classification sets */
export const CROP_SEASON = {
  GRUESA: new Set(['Soja', 'Maíz', 'Girasol', 'Sorgo']),
  FINA: new Set(['Trigo', 'Cebada', 'Avena', 'Centeno']),
  PERENNE: new Set(['Alfalfa']),
} as const;

// ============================================================================
// AGRO PRODUCTS
// ============================================================================

export interface AgroProduct {
  name: string;
  type: 'herbicida' | 'insecticida' | 'fungicida' | 'fertilizante';
}

export const AGRO_PRODUCTS: Record<string, AgroProduct> = {
  // Herbicidas
  glifosato: { name: 'Glifosato', type: 'herbicida' },
  glifo: { name: 'Glifosato', type: 'herbicida' },
  roundup: { name: 'Glifosato', type: 'herbicida' },
  atrazina: { name: 'Atrazina', type: 'herbicida' },
  '2,4-d': { name: '2,4-D', type: 'herbicida' },
  '24d': { name: '2,4-D', type: 'herbicida' },
  metsulfuron: { name: 'Metsulfurón', type: 'herbicida' },
  dicamba: { name: 'Dicamba', type: 'herbicida' },
  paraquat: { name: 'Paraquat', type: 'herbicida' },
  imazetapir: { name: 'Imazetapir', type: 'herbicida' },
  cletodim: { name: 'Cletodim', type: 'herbicida' },
  haloxifop: { name: 'Haloxifop', type: 'herbicida' },
  // Insecticidas
  cipermetrina: { name: 'Cipermetrina', type: 'insecticida' },
  clorpirifos: { name: 'Clorpirifós', type: 'insecticida' },
  fipronil: { name: 'Fipronil', type: 'insecticida' },
  imidacloprid: { name: 'Imidacloprid', type: 'insecticida' },
  dimetoato: { name: 'Dimetoato', type: 'insecticida' },
  // Fungicidas
  azoxistrobina: { name: 'Azoxistrobina', type: 'fungicida' },
  carbendazim: { name: 'Carbendazim', type: 'fungicida' },
  tebuconazol: { name: 'Tebuconazol', type: 'fungicida' },
  // Fertilizantes
  urea: { name: 'Urea', type: 'fertilizante' },
  fosfato: { name: 'Fosfato', type: 'fertilizante' },
  dap: { name: 'DAP', type: 'fertilizante' },
  map: { name: 'MAP', type: 'fertilizante' },
  superfosfato: { name: 'Superfosfato', type: 'fertilizante' },
  'sulfato de amonio': { name: 'Sulfato de Amonio', type: 'fertilizante' },
  nitrato: { name: 'Nitrato', type: 'fertilizante' },
  can: { name: 'CAN', type: 'fertilizante' },
  uan: { name: 'UAN', type: 'fertilizante' },
  potasio: { name: 'Potasio', type: 'fertilizante' },
};

/** Generic type keywords for product type detection */
export const PRODUCT_TYPE_KEYWORDS: Record<string, string> = {
  herbicida: 'herbicida',
  insecticida: 'insecticida',
  fungicida: 'fungicida',
  fertilizante: 'fertilizante',
  agroquimico: 'herbicida',
};

// ============================================================================
// PRODUCT → CROP INFERENCE
// ============================================================================

export const PRODUCT_CROP_MAP: Record<string, string> = {
  Atrazina: 'Maíz',
  Imazetapir: 'Soja',
  Cletodim: 'Soja',
  Haloxifop: 'Soja',
};

// ============================================================================
// ACTIVITY TYPES
// ============================================================================

export interface ActivityTypeEntry {
  id: string;
  label: string;
  emoji: string;
  /**
   * true = el flow genérico de actividades (activity_flow) puede registrarla
   * con sus preguntas lote/producto/cantidad. Los eventos de hacienda y los
   * de observación/monitoreo NO: tienen sus propios caminos con datos propios
   * (animales, categorías, métricas) — ofrecerlos en el picker generaba
   * eventos fantasma sin datos (visto en prod: "Movimiento hacienda" pedía
   * "¿cuánto aplicaste?" y guardaba un domain_event sin tocar el inventario).
   * Sin el flag, la entrada existe SOLO como etiqueta para reportes.
   */
  flow?: boolean;
}

export const ACTIVITY_TYPES: readonly ActivityTypeEntry[] = [
  { id: 'spraying', label: 'Fumigación', emoji: '\ud83d\udca8', flow: true },
  { id: 'fertilization', label: 'Fertilización', emoji: '\ud83e\uddea', flow: true },
  { id: 'planting', label: 'Siembra', emoji: '\ud83c\udf31', flow: true },
  { id: 'tillage', label: 'Labranza', emoji: '\ud83d\ude9c', flow: true },
  { id: 'harvest', label: 'Cosecha', emoji: '\ud83c\udf3e', flow: true },
  { id: 'irrigation', label: 'Riego', emoji: '\ud83d\udca7', flow: true },
  { id: 'tacto', label: 'Tacto', emoji: '\ud83e\ude7a', flow: true },
  // Livestock domain_events surface in agro reports — without these entries
  // they leak as snake_case ("weighing", "health_event", "repro_event").
  { id: 'weighing', label: 'Pesaje', emoji: '\u2696\ufe0f' },
  { id: 'health_event', label: 'Sanidad', emoji: '\ud83d\udc89' },
  { id: 'repro_event', label: 'Reproducción', emoji: '\ud83d\udc2e' },
  { id: 'livestock_birth', label: 'Nacimiento', emoji: '\ud83d\udc23' },
  { id: 'livestock_death', label: 'Muerte', emoji: '\ud83d\udc80' },
  { id: 'livestock_movement', label: 'Movimiento hacienda', emoji: '\ud83d\udd04' },
  { id: 'observation', label: 'Observación', emoji: '\ud83d\udd0d' },
  { id: 'scouting', label: 'Monitoreo', emoji: '\ud83d\udd0e' },
] as const;

/** Subset que el activity_flow ofrece en su picker y sabe registrar. */
export const FLOW_ACTIVITY_TYPES: readonly ActivityTypeEntry[] = ACTIVITY_TYPES.filter(a => a.flow === true);

/** id or label → { emoji, label } lookup */
export const ACTIVITY_LABEL_MAP: Record<string, { emoji: string; label: string }> = {};
for (const a of ACTIVITY_TYPES) {
  ACTIVITY_LABEL_MAP[a.id] = { emoji: a.emoji, label: a.label };
}

// ============================================================================
// ACTIVITY FILTER PATTERNS (for history queries)
// ============================================================================

export const ACTIVITY_FILTER_PATTERNS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /fumig|pulveriz/, type: 'spraying' },
  { pattern: /fertil|abono/, type: 'fertilization' },
  { pattern: /labran|arar|cincel|disco/, type: 'tillage' },
  { pattern: /riego|regar|reg[oó]/, type: 'irrigation' },
  { pattern: /siembr|sembr/, type: 'planting' },
  { pattern: /cosech/, type: 'harvest' },
  { pattern: /lluvia|precipit/, type: 'rainfall' },
  { pattern: /observ|monitoreo|nota/, type: 'observation' },
  { pattern: /tacto|palpaci[oó]n|pre[nñ]ez/, type: 'tacto' },
];

// ============================================================================
// IMPLEMENTS (tillage tools)
// ============================================================================

export const IMPLEMENTS: Record<string, string> = {
  cincel: 'Cincel',
  cincelada: 'Cincel',
  arado: 'Arado',
  arada: 'Arado',
  rastra: 'Rastra',
  rastreada: 'Rastra',
  disco: 'Disco',
  disqueada: 'Disco',
};

// ============================================================================
// UNIT ALIASES
// ============================================================================

export const UNIT_ALIASES: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilos: 'kg', kilogramos: 'kg',
  lt: 'lt', lts: 'lt', litro: 'lt', litros: 'lt',
  cc: 'cc',
  bolsa: 'bolsas', bolsas: 'bolsas',
  tn: 'tn', tonelada: 'tn', toneladas: 'tn',
};

// ============================================================================
// OBSERVATION CATEGORY KEYWORDS
// ============================================================================

export const OBSERVATION_CATEGORY_KEYWORDS: Record<string, string[]> = {
  malezas: [
    'maleza', 'rama negra', 'yuyo', 'sorgo de alepo', 'cardo', 'gramon',
    'enredadera', 'gramilla', 'cerraja', 'nabón', 'nabon', 'ortiga',
  ],
  sanidad: [
    'oruga', 'plaga', 'chinche', 'isoca', 'trips', 'arañuela', 'aranuela',
    'mosca', 'pulgon', 'pulgón', 'bolillera', 'cogollero', 'bicho',
    'enfermedad', 'hongo', 'roya', 'mancha', 'podredumbre',
  ],
  nutricion: [
    'nutricion', 'nutrición', 'deficiencia', 'clorosis', 'amarillamiento',
    'carencia', 'amarillo', 'necros',
  ],
  fenologia: [
    'estado', 'fenolog', 'floración', 'floracion', 'llenado', 'emergencia',
    'macollaje', 'espigazón', 'espigazon', 'panojamiento',
    'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12',
    'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8',
  ],
  clima: [
    'helada', 'granizo', 'sequia', 'sequía', 'encharcamiento', 'stress',
    'estrés', 'estres', 'viento', 'inundación', 'inundacion',
  ],
};

export type ObservationCategory = 'sanidad' | 'malezas' | 'nutricion' | 'fenologia' | 'clima' | 'general';

// ============================================================================
// PROMPT HELPERS (for AI prompt building)
// ============================================================================

export const EXPENSE_CATEGORIES_PROMPT = EXPENSE_CATEGORIES.join('|');
export const INCOME_CATEGORIES_PROMPT = INCOME_CATEGORIES.join('|');
