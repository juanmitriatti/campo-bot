/**
 * Pedido de soporte / frustración con el bot + botonera de "no entendí" (oct 2026).
 * Ambos regex están anclados: un mensaje con contenido propio NO es soporte.
 */
import { describe, it, expect } from 'vitest';
import { isSupportOrFrustration } from '../lexicon.js';
import { parseCommand } from '../parser.js';
import { detectDomainButton, unknownFallbackButtons, allUnknownFallbackButtons } from '../../middleware/unknown-fallback.js';
import { CALLBACK_MAP } from '../../domain/interactive/interactive.router.js';

describe('SUPPORT_REQUEST_RE / FRUSTRATION_RE (lexicon)', () => {
  it.each([
    'quiero hablar con una persona',
    'Hola, necesito hablar con alguien',
    'puedo hablar con un humano?',
    'soporte',
    'Soporte técnico',
    'atención al cliente',
    'cómo hago para hablar con soporte',
    'tengo un reclamo',
  ])('pedido de soporte: «%s»', (msg) => {
    expect(isSupportOrFrustration(msg).support).toBe(true);
    expect(isSupportOrFrustration(msg).frustrated).toBe(false);
  });

  it.each([
    'no me entendés nada',
    'No me entendes',
    'esto no sirve',
    'no funciona',
    'sos un inútil',
    'qué bot inútil',
    'no entiendo nada de lo que decís',
    'me tenés podrido',
    'dejá de preguntarme lo mismo',
    'siempre me decís lo mismo!!',
    'no me ayudás en nada',
  ])('frustración: «%s»', (msg) => {
    const r = isSupportOrFrustration(msg);
    expect(r.frustrated).toBe(true);
    expect(r.support).toBe(true);
  });

  it.each([
    'quiero hablar con alguien de Cargill por la soja',
    'hablar con el contratista mañana',
    'no me sirve el glifosato que compré, gasté 50 mil',
    'no funciona la bomba del lote norte',
    'gasté 50 mil en gasoil',
    'no entiendo', // es help, no frustración
    'no sé',
    'acordame hablar con el veterinario el lunes',
    'el tractor no anda, pagué 200 mil de arreglo',
  ])('NO es soporte ni frustración: «%s»', (msg) => {
    expect(isSupportOrFrustration(msg).support).toBe(false);
  });

  it('el parser rutea a `support` con frustrated y rawText; "no entiendo" sigue siendo help', () => {
    const cmd = parseCommand('no me entendés nada!');
    expect(cmd?.command).toBe('support');
    expect(cmd?.frustrated).toBe(true);
    expect(cmd?.rawText).toBe('no me entendés nada!');

    const plain = parseCommand('quiero hablar con una persona');
    expect(plain?.command).toBe('support');
    expect(plain?.frustrated).toBe(false);

    expect(parseCommand('no entiendo')?.command).toBe('help');
    expect(parseCommand('gasté 50 mil en gasoil')?.command).not.toBe('support');
  });
});

describe('unknown-fallback (botonera de "no entendí")', () => {
  it('detecta el dominio por palabra clave y abre la carga guiada de ESO', () => {
    expect(detectDomainButton('la camioneta gastó un montón hoy')?.id).toBe('flow_new_expense');
    expect(detectDomainButton('vendí unas cosas ayer')?.id).toBe('flow_new_income');
    expect(detectDomainButton('cayeron como 20 mm anoche')?.id).toBe('flow_new_rainfall');
    expect(detectDomainButton('fumigamos algo raro')?.id).toBe('flow_new_activity');
    expect(detectDomainButton('las vacas del fondo')?.id).toBe('form_open_livestock');
    expect(detectDomainButton('asdfgh qwerty')).toBeNull();
  });

  it('siempre 3 botones: dominio (o paso a paso), menú y soporte', () => {
    const generic = unknownFallbackButtons('asdfgh qwerty').map(b => b.id);
    expect(generic).toEqual(['cmd_formulario', 'back_menu', 'cmd_soporte']);
    const expense = unknownFallbackButtons('gasto raro').map(b => b.id);
    expect(expense).toEqual(['flow_new_expense', 'back_menu', 'cmd_soporte']);
  });

  it('todo id tiene ruta en CALLBACK_MAP y todo título cabe en 20 unidades UTF-16 (WhatsApp)', () => {
    for (const b of allUnknownFallbackButtons()) {
      expect(CALLBACK_MAP[b.id], `sin ruta: ${b.id}`).toBeDefined();
      expect(b.title.length, `título largo: ${b.title}`).toBeLessThanOrEqual(20);
    }
  });
});
