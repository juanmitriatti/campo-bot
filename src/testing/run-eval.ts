#!/usr/bin/env npx tsx
/**
 * run-eval.ts — CLI entry point for conversational eval framework.
 *
 * Usage:
 *   npx tsx src/testing/run-eval.ts --all              # Run all scenarios
 *   npx tsx src/testing/run-eval.ts --scenario basic-expense  # Run one
 *   npx tsx src/testing/run-eval.ts --all --verbose     # Detailed output
 *
 * Env vars:
 *   EVAL_BASE_URL  — Server URL (default: http://localhost:3000)
 *   EVAL_EMAIL     — Test user email (default: eval@campo.test)
 *   EVAL_PASSWORD  — Test user password (default: evalpass123)
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestBotClient } from './test-bot-client.js';
import { ScenarioRunner, type ScenarioResult } from './scenario-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Parse CLI args ---

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const runAll = args.includes('--all');
const scenarioIdx = args.indexOf('--scenario');
const scenarioFilter = scenarioIdx >= 0 ? args[scenarioIdx + 1] : undefined;

if (!runAll && !scenarioFilter) {
  console.log('Usage:');
  console.log('  npx tsx src/testing/run-eval.ts --all [--verbose]');
  console.log('  npx tsx src/testing/run-eval.ts --scenario <name> [--verbose]');
  process.exit(0);
}

// --- Config ---

const baseUrl = process.env.EVAL_BASE_URL || 'http://localhost:3000';
const email = process.env.EVAL_EMAIL || 'eval@campo.test';
const password = process.env.EVAL_PASSWORD || 'evalpass123';
const scenariosDir = join(__dirname, 'scenarios');

// --- Main ---

async function main(): Promise<void> {
  const totalStart = Date.now();

  console.log('\n=== Campo-Bot Eval Framework ===');
  console.log(`  Server: ${baseUrl}`);
  console.log(`  User:   ${email}`);

  // 1. Connect & authenticate
  const client = new TestBotClient(baseUrl);
  try {
    await client.ensureUser(email, password, 'Eval User');
    console.log('  Auth:   OK\n');
  } catch (err: unknown) {
    console.error(`\n  Auth FAILED: ${(err as Error).message}`);
    console.error('  Is the server running? Try: docker compose up -d\n');
    process.exit(1);
  }

  // 2. Load scenarios
  const runner = new ScenarioRunner(client, scenariosDir, verbose);
  await runner.loadSetup();

  const scenarios = await runner.loadScenarios(scenarioFilter);
  if (scenarios.length === 0) {
    console.error(`  No scenarios found${scenarioFilter ? ` matching "${scenarioFilter}"` : ''}`);
    process.exit(1);
  }

  console.log(`  Scenarios: ${scenarios.length}\n`);

  // 3. Run
  const results = await runner.runAll(scenarios);

  // 4. Summary
  printSummary(results, Date.now() - totalStart);

  // 5. Exit code
  const allPassed = results.every(r => r.passed);
  process.exit(allPassed ? 0 : 1);
}

function printSummary(results: ScenarioResult[], totalMs: number): void {
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalAssertions = results.reduce(
    (sum, r) => sum + r.steps.reduce((s, st) => s + st.assertions.length, 0),
    0,
  );
  const failedAssertions = results.reduce(
    (sum, r) => sum + r.steps.reduce((s, st) => s + st.assertions.filter(a => !a.pass).length, 0),
    0,
  );

  console.log('\n' + '='.repeat(50));
  console.log('  EVAL SUMMARY');
  console.log('='.repeat(50));
  console.log(`  Scenarios:  ${passed} passed, ${failed} failed (${results.length} total)`);
  console.log(`  Assertions: ${totalAssertions - failedAssertions} passed, ${failedAssertions} failed (${totalAssertions} total)`);
  console.log(`  Duration:   ${(totalMs / 1000).toFixed(1)}s`);

  if (failed > 0) {
    console.log('\n  Failed scenarios:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    \x1b[31m- ${r.name}\x1b[0m`);
      if (r.error) console.log(`      Error: ${r.error}`);
      for (const step of r.steps) {
        for (const a of step.assertions) {
          if (!a.pass) {
            console.log(`      Step ${step.stepIndex} [${a.name}]: ${a.message}`);
          }
        }
      }
    }
  }

  console.log('');
  if (failed === 0) {
    console.log('  \x1b[32mAll scenarios passed!\x1b[0m\n');
  } else {
    console.log(`  \x1b[31m${failed} scenario(s) failed\x1b[0m\n`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
