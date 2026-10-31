import { afterEach, describe, expect, it } from 'vitest';
import { modalOpen } from './modal';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('открыто ли окно поверх встречи (R142)', () => {
  it('диалог и окно-предупреждение — да', () => {
    document.body.innerHTML = '<div role="dialog"></div>';
    expect(modalOpen()).toBe(true);
    document.body.innerHTML = '<div role="alertdialog"></div>';
    expect(modalOpen()).toBe(true);
  });

  it('тост «Ссылка на встречу скопирована» — нет: клавиши встречи и плеера не глохнут', () => {
    document.body.innerHTML = '<div role="dialog" class="ui-toast">Ссылка на встречу скопирована</div>';
    expect(modalOpen()).toBe(false);
  });

  it('тост поверх открытого диалога окно не прячет', () => {
    document.body.innerHTML = '<div role="dialog" class="ui-toast"></div><div role="dialog"></div>';
    expect(modalOpen()).toBe(true);
  });
});
