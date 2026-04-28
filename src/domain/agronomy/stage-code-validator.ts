/**
 * Validate stage_code for a given crop. Used by log_crop_scouting to surface
 * a warning when the user reports an out-of-range stage (e.g. soja R12).
 * The save still goes through — the warning is informational, not blocking.
 */

export interface StageValidationResult {
  ok: boolean;
  warning?: string;
  validRanges?: string;
}

const VALID_STAGES: Record<string, RegExp> = {
  // Soja: VE, VC, VN (with N=1..8 cotyledonary), V1..V8, R1..R8 (Fehr & Caviness)
  soja: /^(VE|VC|V[1-8]|R[1-8])$/,
  // Maíz: VE, V1..V21, VT, R1..R6 (Ritchie & Hanway)
  'maíz': /^(VE|V([1-9]|1\d|2[01])|VT|R[1-6])$/,
  maiz: /^(VE|V([1-9]|1\d|2[01])|VT|R[1-6])$/,
  // Trigo: Zadoks Z00..Z99 (commonly Z2..Z9 stage groups)
  trigo: /^Z?\d{1,2}$/,
  // Girasol: VE, V1..V20, R1..R9 (Schneiter & Miller)
  girasol: /^(VE|V([1-9]|1\d|20)|R[1-9])$/,
  // Cebada (Zadoks like trigo)
  cebada: /^Z?\d{1,2}$/,
  // Sorgo: estadios 0-9 + S
  sorgo: /^(VE|V([0-9]|1[0-2])|R[1-6])$/,
};

const RANGE_HINTS: Record<string, string> = {
  soja: 'VE, V1..V8, R1..R8',
  'maíz': 'VE, V1..V21, VT, R1..R6',
  maiz: 'VE, V1..V21, VT, R1..R6',
  trigo: 'Z21..Z99 (Zadoks)',
  girasol: 'VE, V1..V20, R1..R9',
  cebada: 'Z21..Z99 (Zadoks)',
  sorgo: 'VE, V1..V12, R1..R6',
};

export function validateStageCode(crop: string | null | undefined, stageCode: string | null | undefined): StageValidationResult {
  if (!crop || !stageCode) return { ok: true };
  const normalizedCrop = crop.trim().toLowerCase();
  const normalizedStage = stageCode.trim().toUpperCase();
  const re = VALID_STAGES[normalizedCrop];
  if (!re) return { ok: true };
  if (re.test(normalizedStage)) return { ok: true };
  return {
    ok: false,
    warning: `⚠️ El estadio *${normalizedStage}* no es típico de *${crop}*.`,
    validRanges: RANGE_HINTS[normalizedCrop],
  };
}
