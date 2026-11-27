// Comandos que borran: siempre se confirman mostrando qué (message-pipeline), y
// dentro de un mensaje con varias acciones no se ejecutan (compound-executor).
export const DESTRUCTIVE_COMMANDS = new Set([
  'delete_last', 'delete_last_income', 'delete_specific',
  // Deletes del path del AGENTE (Jul 2026): borraban al toque sin confirmar ni
  // cota temporal — "borrá la última actividad" podía eliminar una siembra de
  // hace 5 días creyendo que era la de recién.
  'delete_last_expense', 'delete_last_activity', 'delete_last_observation',
  'delete_last_rainfall', 'delete_last_scouting',
  'delete_specific_expense', 'delete_specific_income',
  'revert_livestock_movement', 'delete_harvest_loads',
]);
