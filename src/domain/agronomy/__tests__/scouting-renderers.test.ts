/**
 * renderEmpty de scoutings (Jul 2026): el empty-state decía "No hay
 * monitoreos — lote Norte" y abajo "Datos cargados: malezas..." SIN aclarar
 * que esos datos son de TODOS los lotes → leía como contradicción (reporte
 * de prod: "este mensaje no lo entiendo").
 */
import { describe, it, expect } from 'vitest';
import { renderEmpty, type ScoutingRenderCtx } from '../scouting-renderers.js';

function ctx(partial: Partial<ScoutingRenderCtx> = {}): ScoutingRenderCtx {
  return {
    rangeLabel: 'Todo el historial',
    scope: '',
    isAll: true,
    filters: {},
    ...partial,
  } as ScoutingRenderCtx;
}

describe('renderEmpty — empty-state comprensible', () => {
  it('con filtro de lote y datos en otros lados: aclara que la lista es del total y sugiere ampliar', () => {
    const r = renderEmpty(
      ctx({ scope: ' — lote Norte', filters: { plotName: 'Norte', hasWeeds: true } }),
      { weeds: ['yuyo colorado', 'rama negra'], pests: ['chinche'], stages: ['V6'] },
    );
    const msg = r.messages[0];
    expect(msg).toContain('No encontré monitoreos que coincidan — lote Norte');
    // La lista debe estar atribuida al TOTAL, no flotando como "Datos cargados:"
    expect(msg).toMatch(/total de tus monitoreos.*todos los lotes/i);
    expect(msg).toContain('yuyo colorado');
    expect(msg).not.toContain('Datos cargados:');
    // Sugerencia accionable para salir del filtro heredado
    expect(msg).toContain('todos los lotes');
    expect(msg).toContain('💡');
  });

  it('sin ningún dato cargado: mensaje simple con cómo registrar', () => {
    const r = renderEmpty(ctx());
    const msg = r.messages[0];
    expect(msg).toContain('No encontré monitoreos');
    expect(msg).toMatch(/registr|soja V3/i);
  });
});
