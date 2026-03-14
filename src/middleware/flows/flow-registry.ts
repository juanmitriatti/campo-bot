import type { FlowState } from '../../types/index.js';
import type { FlowDefinition } from './flow.interface.js';

export class FlowRegistry {
  private flows = new Map<FlowState, FlowDefinition>();

  register(flow: FlowDefinition): void {
    this.flows.set(flow.id, flow);
  }

  get(state: FlowState): FlowDefinition | undefined {
    return this.flows.get(state);
  }

  has(state: FlowState): boolean {
    return this.flows.has(state);
  }
}
