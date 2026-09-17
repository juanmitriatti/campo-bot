// El nfm_reply del alta de hacienda: `response_json` ya parseado (todo llega
// como string). Recorrido sin DB: unflatten (hacienda no tiene grupos, pasa los
// escalares y descarta flow_token) → validateFormPayload (castea) →
// buildFormCommand (arma el comando que entra por routeCommand). Cubre la Fase 4.
import { describe, it, expect } from 'vitest';
import { FORM_DEFINITIONS, validateFormPayload } from '../form-definitions.js';
import { unflattenFlowPayload } from '../whatsapp-flow-generator.js';
import { buildFormCommand, type ResolvedRefs } from '../form-commands.js';

const REFS: ResolvedRefs = { plot: { id: 1, name: 'Lote 1', fieldName: 'La Barrida' } };
const TODAY = '2026-09-17';

function run(raw: Record<string, unknown>): { cmd?: Record<string, unknown>; errors?: string[] } {
  const def = FORM_DEFINITIONS.add_livestock;
  const payload = unflattenFlowPayload(def, raw);
  const validated = validateFormPayload(def, payload, TODAY);
  if (!validated.ok) return { errors: validated.errors };
  return { cmd: buildFormCommand('add_livestock', validated.data, REFS) };
}

describe('alta de hacienda — parseo del nfm_reply + casteo (Fase 4)', () => {
  it('count→número, unit_price→número, event_date ISO; ARS → unit_price_ars', () => {
    const { cmd } = run({
      flow_token: 'alta-hacienda:9:uuid', category: 'novillo', count: '42', breed: 'angus',
      location: 'p:1', unit_price: '850000', currency: 'ARS', event_date: '2026-09-17', notes: 'compra La Rural',
    });
    expect(cmd!.command).toBe('add_livestock');
    expect(cmd!.count).toBe(42);
    expect(typeof cmd!.count).toBe('number');
    expect(cmd!.unit_price_ars).toBe(850000);
    expect(cmd!.unit_price_usd).toBeUndefined();
    expect(cmd!.eventDate).toBe('2026-09-17');
    expect(cmd!.category).toBe('novillo');
    expect(cmd!.breed).toBe('angus');
    expect(cmd!.notes).toBe('compra La Rural');
  });

  it('currency=USD → unit_price_usd', () => {
    const { cmd } = run({
      category: 'toro', count: '2', location: 'p:1', unit_price: '3000', currency: 'USD', event_date: '2026-09-17',
    });
    expect(cmd!.unit_price_usd).toBe(3000);
    expect(cmd!.unit_price_ars).toBeUndefined();
  });

  it('opcionales vacíos ("") → null / ausente, nunca cadena vacía', () => {
    const { cmd } = run({
      category: 'vaca', count: '10', breed: '', location: 'p:1',
      unit_price: '', currency: '', event_date: '2026-09-17', notes: '',
    });
    expect(cmd!.breed).toBeNull();
    expect(cmd!.notes).toBeNull();
    expect(cmd!.unit_price_ars).toBeUndefined();
    expect(cmd!.unit_price_usd).toBeUndefined();
  });

  it('count no numérico → error de validación (el webhook avisa, no explota)', () => {
    const { cmd, errors } = run({ category: 'vaca', count: 'muchas', location: 'p:1', event_date: '2026-09-17' });
    expect(cmd).toBeUndefined();
    expect(errors!.length).toBeGreaterThan(0);
  });

  it('faltan requeridos (category/count) → errores, no comando', () => {
    const { cmd, errors } = run({ location: 'p:1', event_date: '2026-09-17' });
    expect(cmd).toBeUndefined();
    expect(errors!.length).toBeGreaterThan(0);
  });

  it('event_date futura → rechazada (noFuture)', () => {
    const { cmd, errors } = run({ category: 'vaca', count: '3', location: 'p:1', event_date: '2027-01-01' });
    expect(cmd).toBeUndefined();
    expect(errors!.some(e => e.toLowerCase().includes('futura'))).toBe(true);
  });
});
