import { describe, expect, it } from 'vitest';
import type { CinemaItem } from '../../../core/cinema';
import { cardsOf } from './cards';

const card = (kind: CinemaItem['kind'], id: string, title = id) => ({ kind, id, title }) as CinemaItem;

describe('cardsOf: карточки всех порций ленты', () => {
  it('каждая карточка — один раз, первой встречей и в прежнем порядке', () => {
    // Ленты «сначала новое» между порциями сдвигаются: пока листали, наверху появился ролик, и
    // последняя карточка первой порции приезжает снова первой во второй.
    const pages = [
      { items: [card('video', 'a'), card('video', 'b', 'Первая встреча'), card('video', 'c')] },
      { items: [card('video', 'c'), card('video', 'b', 'Вторая встреча'), card('video', 'd')] },
    ];
    const found = cardsOf(pages);
    expect(found.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(found[1]!.title).toBe('Первая встреча');
  });

  it('один и тот же номер у разных видов — это разные карточки', () => {
    const found = cardsOf([{ items: [card('channel', 'x'), card('video', 'x'), card('channel', 'x')] }]);
    expect(found.map((item) => `${item.kind}:${item.id}`)).toEqual(['channel:x', 'video:x']);
  });

  it('без порций — пусто', () => {
    expect(cardsOf(undefined)).toEqual([]);
    expect(cardsOf([])).toEqual([]);
  });
});
