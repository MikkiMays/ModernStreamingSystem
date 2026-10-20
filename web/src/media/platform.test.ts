import { describe, expect, it } from 'vitest';
import { detectPlatform, type PlatformSignals } from './platform';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const ANDROID_APP = `${ANDROID} CordApp/0.1`;
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const signals = (patch: Partial<PlatformSignals>): PlatformSignals => ({
  userAgent: WINDOWS,
  maxTouchPoints: 0,
  displayStandalone: false,
  nativeBridge: false,
  ...patch,
});

describe('платформа для правил фона', () => {
  it('iPhone в Safari — iOS, не веб-приложение', () => {
    expect(detectPlatform(signals({ userAgent: IPHONE, maxTouchPoints: 5 }))).toEqual({
      os: 'ios',
      mobile: true,
      standalone: false,
      app: false,
    });
  });

  it('iPhone с экрана «Домой» узнаётся по navigator.standalone', () => {
    expect(detectPlatform(signals({ userAgent: IPHONE, iosStandalone: true })).standalone).toBe(true);
  });

  it('iPad называет себя Mac — отличаем по касанию; настоящий Mac остаётся ПК', () => {
    expect(detectPlatform(signals({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).os).toBe('ios');
    expect(detectPlatform(signals({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 })).mobile).toBe(false);
  });

  it('Android — по User-Agent, установленное PWA — по display-mode', () => {
    const pwa = detectPlatform(signals({ userAgent: ANDROID, displayStandalone: true }));
    expect(pwa).toMatchObject({ os: 'android', mobile: true, standalone: true, app: false });
  });

  it('приложение Cord узнаётся и по мосту, и по метке в User-Agent — и это не веб-приложение «Домой»', () => {
    expect(detectPlatform(signals({ userAgent: ANDROID_APP })).app).toBe(true);
    const bridged = detectPlatform(
      signals({ userAgent: ANDROID, nativeBridge: true, displayStandalone: true }),
    );
    expect(bridged).toMatchObject({ app: true, standalone: false, os: 'android' });
  });

  it('ПК — не телефон, даже в узком окне', () => {
    expect(detectPlatform(signals({}))).toMatchObject({ os: 'other', mobile: false });
  });
});
