import { describe, expect, it } from 'vitest';
import { SILENT_VIDEO_MS, VideoSilence } from './video-silence';

describe('камера замолчала без слова SFU (R119)', () => {
  it('кадры не растут при живом звуке — пауза через SILENT_VIDEO_MS, не раньше', () => {
    const silence = new VideoSilence();
    expect(silence.observe(100, true, 0)).toBe(false);
    expect(silence.observe(100, true, 2000)).toBe(false);
    expect(silence.observe(100, true, SILENT_VIDEO_MS - 1)).toBe(false);
    expect(silence.observe(100, true, SILENT_VIDEO_MS)).toBe(true);
    expect(silence.observe(100, true, SILENT_VIDEO_MS + 2000)).toBe(true);
  });

  it('новые кадры — отсчёт с начала; перезапуск счётчиков подпиской — тоже', () => {
    const silence = new VideoSilence();
    silence.observe(100, true, 0);
    silence.observe(100, true, 3000);
    expect(silence.observe(105, true, 4000)).toBe(false);
    expect(silence.observe(105, true, 7999)).toBe(false);
    expect(silence.observe(105, true, 8000)).toBe(true);
    expect(silence.observe(3, true, 10000)).toBe(false);
    expect(silence.observe(3, true, 13999)).toBe(false);
  });

  it('без звука тишина камеры не копится: обрыв всего пути — не пауза дорожки', () => {
    const silence = new VideoSilence();
    silence.observe(100, true, 0);
    expect(silence.observe(100, false, 4000)).toBe(false);
    expect(silence.observe(100, false, 8000)).toBe(false);
    // Звук вернулся — тишина считается от последнего опроса без звука, не раньше.
    expect(silence.observe(100, true, 10000)).toBe(false);
    expect(silence.observe(100, true, 11999)).toBe(false);
    expect(silence.observe(100, true, 12000)).toBe(true);
  });
});
