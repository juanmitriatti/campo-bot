/**
 * Crop extraction helper. Used by pending-activity controllers to interpret
 * a user's reply when the bot has asked "¿Qué cultivo?" — turns free text
 * like "soja", "soybean", "es maíz" into the canonical Spanish crop name,
 * or null when no known crop is named.
 *
 * Centralizes the canonical list. Same names that `sow_crop`/`harvest_crop`
 * persist into `plot_crops.crop`.
 */

export const KNOWN_CROPS = [
  'soja',
  'maíz',
  'trigo',
  'girasol',
  'sorgo',
  'cebada',
  'avena',
  'centeno',
  'algodón',
  'maní',
  'arroz',
  'arveja',
  'lenteja',
  'colza',
  'lino',
  'caña',
];

const CROP_SYNONYMS: Record<string, string> = {
  choclo: 'maíz',
  maicito: 'maíz',
  maiz: 'maíz',
  soya: 'soja',
  algodon: 'algodón',
  mani: 'maní',
  cana: 'caña',
  soybean: 'soja',
  soybeans: 'soja',
  soy: 'soja',
  corn: 'maíz',
  maize: 'maíz',
  wheat: 'trigo',
  sunflower: 'girasol',
  sorghum: 'sorgo',
  barley: 'cebada',
  oat: 'avena',
  oats: 'avena',
  cotton: 'algodón',
  rye: 'centeno',
  rice: 'arroz',
};

const COMBINING_MARKS = /[̀-ͯ]/g;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '');
}

export function extractCropFromText(text: string): string | null {
  if (!text) return null;
  const normalized = stripAccents(text.toLowerCase()).trim();
  if (normalized === '') return null;

  const tokens = normalized.split(/[\s,.;:!?¡¿]+/).filter(Boolean);
  for (const token of tokens) {
    if (CROP_SYNONYMS[token]) return CROP_SYNONYMS[token];
    for (const crop of KNOWN_CROPS) {
      if (stripAccents(crop) === token) return crop;
    }
  }
  return null;
}

/**
 * TODOS los cultivos canónicos mencionados en el texto, en orden de aparición.
 * Necesario para validar compounds multi-cultivo ("sembré soja en Norte y maíz
 * en Sur"): la versión singular devolvía solo "soja" y el validador descartaba
 * el "maíz" del segundo tool como alucinación del agente.
 */
export function extractAllCropsFromText(text: string): string[] {
  if (!text) return [];
  const normalized = stripAccents(text.toLowerCase()).trim();
  if (normalized === '') return [];

  const found: string[] = [];
  const tokens = normalized.split(/[\s,.;:!?¡¿]+/).filter(Boolean);
  for (const token of tokens) {
    let crop: string | null = null;
    if (CROP_SYNONYMS[token]) crop = CROP_SYNONYMS[token];
    else {
      for (const k of KNOWN_CROPS) {
        if (stripAccents(k) === token) { crop = k; break; }
      }
    }
    if (crop && !found.includes(crop)) found.push(crop);
  }
  return found;
}
