import { describe, it, expect } from 'vitest';
import { buildWhere } from './db-assertions.js';

describe('buildWhere', () => {
  it('builds a parameterized clause skipping undefined values', () => {
    const { clause, params } = buildWhere({ category: 'Combustible', amount: 50000, plot_id: undefined }, 7);
    expect(clause).toBe('user_id = $1 AND deleted_at IS NULL AND category = $2 AND amount = $3');
    expect(params).toEqual([7, 'Combustible', 50000]);
  });

  it('supports a numeric tolerance for amount-like fields via {op,value}', () => {
    const { clause, params } = buildWhere({ amount: { op: '>=', value: 100 } }, 3);
    expect(clause).toBe('user_id = $1 AND deleted_at IS NULL AND amount >= $2');
    expect(params).toEqual([3, 100]);
  });

  it('omits the deleted_at guard when includeDeleted is true', () => {
    const { clause } = buildWhere({ category: 'X' }, 1, { includeDeleted: true });
    expect(clause).toBe('user_id = $1 AND category = $2');
  });
});
