import { defineConfig } from 'vitest/config';

// Timeouts holgados para los tests que hacen bcrypt de verdad (registro/login,
// 12 rounds): con la suite completa compitiendo por CPU —y más en el runner de
// CI— rozaban los 5 s por defecto y fallaban sin ser una regresión (CLAUDE.md
// § Tests lo documenta como flake conocido). 20 s no esconde nada: un test
// colgado sigue fallando, solo que sin falsos positivos por carga.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 40_000,
    // Cada worker abre su pool (10 conexiones): con 14 CPUs y 208 archivos se
    // pasaban las 100 de Postgres ("too many clients", nov 2026).
    maxWorkers: 6,
    minWorkers: 1,
  },
});
