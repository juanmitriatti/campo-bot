import { pool } from '../config/db.js';

export interface ActivityDictionaryEntry {
  activity_type: string;
  display_name: string;
  tool_name: string;
  synonyms: string;
}

// --- In-memory cache (5-min TTL) ---
let cachedEntries: ActivityDictionaryEntry[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_ENTRIES: ActivityDictionaryEntry[] = [
  { activity_type: 'spraying', display_name: 'Fumigación', tool_name: 'log_spraying', synonyms: 'fumigué\ntiré glifosato\napliqué herbicida\naplicación\npulvericé\ncuré\neché veneno\nhice una pasada' },
  { activity_type: 'fertilization', display_name: 'Fertilización', tool_name: 'log_fertilization', synonyms: 'fertilicé\naboné\neché fertilizante\ntiré urea\naplicación de fertilizante' },
  { activity_type: 'planting', display_name: 'Siembra', tool_name: 'sow_crop', synonyms: 'sembré\nhice la siembra\nplanté\nsiembra directa' },
  { activity_type: 'harvest', display_name: 'Cosecha', tool_name: 'harvest_crop', synonyms: 'coseché\nlevanté la cosecha\njunté\ntrillé\ncorté' },
  { activity_type: 'tillage', display_name: 'Laboreo', tool_name: 'log_tillage', synonyms: 'aré\ndisqueé\nrastré\nhice laboreo\nlabranza\ncincelé\nsubsolé' },
  { activity_type: 'irrigation', display_name: 'Riego', tool_name: 'log_irrigation', synonyms: 'regué\nhice riego\nprendí el riego\npivote\nriego por aspersión' },
];

export async function getActivityDictionary(): Promise<ActivityDictionaryEntry[]> {
  const now = Date.now();
  if (cachedEntries && now < cacheExpiresAt) return cachedEntries;

  try {
    const result = await pool.query(
      'SELECT activity_type, display_name, tool_name, synonyms FROM activity_dictionary ORDER BY display_name',
    );
    if (result.rows.length === 0) {
      cachedEntries = DEFAULT_ENTRIES;
    } else {
      cachedEntries = result.rows;
    }
  } catch {
    cachedEntries = DEFAULT_ENTRIES;
  }

  cacheExpiresAt = now + CACHE_TTL_MS;
  return cachedEntries;
}

export async function updateActivitySynonyms(activityType: string, synonyms: string): Promise<void> {
  await pool.query(
    'UPDATE activity_dictionary SET synonyms = $1, updated_at = NOW() WHERE activity_type = $2',
    [synonyms, activityType],
  );
  // Invalidate cache
  cachedEntries = null;
  cacheExpiresAt = 0;
}
