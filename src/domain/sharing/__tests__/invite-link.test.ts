import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings: Record<string, string> = {};
vi.mock('../../../services/settings.service.js', () => ({
  getSetting: vi.fn(async (k: string) => settings[k] ?? null),
}));

import { buildInviteDelivery, renderInviteMessage, inviteText } from '../invite-link.js';

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
});

describe('buildInviteDelivery', () => {
  it('arma el link wa.me con el texto que redime la invitación', async () => {
    settings.WHATSAPP_BOT_NUMBER = '5492364469135';
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    expect(d.waText).toBe('unirme A3F7K2');
    expect(d.waLink).toBe('https://wa.me/5492364469135?text=unirme%20A3F7K2');
  });

  it('el número del bot se limpia: se pega tal cual lo escribió el admin', async () => {
    settings.WHATSAPP_BOT_NUMBER = '+54 9 2364 46-9135';
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    expect(d.waLink).toBe('https://wa.me/5492364469135?text=unirme%20A3F7K2');
  });

  it('SIN número de bot configurado no rompe: cae al código pelado', async () => {
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    expect(d.waLink).toBeNull();
    expect(d.code).toBe('A3F7K2');
    expect(d.waText).toBe('unirme A3F7K2');
  });

  it('el link de alta guiada lleva el código, para el invitado sin cuenta', async () => {
    settings.PUBLIC_URL = 'https://campo.example.com/';
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    expect(d.registerLink).toBe('https://campo.example.com/register?invite=A3F7K2');
  });

  it('sin PUBLIC_URL válida no inventa un link', async () => {
    settings.PUBLIC_URL = 'no-es-una-url';
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    expect(d.registerLink).toBeNull();
  });
});

describe('renderInviteMessage', () => {
  it('el link y el texto llevan el MISMO código', async () => {
    settings.WHATSAPP_BOT_NUMBER = '5492364469135';
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    const msg = renderInviteMessage({ fieldName: 'La Esperanza', delivery: d });
    // Dos textos armados por separado serían dos códigos distintos en la misma
    // pantalla: por eso esto vive en un solo lugar.
    const codes = [...msg.matchAll(/A3F7K2/g)];
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect(msg).toContain('La Esperanza');
    expect(msg).toContain(d.waLink!);
  });

  it('avisa que la invitación es de un solo número cuando está atada', async () => {
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    const msg = renderInviteMessage({
      fieldName: 'La Esperanza',
      delivery: d,
      invitedPhone: '5492364469135',
    });
    expect(msg).toMatch(/Solo ese número/i);
  });

  it('sin número de bot, el mensaje sigue diciendo qué escribir', async () => {
    const d = await buildInviteDelivery({ code: 'A3F7K2' });
    const msg = renderInviteMessage({ fieldName: 'La Esperanza', delivery: d });
    expect(msg).toContain(inviteText('A3F7K2'));
    expect(msg).not.toContain('wa.me');
  });
});
