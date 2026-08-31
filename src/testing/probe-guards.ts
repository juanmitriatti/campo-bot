#!/usr/bin/env npx tsx
/** Qué ven los guardas de escape de pendings para estos mensajes. */
import { IntentClassifier } from '../services/intent-classifier.js';
import { hasActionVerbOrQuery, looksLikeNewActionOrQuery } from '../middleware/conversation-guards.js';
import { isNewActionInterrupt } from '../middleware/pending-action-processor.js';
import { isReadOnlyQuery } from '../middleware/conversation-guards.js';

const CASES = [
  // Pivots reales: DEBEN escapar del pending.
  'crear feedlot en el campo Probe',
  'crear corral 1 con capacidad 5',
  'borrar el corral 1',
  'dar de alta una vaca con caravana 032010000000101',
  'mové la 0000000102 al lote Sur',
  'mové 50 vacas del lote Norte al lote Sur',
  'reemplazá la caravana 101 por la 201',
  'revertí el último movimiento',
  // Respuestas legítimas a un slot: NO deben escapar.
  '50',
  'las 95',
  'ivermectina',
  'lote Norte',
  'Angus',
  '280 kg promedio',
  'aftosa',
  // Consulta read-only: escapa, pero isReadOnlyQuery la responde y restaura.
  'movimientos de hacienda',
];

for (const t of CASES) {
  const c = new IntentClassifier().parseCommandOnly(t);
  console.log(JSON.stringify({
    t,
    cmd: c?.command ?? null,
    interrupt: isNewActionInterrupt(c),
    actionVerb: hasActionVerbOrQuery(t),
    broad: looksLikeNewActionOrQuery(t),
    readOnly: isReadOnlyQuery(t),
  }));
}
