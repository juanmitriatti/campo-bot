import { getConversationState } from '../services/expenses.js';

interface ConversationMiniMemory {
  lastPlotId: number | null;
  lastFieldId: number | null;
  plotName: string | null;
  fieldName: string | null;
  lastIntent: string | null;
  lastActivityType: string | null;
  lastQueryType: string | null;
  lastTimeReference: string | null;
}

export interface EnrichedText {
  text: string;
  enriched: boolean;
  memory: ConversationMiniMemory | null;
}

// Short follow-up patterns that likely need context from previous message
const FOLLOW_UP_PATTERNS = [
  /^y\s+(esta\s+semana|este\s+mes|ayer|hoy|la\s+semana\s+pasada|el\s+mes\s+pasado)/i,
  /^y\s+(lluvia|fumigaci[oó]n|cosecha|siembra|fertilizaci[oó]n|riego|labran)/i,
  /^y\s+(?:en\s+)?(?:el\s+)?lote\s+/i,
  /^y\s+(?:en\s+)?(?:el\s+)?campo\s+/i,
  /^(?:y\s+)?(?:en|del?)\s+(?:ese|ése|este|aquel)(?:\s|$)/i,
  /^(?:y\s+)?ah[ií](?:\s+|\?|$)/i,
];

// Patterns indicating a query that could reuse last activity type
const REUSE_ACTIVITY_PATTERNS = [
  /^y\s+(esta\s+semana|este\s+mes|ayer|hoy|la\s+semana\s+pasada|el\s+mes\s+pasado)/i,
];

// Patterns indicating query that could reuse last time reference
const REUSE_TIME_PATTERNS = [
  /^y\s+(lluvia|fumigaci[oó]n|cosecha|siembra|fertilizaci[oó]n|riego|labran)/i,
  /^y\s+(?:en\s+)?(?:el\s+)?lote\s+/i,
  /^y\s+(?:en\s+)?(?:el\s+)?campo\s+/i,
];

function isFollowUp(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 80) return false; // Too long to be a follow-up
  return FOLLOW_UP_PATTERNS.some(p => p.test(trimmed));
}

export async function enrichWithContext(text: string, userId: number): Promise<EnrichedText> {
  const trimmed = text.trim();

  if (!isFollowUp(trimmed)) {
    return { text, enriched: false, memory: null };
  }

  const state = await getConversationState(userId);
  if (!state) {
    return { text, enriched: false, memory: null };
  }

  const memory: ConversationMiniMemory = {
    lastPlotId: state.last_plot_id,
    lastFieldId: state.last_field_id,
    plotName: state.plot_name,
    fieldName: state.field_name,
    lastIntent: state.last_intent ?? null,
    lastActivityType: state.last_activity_type ?? null,
    lastQueryType: state.last_query_type ?? null,
    lastTimeReference: state.last_time_reference ?? null,
  };

  // Check if message is recent enough (within 10 minutes)
  const updatedAt = new Date(state.updated_at).getTime();
  const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
  if (updatedAt < tenMinutesAgo) {
    return { text, enriched: false, memory };
  }

  let enrichedText = trimmed;

  // "y esta semana" / "y este mes" etc. → reuse last activity + plot context
  if (REUSE_ACTIVITY_PATTERNS.some(p => p.test(trimmed)) && memory.lastActivityType && memory.plotName) {
    // "y esta semana" → "qué fumigación hubo en lote X esta semana"
    // We don't rewrite the text — instead we pass the memory to the controller
    // which can inject these into the parsed command's extract
    return { text, enriched: true, memory };
  }

  // "y fumigación" / "y en lote X" → reuse last time reference
  if (REUSE_TIME_PATTERNS.some(p => p.test(trimmed)) && memory.lastTimeReference) {
    return { text, enriched: true, memory };
  }

  // "y ahí" / "en ese" → just signal we have plot context
  if (/^(?:y\s+)?(?:ah[ií]|(?:en|del?)\s+(?:ese|ése|este|aquel))(?:\s|$)/i.test(trimmed)) {
    return { text, enriched: true, memory };
  }

  return { text, enriched: false, memory };
}
