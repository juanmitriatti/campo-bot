import type { ParsedCommand } from '../../types/index.js';

export type LivestockPayloadStep = 'create_loc' | 'pick_loc' | 'animals' | 'post_action';

export interface LivestockPendingPayload {
  cmd: ParsedCommand;
  step: LivestockPayloadStep;
  resolvedLocation?: {
    plotId: number | null;
    corralId: number | null;
    label: string;
  };
  missingType?: 'corral' | 'plot' | 'feedlot' | 'field';
  missingName?: string;
  feedlotId?: number;
  fieldName?: string;
  knownGroupCount?: number;
}

export function encodeLivestockPayload(p: LivestockPendingPayload): string {
  const json = JSON.stringify(p);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeLivestockPayload(b64: string): LivestockPendingPayload {
  return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
}
