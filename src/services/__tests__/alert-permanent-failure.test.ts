import { describe, it, expect } from 'vitest';
import { permanentSendFailureReason } from '../alert.service.js';

/**
 * Clasificación permanente vs transitorio en el envío de alertas.
 *
 * Los mensajes de error de acá salen de error_logs de PRODUCCIÓN — son los
 * que efectivamente se reintentaban en vano: 3 intentos por cada resumen
 * mensual a una cuenta de Telegram desactivada, todos los días 1 desde junio;
 * y 4 intentos por alerta contra la API de WhatsApp, que en este deploy ni
 * siquiera está configurada.
 */

describe('permanentSendFailureReason — errores reales de producción', () => {
  it.each([
    ['Telegram sendMessage failed: 403 {"ok":false,"error_code":403,"description":"Forbidden: user is deactivated"}', 'cuenta desactivada'],
    ['WhatsApp sendMessage failed: 401 — Invalid OAuth access token - Cannot parse access token', 'token inválido'],
    ['WhatsApp deshabilitado temporalmente: token inválido (circuit breaker abierto, renovar WHATSAPP_TOKEN en Meta)', 'circuit breaker'],
    ['Request failed with status code 401', '401'],
  ])('reconoce como permanente: %s', (msg, expectedFragment) => {
    const reason = permanentSendFailureReason(new Error(msg));
    expect(reason, `no clasificó: ${msg}`).not.toBeNull();
    expect(reason!.toLowerCase()).toContain(expectedFragment.toLowerCase());
  });

  it('reconoce las otras variantes de 403 de Telegram', () => {
    expect(permanentSendFailureReason(new Error('Forbidden: bot was blocked by the user'))).toContain('bloqueado');
    expect(permanentSendFailureReason(new Error('Bad Request: chat not found'))).toContain('inexistente');
  });
});

describe('permanentSendFailureReason — lo transitorio SÍ se reintenta', () => {
  it.each([
    'Telegram sendMessage failed: 500 Internal Server Error',
    'Bad Gateway',
    'socket hang up',
    'ETIMEDOUT',
    'Request failed with status code 502',
    'Too Many Requests: retry after 30',
  ])('no marca permanente: %s', (msg) => {
    expect(permanentSendFailureReason(new Error(msg)), `marcó permanente de más: ${msg}`).toBeNull();
  });

  it('un 429 no es permanente aunque sea un rechazo del canal', () => {
    // Rate limit = reintentar más tarde, no rendirse.
    expect(permanentSendFailureReason(new Error('Request failed with status code 429'))).toBeNull();
  });
});

describe('permanentSendFailureReason — entradas degeneradas', () => {
  it('no rompe con null, undefined ni vacío', () => {
    expect(permanentSendFailureReason(null)).toBeNull();
    expect(permanentSendFailureReason(undefined)).toBeNull();
    expect(permanentSendFailureReason('')).toBeNull();
    expect(permanentSendFailureReason(new Error(''))).toBeNull();
  });

  it('acepta un string suelto además de un Error', () => {
    // sendMessageWithRetry devuelve result.error como string, no como Error.
    expect(permanentSendFailureReason('Invalid OAuth access token')).toContain('token inválido');
  });

  it('no confunde un 401 que aparece dentro de otro número', () => {
    expect(permanentSendFailureReason(new Error('procesados 14016 registros'))).toBeNull();
  });
});
