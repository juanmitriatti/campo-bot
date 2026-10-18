import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Request, Response } from 'express';
import { pool } from '../../config/db.js';
import {
  SOURCE_COOKIE, phoneHash, touchFromReferral, webSourceFromQuery, encodeSourceCookie,
  decodeSourceCookie, captureWebSource, recordWhatsAppReferral, recordWebSignup, acquisitionReport,
} from '../acquisition.service.js';

let dbAvailable = true;
try {
  await pool.query('SELECT 1 FROM acquisition_touches LIMIT 1');
} catch {
  dbAvailable = false;
}

function fakeReq(opts: { query?: Record<string, unknown>; cookie?: string; method?: string; path?: string }): Request {
  return {
    method: opts.method ?? 'GET',
    path: opts.path ?? '/',
    query: opts.query ?? {},
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    get: () => undefined,
  } as unknown as Request;
}

function fakeRes() {
  const cookies: Record<string, string> = {};
  const cleared: string[] = [];
  const res = {
    cookie: (name: string, value: string) => { cookies[name] = value; },
    clearCookie: (name: string) => { cleared.push(name); },
  } as unknown as Response;
  return { res, cookies, cleared };
}

describe('origen de la visita web', () => {
  it('sin utm_/fbclid/gclid no hay origen', () => {
    expect(webSourceFromQuery({ q: 'x' }, '/', undefined)).toBeNull();
  });

  it('utm_* se copian; fbclid solo = facebook pago', () => {
    const t = webSourceFromQuery({ utm_source: 'instagram', utm_campaign: 'siembra-oct' }, '/', 'https://l.instagram.com/');
    expect(t).toMatchObject({ channel: 'web', source: 'instagram', campaign: 'siembra-oct', landingPath: '/', referrer: 'https://l.instagram.com/' });
    expect(webSourceFromQuery({ fbclid: 'abc' }, '/', undefined)).toMatchObject({ source: 'facebook', medium: 'paid', clickId: 'abc' });
  });

  it('la cookie hace ida y vuelta, y una cookie rota o ajena no rompe nada', () => {
    const t = webSourceFromQuery({ utm_source: 'ig' }, '/precios', undefined)!;
    expect(decodeSourceCookie(encodeSourceCookie(t))).toMatchObject({ source: 'ig', landingPath: '/precios' });
    expect(decodeSourceCookie('no-es-base64-json')).toBeNull();
    expect(decodeSourceCookie(Buffer.from(JSON.stringify({ channel: 'whatsapp' })).toString('base64url'))).toBeNull();
    const long = encodeSourceCookie({ channel: 'web', source: 'x'.repeat(5000) });
    expect(decodeSourceCookie(long)!.source!.length).toBe(300);
  });

  it('el middleware pone la cookie en la primera visita y no pisa el primer toque', () => {
    const next = vi.fn();
    const first = fakeRes();
    captureWebSource(fakeReq({ query: { utm_source: 'ig' } }), first.res, next);
    expect(first.cookies[SOURCE_COOKIE]).toBeTruthy();

    const second = fakeRes();
    captureWebSource(fakeReq({ query: { utm_source: 'google' }, cookie: `${SOURCE_COOKIE}=${first.cookies[SOURCE_COOKIE]}` }), second.res, next);
    expect(second.cookies[SOURCE_COOKIE]).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('referral de WhatsApp', () => {
  it('anuncio → meta_ad con id, título y ctwa_clid', () => {
    const t = touchFromReferral('5491112345678', {
      source_type: 'ad', source_id: '120200', headline: 'Registrá tu campo hablando', ctwa_clid: 'clid-1',
      source_url: 'https://fb.me/x',
    });
    expect(t).toMatchObject({ channel: 'whatsapp', source: 'meta_ad', medium: 'click_to_whatsapp', adId: '120200', clickId: 'clid-1' });
    expect(t.phoneHash).toBe(phoneHash('+54 9 11 1234-5678'));
  });
});

describe.skipIf(!dbAvailable)('acquisition_touches + reporte', () => {
  const PHONE = '5491199990136';
  let waUser = 0;
  let webUser = 0;

  beforeAll(async () => {
    await pool.query(`DELETE FROM acquisition_touches WHERE phone_hash = $1 OR campaign = 'acq-test'`, [phoneHash(PHONE)]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM acquisition_touches WHERE phone_hash = $1 OR campaign = 'acq-test'`, [phoneHash(PHONE)]);
    for (const id of [waUser, webUser].filter(Boolean)) {
      await pool.query('DELETE FROM subscriptions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  it('el anuncio de WhatsApp de alguien SIN cuenta se atribuye cuando después se da de alta', async () => {
    await recordWhatsAppReferral(PHONE, { source_type: 'ad', source_id: 'ad-acq', headline: 'acq-headline' });
    const { rows } = await pool.query('SELECT user_id FROM acquisition_touches WHERE phone_hash = $1', [phoneHash(PHONE)]);
    expect(rows).toEqual([{ user_id: null }]);

    const u = await pool.query(`INSERT INTO users (name, phone_number) VALUES ('acq-wa', $1) RETURNING id`, [PHONE]);
    waUser = u.rows[0].id;
    await pool.query(`INSERT INTO subscriptions (user_id, plan_id, provider, status) VALUES ($1, (SELECT id FROM plans ORDER BY id LIMIT 1), 'trial', 'trial')`, [waUser]);

    const report = await acquisitionReport(1);
    expect(report.find((r) => r.ad === 'acq-headline')).toMatchObject({ channel: 'whatsapp', source: 'meta_ad', signups: 1 });
  });

  it('la cookie web se ata al usuario al registrarse y se borra', async () => {
    const u = await pool.query(`INSERT INTO users (name, email) VALUES ('acq-web', 'acq-web-test@example.com') RETURNING id`);
    webUser = u.rows[0].id;
    await pool.query(`INSERT INTO subscriptions (user_id, plan_id, provider, status) VALUES ($1, (SELECT id FROM plans ORDER BY id LIMIT 1), 'trial', 'trial')`, [webUser]);

    const cookie = encodeSourceCookie({ channel: 'web', source: 'instagram', campaign: 'acq-test' });
    const { res, cleared } = fakeRes();
    await recordWebSignup(fakeReq({ method: 'POST', cookie: `${SOURCE_COOKIE}=${cookie}` }), res, webUser);

    const { rows } = await pool.query('SELECT channel, source FROM acquisition_touches WHERE user_id = $1', [webUser]);
    expect(rows).toEqual([{ channel: 'web', source: 'instagram' }]);
    expect(cleared).toContain(SOURCE_COOKIE);

    const report = await acquisitionReport(1);
    expect(report.find((r) => r.campaign === 'acq-test')).toMatchObject({ channel: 'web', signups: 1, activated: 0, paying: 0 });
  });

  it('registro sin cookie no escribe nada', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM acquisition_touches');
    await recordWebSignup(fakeReq({ method: 'POST' }), fakeRes().res, webUser);
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM acquisition_touches');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
