import { describe, it, expect } from 'vitest';
import { parseHarvestCostText } from '../slot-extractor.js';

describe('parseHarvestCostText — respuesta libre al pending de costo de cosecha', () => {
  it('porcentaje del contratista', () => {
    expect(parseHarvestCostText('8%')).toMatchObject({ contractorPct: 8, freightPerTn: null });
    expect(parseHarvestCostText('el contratista cobra 7,5 %')).toMatchObject({ contractorPct: 7.5 });
  });

  it('$ por hectárea y totales en formatos argentinos', () => {
    expect(parseHarvestCostText('45.000 por ha')).toMatchObject({ contractorPerHa: 45000, contractorTotal: null });
    expect(parseHarvestCostText('45 mil la hectárea')).toMatchObject({ contractorPerHa: 45000 });
    expect(parseHarvestCostText('3.200.000 total')).toMatchObject({ contractorTotal: 3200000 });
    expect(parseHarvestCostText('3,2 millones')).toMatchObject({ contractorTotal: 3200000 });
  });

  it('flete por tonelada o total, solo o combinado con el contratista', () => {
    expect(parseHarvestCostText('flete 18.000 por tn')).toMatchObject({ freightPerTn: 18000, contractorPct: null, contractorTotal: null });
    expect(parseHarvestCostText('8% y flete 18 mil la tonelada')).toMatchObject({ contractorPct: 8, freightPerTn: 18000 });
    expect(parseHarvestCostText('45.000 por ha, flete 900.000 total')).toMatchObject({ contractorPerHa: 45000, freightTotal: 900000 });
    // "por tn" sin la palabra flete sigue siendo flete: el contratista no cobra por tonelada
    expect(parseHarvestCostText('18.000 por tn')).toMatchObject({ freightPerTn: 18000, contractorTotal: null });
  });

  it('moneda', () => {
    expect(parseHarvestCostText('USD 9.000 total').currency).toBe('USD');
    expect(parseHarvestCostText('9.000 dólares').currency).toBe('USD');
    expect(parseHarvestCostText('45.000 por ha').currency).toBeNull();
  });

  it('texto sin números → todo null', () => {
    expect(parseHarvestCostText('después te digo')).toMatchObject({ contractorPct: null, contractorPerHa: null, contractorTotal: null, freightPerTn: null, freightTotal: null });
  });
});
