import type { FlowState, HandlerResponse, InteractiveMessage, UserId } from '../../types/index.js';

export interface FlowStepValidationSuccess {
  value: unknown;
}

export interface FlowStepValidationError {
  error: string;
}

export type FlowStepValidationResult = FlowStepValidationSuccess | FlowStepValidationError;

export interface FlowStep {
  field: string;
  prompt: string | ((data: Record<string, unknown>) => string);
  promptAsync?: (data: Record<string, unknown>, userId: UserId) => Promise<string>;
  interactive?: InteractiveMessage | ((data: Record<string, unknown>) => InteractiveMessage | null);
  interactiveAsync?: (data: Record<string, unknown>, userId: UserId) => Promise<InteractiveMessage | null>;
  validate: (input: string, data: Record<string, unknown>) => FlowStepValidationResult;
  validateAsync?: (input: string, data: Record<string, unknown>, userId: UserId) => Promise<FlowStepValidationResult>;
  optional?: boolean;
  skipIf?: (data: Record<string, unknown>) => boolean;
}

export interface FlowDefinition {
  id: FlowState;
  name: string;
  steps: FlowStep[];
  buildConfirmation: (data: Record<string, unknown>) => HandlerResponse;
  execute: (userId: UserId, data: Record<string, unknown>) => Promise<HandlerResponse>;
}
