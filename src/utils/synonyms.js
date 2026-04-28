// ============================================================================
// Centralized Synonym Dictionary
// Handles compound words, verb→noun mappings, and audio transcription variants
// that fall through the cracks of existing CATEGORIAS_GASTO/CATEGORIAS_INGRESO
// ============================================================================

export const SYNONYMS = {
  // Fuel variants
  'gas-oil': 'gasoil',
  'gas oil': 'gasoil',
  'diesel': 'gasoil',
  'gasolina': 'nafta',
  'combustible': 'combustible',
  'nasta': 'nafta',

  // Activity verb→noun
  'sembrar': 'siembra',
  'plantar': 'siembra',
  'fumigar': 'fumigacion',
  'pulverizar': 'fumigacion',
  'curar': 'fumigacion',
  'fertilizar': 'fertilizacion',
  'abonar': 'fertilizacion',
  'cosechar': 'cosecha',
  'regar': 'riego',

  // Crop variants
  'choclo': 'maiz',
  'maicito': 'maiz',
  'soya': 'soja',
  // Anglicismos comunes (audio transcription / mensajes mixtos)
  'soybean': 'soja',
  'soybeans': 'soja',
  'soy': 'soja',
  'corn': 'maiz',
  'maize': 'maiz',
  'wheat': 'trigo',
  'sunflower': 'girasol',
  'sorghum': 'sorgo',
  'barley': 'cebada',
  'oat': 'avena',
  'oats': 'avena',
  'cotton': 'algodon',
  'rye': 'centeno',

  // Unit variants
  'tonelada': 'tn',
  'toneladas': 'tn',
  'kilo': 'kg',
  'kilos': 'kg',
  'kilogramo': 'kg',
  'kilogramos': 'kg',
  'litro': 'lt',
  'litros': 'lt',
  'hectarea': 'ha',
  'hectareas': 'ha',

  // Product variants (audio transcription)
  'glifo': 'glifosato',
  'agroquimico': 'agroquimico',
  'agroquimicos': 'agroquimicos',

  // Machinery / services
  'tractorista': 'maquinaria',
  'laborear': 'laboreo',

  // Transport / logistics
  'fletes': 'flete',
  'camionero': 'flete',

  // Insurance
  'seguros': 'seguro',
};

// Multi-word synonyms (checked before single-word)
const MULTI_WORD_SYNONYMS = {
  'gas oil': 'gasoil',
  'gas-oil': 'gasoil',
  'sulfato de amonio': 'sulfato de amonio',
};

/**
 * Apply synonym expansion to normalized text.
 * Runs AFTER normalizeText and BEFORE parsing.
 * Returns the text with known synonyms replaced.
 */
export function applySynonyms(text) {
  let result = text;

  // Multi-word replacements first
  for (const [pattern, replacement] of Object.entries(MULTI_WORD_SYNONYMS)) {
    if (result.includes(pattern)) {
      result = result.replace(new RegExp(pattern.replace(/-/g, '\\-'), 'g'), replacement);
    }
  }

  // Single-word replacements
  const words = result.split(/\s+/);
  const mapped = words.map(word => SYNONYMS[word] || word);
  return mapped.join(' ');
}
