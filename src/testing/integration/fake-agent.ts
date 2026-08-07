/**
 * FakeAgentService — doble determinístico del agente Claude para tests de
 * integración del pipeline. Devuelve tool_calls PREFIJADOS (cero API, cero
 * costo, cero no-determinismo) y graba con qué texto fue invocado, así los
 * tests pueden asertar sobre las capas previas (pronoun-expander, hints de
 * pending) y sobre si el agente fue llamado o no (los pendings/correcciones
 * deben consumirse ANTES de llegar al agente).
 *
 * Uso: intentClassifier.setAgentServiceForTests(fake) — ver pipeline-harness.ts.
 */
import type { AgentResult, AgentToolCall } from '../../ai/agent.service.js';
import type { UserId, UserSettings } from '../../types/index.js';

export interface FakeAgentCall {
  text: string;
  pendingHint: string | null;
  userId: UserId;
}

let toolUseSeq = 0;

export class FakeAgentService {
  /** Todas las invocaciones recibidas, en orden. */
  public calls: FakeAgentCall[] = [];
  private queue: Array<AgentResult | Error> = [];

  /** Programa un FALLO del agente en el próximo turno (timeout/5xx/créditos). */
  enqueueError(message = 'fake anthropic 529'): void {
    this.queue.push(new Error(message));
  }

  /** Programa la respuesta del PRÓXIMO turno del agente. */
  enqueue(
    toolCalls: Array<{ toolName: string; toolInput: Record<string, unknown> }>,
    conversationalText: string | null = null,
    recentUserText?: string,
  ): void {
    const calls: AgentToolCall[] = toolCalls.map(tc => ({
      toolName: tc.toolName,
      toolInput: tc.toolInput,
      toolUseId: `fake_toolu_${++toolUseSeq}`,
    }));
    this.queue.push({
      toolCalls: calls,
      conversationalText,
      usage: { input_tokens: 0, output_tokens: 0 },
      truncated: false,
      // Historial reciente del usuario (turnos previos): simula lo que el agente
      // real arma para que el output-validator no dropee un crop dicho un turno
      // antes (bug live "Quiero sembrar soja" → "Norte").
      recentUserText,
    });
  }

  /** Azúcar: respuesta de un solo tool_use. */
  enqueueTool(toolName: string, toolInput: Record<string, unknown>): void {
    this.enqueue([{ toolName, toolInput }]);
  }

  /** Misma firma que AgentService.extract — la seam del classifier. */
  async extract(
    text: string,
    _preprocessed: string,
    userId: UserId,
    _settings: UserSettings,
    pendingHint: string | null = null,
  ): Promise<AgentResult | null> {
    this.calls.push({ text, pendingHint, userId });
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    if (next) return next;
    // Sin respuesta programada: el test no esperaba que el agente fuera
    // llamado en este turno. Devolvemos texto marcador para que el fallo
    // sea evidente en la aserción (y NO null, que activaría el regex fallback
    // y enmascararía el problema).
    return {
      toolCalls: [],
      conversationalText: `FAKE_AGENT_SIN_RESPUESTA_PROGRAMADA: "${text.slice(0, 80)}"`,
      usage: { input_tokens: 0, output_tokens: 0 },
      truncated: false,
    };
  }

  reset(): void {
    this.calls = [];
    this.queue = [];
  }
}
