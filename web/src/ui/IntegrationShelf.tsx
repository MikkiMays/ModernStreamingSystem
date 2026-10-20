import { ChevronRight } from 'lucide-react';
import { Soon } from './kit';
import { SHELF, telegramNote, type ShelfId, type ShelfItem } from './integration-shelf';

export interface ShelfView {
  /** Подсказка вместо записанной в `SHELF` (у музыки — включённые источники). */
  hints?: Partial<Record<ShelfId, string>>;
  /** Что идёт сейчас — строкой под подсказкой («Играет», «Покер: игра идёт»). */
  live?: Partial<Record<ShelfId, string>>;
  /** Какая соседняя группа мешает открыть эту — её имя. */
  blockedBy?: Partial<Record<ShelfId, string>>;
  /** Может ли этот человек привязать беседу Telegram (`telegram.link`). */
  canLinkTelegram: boolean;
  onOpen: (id: ShelfId) => void;
}

/**
 * Витрина интеграций: готовые группы — кнопками, «Скоро» — строками без действия (E06-B).
 *
 * Готовая карточка ведёт внутрь группы, поэтому справа у неё стрелка; занятая соседом — серая и
 * говорит, кем занята. «Скоро» не притворяется кнопкой: ни фокуса, ни нажатия, только что это будет.
 */
export function IntegrationShelf({
  hints = {},
  live = {},
  blockedBy = {},
  canLinkTelegram,
  onOpen,
}: ShelfView) {
  const ready = SHELF.filter((item) => !item.soon);
  const soon = SHELF.filter((item) => item.soon && !item.apart);
  const apart = SHELF.filter((item) => item.apart);

  const readyCard = (item: ShelfItem) => {
    const blocked = blockedBy[item.id];
    const now = live[item.id];
    return (
      <button
        key={item.id}
        type="button"
        className="service-group"
        data-active={now ? 'true' : undefined}
        disabled={!!blocked}
        onClick={() => onOpen(item.id)}
      >
        <span className="service-group__icon" aria-hidden="true">
          <item.icon size={22} />
        </span>
        <span className="service-group__text">
          <b>{item.name}</b>
          <small>
            {blocked ? `Сейчас активна другая интеграция — ${blocked}` : (hints[item.id] ?? item.hint)}
          </small>
          {now && <span className="service-group__live">{now}</span>}
        </span>
        <ChevronRight size={18} className="service-group__chevron" aria-hidden="true" />
      </button>
    );
  };

  const soonCard = (item: ShelfItem) => {
    const note = item.id === 'telegram' ? telegramNote(canLinkTelegram) : null;
    return (
      <li key={item.id} className="service-group service-group--soon">
        <span className="service-group__icon" aria-hidden="true">
          <item.icon size={20} />
        </span>
        <span className="service-group__text">
          <span className="service-group__name">
            <b>{item.name}</b>
            <Soon />
          </span>
          <small>{item.hint}</small>
          {note && <small className="service-group__note">{note}</small>}
        </span>
      </li>
    );
  };

  return (
    <div className="integration-shelf">
      <h3 className="integration-shelf__title">Что добавить во встречу</h3>
      <div className="integration-shelf__ready">{ready.map(readyCard)}</div>
      <ul className="integration-shelf__soon" aria-label="Скоро в Cord">
        {soon.map(soonCard)}
      </ul>
      <ul className="integration-shelf__soon integration-shelf__apart" aria-label="Связь с беседой">
        {apart.map(soonCard)}
      </ul>
    </div>
  );
}
