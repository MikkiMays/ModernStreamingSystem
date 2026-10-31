import { describe, expect, it } from 'vitest';
import { allowed, backgroundChoice, NO_BACKGROUND } from './background-effect';

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
