/**
 * ScenarioRunner — loads JSON scenarios and executes them against the test-bot API.
 * Each scenario: reset → setup → steps → assertions → results.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { TestBotClient, type SendResult } from './test-bot-client.js';
import {
  responseContains,
  responseNotContains,
  hasInteractive,
  hasButton,
  dbHasExpense,
  dbHasIncome,
  dbHasActivity,
  dbHasObservation,
  dbRowCount,
  type AssertionResult,
} from './assertions.js';

// --- Scenario types ---

export interface ScenarioStep {
  send?: string;
  tap?: string;
  wait?: number;
  expect?: StepExpect;
}

export interface StepExpect {
  responseContains?: string[];
  responseNotContains?: string[];
  hasConfirmButton?: boolean;
  hasButtons?: boolean;
  hasList?: boolean;
  buttonExists?: string;
  dbExpense?: { amount?: number; category?: string; description?: string };
  dbIncome?: { amount?: number; category?: string };
  dbActivity?: { eventType?: string; crop?: string; plot?: string };
  dbObservation?: { textContains?: string; category?: string };
  dbRowCount?: { table: string; count: number };
}

export interface Scenario {
  name: string;
  description?: string;
  setup?: string[];
  steps: ScenarioStep[];
}

export interface StepResult {
  stepIndex: number;
  action: string;
  assertions: AssertionResult[];
  responsePreview: string;
  durationMs: number;
}

export interface ScenarioResult {
  name: string;
  description?: string;
  passed: boolean;
  steps: StepResult[];
  durationMs: number;
  error?: string;
}

// --- Runner ---

export class ScenarioRunner {
  private client: TestBotClient;
  private scenariosDir: string;
  private setupSequences: Map<string, ScenarioStep[]> = new Map();
  private verbose: boolean;

  constructor(client: TestBotClient, scenariosDir: string, verbose = false) {
    this.client = client;
    this.scenariosDir = scenariosDir;
    this.verbose = verbose;
  }

  /** Load setup sequences from _setup.json. */
  async loadSetup(): Promise<void> {
    try {
      const raw = await readFile(join(this.scenariosDir, '_setup.json'), 'utf-8');
      const data = JSON.parse(raw) as Record<string, ScenarioStep[]>;
      for (const [key, steps] of Object.entries(data)) {
        this.setupSequences.set(key, steps);
      }
      if (this.verbose) console.log(`  Loaded ${this.setupSequences.size} setup sequences`);
    } catch {
      // No setup file — that's OK
    }
  }

  /** Load all scenario files from the scenarios directory. */
  async loadScenarios(filter?: string): Promise<Scenario[]> {
    const files = await readdir(this.scenariosDir);
    const scenarioFiles = files
      .filter(f => f.endsWith('.json') && !f.startsWith('_'))
      .sort();

    const scenarios: Scenario[] = [];
    for (const file of scenarioFiles) {
      const raw = await readFile(join(this.scenariosDir, file), 'utf-8');
      const scenario = JSON.parse(raw) as Scenario;
      if (filter && scenario.name !== filter && !file.includes(filter)) continue;
      scenarios.push(scenario);
    }
    return scenarios;
  }

  /** Run a single scenario. */
  async runScenario(scenario: Scenario): Promise<ScenarioResult> {
    const start = Date.now();
    const stepResults: StepResult[] = [];

    try {
      // Reset user data
      await this.client.reset();

      // Run setup sequences
      if (scenario.setup) {
        for (const setupName of scenario.setup) {
          const setupSteps = this.setupSequences.get(setupName);
          if (!setupSteps) {
            return {
              name: scenario.name,
              description: scenario.description,
              passed: false,
              steps: [],
              durationMs: Date.now() - start,
              error: `Unknown setup sequence: "${setupName}"`,
            };
          }
          if (this.verbose) console.log(`    Setup: ${setupName} (${setupSteps.length} steps)`);
          for (let i = 0; i < setupSteps.length; i++) {
            const step = setupSteps[i];
            try {
              const result = await this.executeStep(step, -1);
              if (this.verbose && result.responsePreview) {
                console.log(`      setup[${i}]: ${result.action} → "${result.responsePreview.slice(0, 80)}..."`);
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                name: scenario.name,
                description: scenario.description,
                passed: false,
                steps: [],
                durationMs: Date.now() - start,
                error: `Setup "${setupName}" failed at step ${i}: ${msg}`,
              };
            }
          }
        }
      }

      // Run scenario steps
      for (let i = 0; i < scenario.steps.length; i++) {
        const step = scenario.steps[i];
        const stepResult = await this.executeStep(step, i);
        stepResults.push(stepResult);
      }

      const passed = stepResults.every(sr => sr.assertions.every(a => a.pass));
      return {
        name: scenario.name,
        description: scenario.description,
        passed,
        steps: stepResults,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const err = error as Error;
      return {
        name: scenario.name,
        description: scenario.description,
        passed: false,
        steps: stepResults,
        durationMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  /** Run all loaded scenarios. */
  async runAll(scenarios: Scenario[]): Promise<ScenarioResult[]> {
    const results: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      if (this.verbose) console.log(`\n  Running: ${scenario.name}`);
      const result = await this.runScenario(scenario);
      results.push(result);

      // Print inline progress
      const icon = result.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      const assertionCount = result.steps.reduce((sum, s) => sum + s.assertions.length, 0);
      const failCount = result.steps.reduce((sum, s) => sum + s.assertions.filter(a => !a.pass).length, 0);
      console.log(`  ${icon} ${result.name} (${assertionCount} assertions, ${failCount} failed, ${result.durationMs}ms)`);

      if (!result.passed) {
        // Always show failure details (not just in verbose mode)
        for (const step of result.steps) {
          for (const a of step.assertions) {
            if (!a.pass) {
              console.log(`    \x1b[31m  Step ${step.stepIndex}: ${a.name} — ${a.message}\x1b[0m`);
            }
          }
        }
        if (result.error) console.log(`    \x1b[31m  Error: ${result.error}\x1b[0m`);
      }
    }
    return results;
  }

  // --- Private ---

  private async executeStep(step: ScenarioStep, stepIndex: number): Promise<StepResult> {
    const stepStart = Date.now();
    let result: SendResult | null = null;
    let action = '';

    if (step.wait) {
      action = `wait ${step.wait}ms`;
      await new Promise(resolve => setTimeout(resolve, step.wait));
    } else if (step.send) {
      action = `send: "${step.send}"`;
      result = await this.client.send(step.send);
    } else if (step.tap) {
      action = `tap: "${step.tap}"`;
      result = await this.client.tap(step.tap);
    }

    if (this.verbose && result && stepIndex >= 0) {
      const preview = TestBotClient.allText(result).slice(0, 120);
      console.log(`      Step ${stepIndex}: ${action} → "${preview}..."`);
    }

    // Apply assertions
    const assertions: AssertionResult[] = [];
    if (step.expect && result) {
      const e = step.expect;

      if (e.responseContains) {
        assertions.push(responseContains(result, e.responseContains));
      }
      if (e.responseNotContains) {
        assertions.push(responseNotContains(result, e.responseNotContains));
      }
      if (e.hasConfirmButton) {
        assertions.push(hasButton(result, 'confirm_pending'));
      }
      if (e.hasButtons) {
        assertions.push(hasInteractive(result, 'buttons'));
      }
      if (e.hasList) {
        assertions.push(hasInteractive(result, 'list'));
      }
      if (e.buttonExists) {
        assertions.push(hasButton(result, e.buttonExists));
      }
      if (e.dbExpense) {
        assertions.push(await dbHasExpense(this.client, e.dbExpense));
      }
      if (e.dbIncome) {
        assertions.push(await dbHasIncome(this.client, e.dbIncome));
      }
      if (e.dbActivity) {
        assertions.push(await dbHasActivity(this.client, e.dbActivity));
      }
      if (e.dbObservation) {
        assertions.push(await dbHasObservation(this.client, e.dbObservation));
      }
      if (e.dbRowCount) {
        assertions.push(await dbRowCount(this.client, e.dbRowCount.table, e.dbRowCount.count));
      }
    }

    const responsePreview = result ? TestBotClient.allText(result).slice(0, 200) : '';
    return {
      stepIndex,
      action,
      assertions,
      responsePreview,
      durationMs: Date.now() - stepStart,
    };
  }
}
