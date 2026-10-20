import { describe, expect, it } from 'vitest';
import { insetVariables } from './insets';

describe('безопасные зоны Mini App', () => {
  it('сверху — зона устройства и кнопки Telegram вместе, по сторонам — что дали', () => {
    expect(
      insetVariables({ top: 47, bottom: 34, left: 0, right: 0 }, { top: 46.4, bottom: 0, left: 0, right: 0 }),
    ).toEqual({
      '--tg-inset-top': '93px',
      '--tg-inset-bottom': '34px',
      '--tg-inset-left': '0px',
      '--tg-inset-right': '0px',
    });
  });

  it('пустые и отрицательные значения — ноль, а не сдвиг за край', () => {
    const zero = { top: 0, bottom: 0, left: 0, right: 0 };
    expect(insetVariables({ ...zero, left: -5 }, { ...zero, top: Number.NaN })).toEqual({
      '--tg-inset-top': '0px',
      '--tg-inset-bottom': '0px',
      '--tg-inset-left': '0px',
      '--tg-inset-right': '0px',
    });
  });
});
