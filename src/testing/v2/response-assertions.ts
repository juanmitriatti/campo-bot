import type { Assertion, AssertContext } from './types.js';
import { dbRowCount } from './db-assertions.js';

const ASK_MARKERS = [
  '?', 'me falta', 'me faltan', 'cuál', 'cual', 'qué ', 'que ', 'cuánto', 'cuanto',
  'cuántas', 'cuantas', 'en qué', 'en que', 'decime', 'indicá', 'indica',
];

/** Pure: is the bot asking the user for something, or stating an outcome? */
export function classifyResponse(text: string): 'question' | 'statement' {
  const t = text.toLowerCase();
  // A confirmation line ("registrado/registrada") with no trailing question wins as statement.
  const hasConfirmation = /registrad[oa]|guardad[oa]|✅|💰/.test(t);
  // A confirmation PROMPT ("¿Confirmo gasto?", "confirmá", etc.) is also a statement —
  // the bot understood the data and is asking the user to approve, not asking for missing info.
  const hasConfirmPrompt = /confirm|¿confirmo|confirmá|confirmas|dale\?|está bien\?|es correcto/.test(t);
  const hasQuestion = ASK_MARKERS.some((m) => t.includes(m));
  // Return 'question' ONLY when there is a question marker AND neither a confirmation nor a
  // confirm-prompt is present (those indicate the bot has all the data it needs).
  if (hasQuestion && !hasConfirmation && !hasConfirmPrompt) return 'question';
  return 'statement';
}

export function botAsked(): Assertion {
  return {
    label: 'botAsked()',
    run: async (ctx: AssertContext) => {
      const got = classifyResponse(ctx.lastText);
      return { ok: got === 'question', detail: `classified as "${got}" — ${ctx.lastText.slice(0, 80)}` };
    },
  };
}

export function botDidNotAsk(): Assertion {
  return {
    label: 'botDidNotAsk()',
    run: async (ctx: AssertContext) => {
      const got = classifyResponse(ctx.lastText);
      return { ok: got === 'statement', detail: `classified as "${got}" — ${ctx.lastText.slice(0, 80)}` };
    },
  };
}

/** A registration happened: at least one row exists in `table` matching the filter. */
export function botRegistered(table: string, filter: Record<string, string | number>): Assertion {
  const inner = dbRowCount(table, filter, 1);
  return { label: `botRegistered(${table})`, run: inner.run };
}
