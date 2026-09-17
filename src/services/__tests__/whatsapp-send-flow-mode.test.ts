// sendFlow arma el mensaje interactive de un WhatsApp Flow. La clave `mode`
// SOLO debe viajar cuando es draft: un Flow publicado va sin ella (Meta rechaza
// `mode: "published"`). Gap A del alta de hacienda.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const postMock = vi.fn(async () => ({ data: {} }));
vi.mock('axios', () => ({ default: { post: (...a: unknown[]) => postMock(...a) } }));
vi.mock('../error-logger.js', () => ({ logError: vi.fn(async () => {}) }));

const { sendFlow } = await import('../whatsapp.js');

function sentInteractive() {
  const body = postMock.mock.calls[0][1] as { interactive: { action: { parameters: Record<string, unknown> } } };
  return body.interactive.action.parameters;
}

describe('sendFlow — la clave `mode`', () => {
  beforeEach(() => { postMock.mockClear(); });

  const flow = (mode?: 'draft') => ({
    flowId: '944223028085227', flowToken: 'tok', cta: 'Cargar',
    data: { category_options: [], category_init: '' },
    ...(mode ? { mode } : {}),
  });

  it('con mode=draft incluye "mode":"draft" en los parameters', async () => {
    await sendFlow('549341000000', 'Cargá el movimiento de hacienda.', flow('draft'));
    const params = sentInteractive();
    expect(params.mode).toBe('draft');
    expect(params.flow_id).toBe('944223028085227');
    expect(params.flow_action).toBe('navigate');
    expect((params.flow_action_payload as { screen: string }).screen).toBe('FORM');
  });

  it('sin mode (publicado) la clave `mode` NO aparece', async () => {
    await sendFlow('549341000000', 'Cargá el movimiento de hacienda.', flow(undefined));
    const params = sentInteractive();
    expect('mode' in params).toBe(false);
  });
});
