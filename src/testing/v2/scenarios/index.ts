import type { Scenario } from '../types.js';
import { WRITTEN_CORE } from './written-core.js';
import { PROD_SEEDED } from './prod-seeded.js';

export const ALL_SCENARIOS: Scenario[] = [...WRITTEN_CORE, ...PROD_SEEDED];
