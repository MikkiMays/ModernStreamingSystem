import { describe, expect, it } from 'vitest';
import { allowed, backgroundChoice, NO_BACKGROUND, supportFrom } from './background-effect';

describe('фон в видео: выбор и где он можно (R153)', () => {
  it('запись из настроек проверяется: неизвестное — «без фона»', () => {
    expect(backgroundChoice({ kind: 'blur', strength: 'strong' })).toEqual({
      kind: 'blur',
      strength: 'strong',
    });
    expect(backgroundChoice({ kind: 'image', id: 'forest' })).toEqual({ kind: 'image', id: 'forest' });
    expect(backgroundChoice({ kind: 'image', id: 'custom' })).toEqual({ kind: 'image', id: 'custom' });
    expect(backgroundChoice({ kind: 'image', id: 'https://evil.example/x.png' })).toEqual(NO_BACKGROUND);
    expect(backgroundChoice({ kind: 'blur', strength: 99 })).toEqual(NO_BACKGROUND);
    expect(backgroundChoice(undefined)).toEqual(NO_BACKGROUND);
  });

  it('телефон с Android — только размытие, iPhone — ничего, компьютер — всё', () => {
    const blur = { kind: 'blur', strength: 'light' } as const;
    const image = { kind: 'image', id: 'sea' } as const;
    expect(allowed(blur, 'full')).toBe(true);
    expect(allowed(image, 'full')).toBe(true);
    expect(allowed(blur, 'blur')).toBe(true);
    expect(allowed(image, 'blur')).toBe(false);
    expect(allowed(blur, 'none')).toBe(false);
    expect(allowed(NO_BACKGROUND, 'none')).toBe(true);
  });
});

describe('поддержка фона по возможностям браузера (R186)', () => {
  const apis = { streams: true, canvas: true, webgl2: true, frames: true };
  it('компьютер с потоками кадров — всё; без потоков, но с холстом — тоже всё', () => {
    expect(supportFrom(apis, false, 'Mozilla/5.0 (X11; Linux) Chrome/142', false)).toBe('full');
    expect(supportFrom({ ...apis, streams: false }, false, 'Mozilla/5.0 Safari', false)).toBe('full');
  });
  it('без WebGL2 или VideoFrame или вовсе без пути кадров — ничего', () => {
    expect(supportFrom({ ...apis, webgl2: false }, false, 'Chrome', false)).toBe('none');
    expect(supportFrom({ ...apis, frames: false }, false, 'Chrome', false)).toBe('none');
    expect(supportFrom({ ...apis, streams: false, canvas: false }, false, 'Chrome', false)).toBe('none');
  });
  it('телефон — только размытие и только с потоками кадров; iPhone и Telegram — ничего', () => {
    expect(supportFrom(apis, true, 'Android Chrome', false)).toBe('blur');
    expect(supportFrom({ ...apis, streams: false }, true, 'Android Chrome', false)).toBe('none');
    expect(supportFrom(apis, true, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', false)).toBe(
      'none',
    );
    expect(supportFrom(apis, false, 'Chrome', true)).toBe('none');
  });
});
