import { describe, expect, it } from 'vitest';
import { SILENT_VIDEO_MS, VideoSilence } from './video-silence';

describe('камера замолчала без слова SFU (R119, R189)', () => {
  it('кадры не растут — тишина через SILENT_VIDEO_MS, не раньше', () => {
    const silence = new VideoSilence();
    expect(silence.observe(100, 0)).toBe(false);
    expect(silence.observe(100, 2000)).toBe(false);
    expect(silence.observe(100, SILENT_VIDEO_MS - 1)).toBe(false);
    expect(silence.observe(100, SILENT_VIDEO_MS)).toBe(true);
    expect(silence.observe(100, SILENT_VIDEO_MS + 2000)).toBe(true);
  });

  it('новые кадры — отсчёт с начала; перезапуск счётчиков подпиской — тоже', () => {
    const silence = new VideoSilence();
    silence.observe(100, 0);
    silence.observe(100, 3000);
    expect(silence.observe(105, 4000)).toBe(false);
    expect(silence.observe(105, 7999)).toBe(false);
    expect(silence.observe(105, 8000)).toBe(true);
    expect(silence.observe(3, 10000)).toBe(false);
    expect(silence.observe(3, 13999)).toBe(false);
  });
});
