import { apiRequest } from './client';

/** Contrato de POST /api/auth/data-analysis (ver src/routes/data-analysis.routes.ts). */

export interface AnalysisTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnalysisRequest {
  field_id: number | 'all';
  plot_ids?: number[];
  season?: number | null;
  question: string;
  history?: AnalysisTurn[];
}

export interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
}

export interface TruncationNote {
  list: string;
  kept: number;
  total: number;
}

export interface AnalysisResponse {
  answer: string;
  model: string;
  scope: {
    campaign: string;
    from: string;
    to: string;
    fieldIds: number[];
    plotIds: number[] | null;
    fieldNames: string[];
    plotNames: string[];
  };
  truncated: TruncationNote[];
  quota: AiQuota;
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
}

export function postAnalysis(body: AnalysisRequest): Promise<AnalysisResponse> {
  return apiRequest<AnalysisResponse>('/data-analysis', { method: 'POST', body });
}

export function fetchAiQuota(): Promise<{ quota: AiQuota }> {
  return apiRequest<{ quota: AiQuota }>('/data-analysis/quota');
}

/** Nombres legibles de las listas que el servidor puede recortar. */
export const LIST_LABELS: Record<string, string> = {
  expenses: 'gastos',
  incomes: 'ingresos',
  events: 'actividades',
  harvestLoads: 'cargas de cosecha',
  rainfall: 'lluvias',
  stock: 'stock',
  livestockGroups: 'hacienda',
  campaignStats: 'estadísticas por lote',
};
