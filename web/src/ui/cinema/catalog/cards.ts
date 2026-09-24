import type { CinemaItem } from '../../../core/cinema';

/**
 * Карточки всех порций ленты — каждая один раз, первой встречей, в прежнем порядке.
 *
 * ЗАЧЕМ. Ленты «сначала новое» (разделы и каналы площадок) между порциями сдвигаются: пока
 * человек листал, наверху появился новый ролик, и последняя карточка прошлой порции приезжает
 * снова — уже в следующей. Площадка тут ни при чём, а служба помнит каждую порцию отдельно. Без
 * этого в сетке стояли бы две одинаковые плитки, а у React — два ребёнка с одним ключом.
 *
 * Одинаковость — по виду и номеру (`kind:id`), тем же ключом, что у плиток в сетке: канал и
 * ролик с одним номером — это разные карточки.
 */
export function cardsOf(pages: readonly { items: readonly CinemaItem[] }[] | undefined): CinemaItem[] {
  const seen = new Set<string>();
  const cards: CinemaItem[] = [];
  for (const page of pages ?? [])
    for (const item of page.items) {
      const key = `${item.kind}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(item);
    }
  return cards;
}
