import { beforeEach, describe, expect, it } from 'vitest';
import {
  builtinRules,
  nearestLevel,
  qualityLevels,
  qualityRules,
  readRules,
  rememberQuality,
} from './capabilities';

beforeEach(() => localStorage.clear());

describe('правила качества с сервера', () => {
  it('читает правила из ответа capabilities и запоминает их', () => {
    const rules = rememberQuality({
      quality: {
        default: { resolution: 1080, fps: 30 },
        ceiling: { resolution: 1440, fps: 60 },
        settleMs: 6000,
        cameraYieldsToScreen: true,
      },
    });
    expect(rules.default).toEqual({ resolution: 1080, fps: 30 });
    expect(qualityRules()).toEqual(rules);
    expect(qualityLevels()).toEqual({ resolutions: [720, 1080, 1440], frameRates: [15, 30, 60] });
  });

  it('без поля quality (старый сервер) действуют встроенные умолчания 720p30 и потолок 1080p60', () => {
    expect(rememberQuality({ maxParticipants: 10 })).toEqual(builtinRules);
    expect(qualityLevels()).toEqual({ resolutions: [720, 1080], frameRates: [15, 30, 60] });
  });

  it('не верит правилам, которых кодировщик не знает, и умолчанию выше потолка', () => {
    expect(
      readRules({ default: { resolution: 600, fps: 30 }, ceiling: { resolution: 1080, fps: 60 } }),
    ).toBeNull();
    expect(
      readRules({ default: { resolution: 1080, fps: 60 }, ceiling: { resolution: 720, fps: 30 } }),
    ).toBeNull();
    expect(readRules(null)).toBeNull();
    // Испорченная запись в хранилище — тоже умолчания, а не падение.
    localStorage.setItem('cord:quality:v1', '{nope');
    expect(qualityRules()).toEqual(builtinRules);
  });

  it('окно разгона ограничено минутой и не бывает отрицательным', () => {
    const base = { default: { resolution: 720, fps: 30 }, ceiling: { resolution: 1080, fps: 60 } };
    expect(readRules({ ...base, settleMs: -5 })?.settleMs).toBe(0);
    expect(readRules({ ...base, settleMs: 999999 })?.settleMs).toBe(60000);
    expect(readRules({ ...base })?.settleMs).toBe(4000);
  });
});

describe('миграция сохранённого уровня', () => {
  it('«Авто» становится уровнем по умолчанию с сервера', () => {
    expect(nearestLevel({ resolution: 1080, fps: 30, automatic: true })).toEqual({
      resolution: 720,
      fps: 30,
    });
    expect(nearestLevel(undefined)).toEqual({ resolution: 720, fps: 30 });
  });

  it('1440p опускается к потолку, частота выше потолка — тоже', () => {
    expect(nearestLevel({ resolution: 1440, fps: 60, automatic: false })).toEqual({
      resolution: 1080,
      fps: 60,
    });
    expect(
      nearestLevel(
        { resolution: 1080, fps: 60 },
        { ...builtinRules, ceiling: { resolution: 1080, fps: 30 } },
      ),
    ).toEqual({ resolution: 1080, fps: 30 });
  });

  it('допустимый выбор остаётся как есть, незнакомое число — умолчание', () => {
    expect(nearestLevel({ resolution: 1080, fps: 15 })).toEqual({ resolution: 1080, fps: 15 });
    expect(nearestLevel({ resolution: 9999, fps: -1 } as never)).toEqual({ resolution: 720, fps: 30 });
  });
});
