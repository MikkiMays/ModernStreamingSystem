import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { paint } from './brands';
import { Soon } from './kit';
import { SHELF, shelfHint, shelfName, telegramNote, type ShelfId, type ShelfItem } from './integration-shelf';

export interface ShelfView {
  /** Подсказка вместо обычной (`shelfHint`; у музыки — включённые источники). */
  hints?: Partial<Record<ShelfId, string>>;
  /** Что идёт сейчас — строкой под подсказкой («Играет», «Покер: игра идёт»). */
  live?: Partial<Record<ShelfId, string>>;
  /** Какая соседняя группа мешает открыть эту — её имя. */
  blockedBy?: Partial<Record<ShelfId, string>>;
  /** Может ли этот человек привязать беседу Telegram (`telegram.link`). */
  canLinkTelegram: boolean;
  /**
   * Mini App Telegram включён на сервере (`catalog.telegram.webapp`, E09). Тогда Telegram — не «Скоро»:
   * создателю — кнопка внутрь, остальным — строка без действия с подсказкой, кто подключает.
   */
  telegramReady?: boolean;
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
  telegramReady = false,
  onOpen,
}: ShelfView) {
  const { t } = useTranslation();
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
        style={item.brand ? paint(item.brand) : undefined}
        onClick={() => onOpen(item.id)}
      >
        <span className="service-group__icon" aria-hidden="true">
          <item.icon size={20} />
        </span>
        <span className="service-group__text">
          <b>{shelfName(t, item.id)}</b>
          <small>
            {blocked
              ? t(($) => $.integrations.blocked, { name: blocked })
              : (hints[item.id] ?? shelfHint(t, item.id))}
          </small>
          {now && <span className="service-group__live">{now}</span>}
        </span>
        <ChevronRight size={16} className="service-group__chevron" aria-hidden="true" />
      </button>
    );
  };

  const soonCard = (item: ShelfItem) => {
    const note = item.id === 'telegram' ? telegramNote(t, canLinkTelegram) : null;
    return (
      <li key={item.id} className="service-group service-group--soon">
        <span className="service-group__icon" aria-hidden="true">
          <item.icon size={20} />
        </span>
        <span className="service-group__text">
          <span className="service-group__name">
            <b>{shelfName(t, item.id)}</b>
            <Soon />
          </span>
          <small>{shelfHint(t, item.id)}</small>
          {note && <small className="service-group__note">{note}</small>}
        </span>
      </li>
    );
  };

  /** Telegram при включённом Mini App: готовая карточка у создателя, строка с подсказкой у остальных. */
  const telegramCard = (item: ShelfItem) =>
    canLinkTelegram ? (
      readyCard(item)
    ) : (
      <div key={item.id} className="service-group service-group--soon">
        <span className="service-group__icon" aria-hidden="true">
          <item.icon size={20} />
        </span>
        <span className="service-group__text">
          <b>{shelfName(t, item.id)}</b>
          <small>{shelfHint(t, item.id)}</small>
          <small className="service-group__note">{telegramNote(t, false)}</small>
        </span>
      </div>
    );

  return (
    <div className="integration-shelf">
      <h3 className="integration-shelf__title">{t(($) => $.integrations.title)}</h3>
      <div className="integration-shelf__ready">{ready.map(readyCard)}</div>
      <ul className="integration-shelf__soon" aria-label={t(($) => $.integrations.soon)}>
        {soon.map(soonCard)}
      </ul>
      {telegramReady ? (
        <div
          className="integration-shelf__ready integration-shelf__apart"
          role="group"
          aria-label={t(($) => $.integrations.apart)}
        >
          {apart.map(telegramCard)}
        </div>
      ) : (
        <ul
          className="integration-shelf__soon integration-shelf__apart"
          aria-label={t(($) => $.integrations.apart)}
        >
          {apart.map(soonCard)}
        </ul>
      )}
    </div>
  );
}
