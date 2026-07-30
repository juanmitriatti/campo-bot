import { describe, it, expect } from 'vitest';
import { isProactiveAlertType, OPT_OUT_FOOTER } from './alert.service.js';

describe('isProactiveAlertType', () => {
  it.each(['weather', 'monitoring_reminder', 'pest_escalation', 'missing_hectares', 'low_stock', 'phenology'])(
    'marca %s como proactiva', (t) => expect(isProactiveAlertType(t)).toBe(true)
  );
  it.each(['monthly_summary', 'weekly_summary', 'flow_halflife', 'flow_timeout', 'task_reminder'])(
    'NO marca %s como proactiva', (t) => expect(isProactiveAlertType(t)).toBe(false)
  );
});

describe('OPT_OUT_FOOTER', () => {
  it('menciona el comando de opt-out', () => {
    expect(OPT_OUT_FOOTER).toContain('no más alertas');
  });
});
