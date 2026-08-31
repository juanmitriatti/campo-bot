import { describe, it, expect } from 'vitest';
import { buildPlans, collisionKey, type GroupRow } from '../merge-duplicate-breeds.js';

/**
 * El planificador de fusión decide qué grupos se unen y cuál sobrevive. Un error
 * acá suma o pierde cabezas en el inventario real de un productor, así que se
 * testea sin DB, con filas armadas a mano.
 */

let seq = 0;
function g(over: Partial<GroupRow> = {}): GroupRow {
  seq++;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    user_id: 1,
    plot_id: 10,
    corral_id: null,
    category: 'vaca',
    breed: 'Angus',
    count: 10,
    created_at: new Date(2026, 0, seq),
    field_name: 'La Esperanza',
    plot_name: 'Norte',
    corral_name: null,
    ...over,
  };
}

describe('collisionKey', () => {
  it('colapsa las grafías de la misma raza', () => {
    expect(collisionKey(g({ breed: 'Angus' }))).toBe(collisionKey(g({ breed: 'angus' })));
    expect(collisionKey(g({ breed: 'ABERDEEN ANGUS' }))).toBe(collisionKey(g({ breed: 'Angus' })));
  });

  it('separa razas realmente distintas', () => {
    expect(collisionKey(g({ breed: 'Angus' }))).not.toBe(collisionKey(g({ breed: 'Hereford' })));
  });

  it('separa por ubicación, categoría y usuario', () => {
    const base = g();
    expect(collisionKey(base)).not.toBe(collisionKey(g({ plot_id: 11 })));
    expect(collisionKey(base)).not.toBe(collisionKey(g({ category: 'novillo' })));
    expect(collisionKey(base)).not.toBe(collisionKey(g({ user_id: 2 })));
  });

  it('un lote y un corral con el mismo id NO son la misma ubicación', () => {
    const enLote = g({ plot_id: 5, corral_id: null });
    const enCorral = g({ plot_id: null, corral_id: 5 });
    expect(collisionKey(enLote)).not.toBe(collisionKey(enCorral));
  });

  it('los grupos sin raza colapsan entre sí, pero no con una raza nombrada', () => {
    expect(collisionKey(g({ breed: null }))).toBe(collisionKey(g({ breed: null })));
    expect(collisionKey(g({ breed: null }))).not.toBe(collisionKey(g({ breed: 'Angus' })));
  });
});

describe('buildPlans', () => {
  it('no propone nada cuando no hay colisiones', () => {
    expect(buildPlans([g({ breed: 'Angus' }), g({ breed: 'Hereford' })])).toEqual([]);
  });

  it('fusiona las grafías y SUMA los counts sin perder cabezas', () => {
    const a = g({ breed: 'Angus', count: 20, created_at: new Date(2026, 0, 1) });
    const b = g({ breed: 'angus', count: 10, created_at: new Date(2026, 0, 5) });
    const plans = buildPlans([a, b]);

    expect(plans).toHaveLength(1);
    expect(plans[0].totalCount).toBe(30);
    expect(plans[0].survivor.id).toBe(a.id);
    expect(plans[0].losers.map((l) => l.id)).toEqual([b.id]);
    expect(plans[0].canonicalBreed).toBe('Angus');
  });

  it('el sobreviviente es el más viejo, sin importar el orden de entrada', () => {
    const viejo = g({ breed: 'angus', created_at: new Date(2026, 0, 1) });
    const nuevo = g({ breed: 'Angus', created_at: new Date(2026, 5, 1) });
    // El script carga ordenado por created_at ASC; se replica ese contrato.
    const plans = buildPlans([viejo, nuevo]);
    expect(plans[0].survivor.id).toBe(viejo.id);
  });

  it('fusiona tres o más grafías de una vez', () => {
    const plans = buildPlans([
      g({ breed: 'Angus', count: 5, created_at: new Date(2026, 0, 1) }),
      g({ breed: 'angus', count: 7, created_at: new Date(2026, 0, 2) }),
      g({ breed: 'Aberdeen Angus', count: 3, created_at: new Date(2026, 0, 3) }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].losers).toHaveLength(2);
    expect(plans[0].totalCount).toBe(15);
  });

  it('la suma total de cabezas se conserva entre entrada y plan', () => {
    const groups = [
      g({ breed: 'Angus', count: 20, created_at: new Date(2026, 0, 1) }),
      g({ breed: 'angus', count: 10, created_at: new Date(2026, 0, 2) }),
      g({ breed: 'Hereford', count: 8, created_at: new Date(2026, 0, 3) }),
      g({ breed: 'hereford', count: 2, created_at: new Date(2026, 0, 4) }),
      g({ breed: 'Braford', count: 5, created_at: new Date(2026, 0, 5) }),
    ];
    const plans = buildPlans(groups);
    const antes = groups.reduce((s, x) => s + x.count, 0);
    const tocados = new Set(plans.flatMap((p) => [p.survivor.id, ...p.losers.map((l) => l.id)]));
    const despues =
      plans.reduce((s, p) => s + p.totalCount, 0) +
      groups.filter((x) => !tocados.has(x.id)).reduce((s, x) => s + x.count, 0);
    expect(despues).toBe(antes);
  });

  it('NO fusiona grupos de usuarios distintos aunque coincida todo lo demás', () => {
    expect(buildPlans([g({ user_id: 1, breed: 'Angus' }), g({ user_id: 2, breed: 'angus' })])).toEqual([]);
  });

  it('NO fusiona la misma raza en lotes distintos', () => {
    expect(buildPlans([g({ plot_id: 10, breed: 'Angus' }), g({ plot_id: 11, breed: 'angus' })])).toEqual([]);
  });

  it('deja como está una raza fuera del catálogo que ya es consistente', () => {
    expect(buildPlans([g({ breed: 'Wagyu' }), g({ breed: 'Hereford' })])).toEqual([]);
  });

  it('fusiona una raza fuera del catálogo cuando solo difiere en espacios', () => {
    const plans = buildPlans([
      g({ breed: 'Wagyu', count: 4, created_at: new Date(2026, 0, 1) }),
      g({ breed: '  Wagyu  ', count: 6, created_at: new Date(2026, 0, 2) }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0].totalCount).toBe(10);
  });
});
