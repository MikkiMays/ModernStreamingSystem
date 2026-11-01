import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Copy, History, MoreHorizontal, Star, StarOff, Trash2, Video } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Admission } from '../../api/types';
import { RoomApi } from '../../api/client';
import { formatCode, type Destination } from '../../core/invitation';
import {
  clearRecent,
  fetchPresence,
  forgetRecent,
  markEnded,
  offerCreateTitle,
  useRecentMeetings,
  type Presence,
  type RecentEntry,
} from '../../core/recent-meetings';
import {
  Badge,
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  useToast,
} from '../kit';
import { useFavoriteMembership, useFavorites } from '../useFavorites';

/** Как часто спрашивать ядро, идут ли встречи, пока главная видна. */
const PRESENCE_MS = 30_000;

/**
 * Что сделает нажатие на карточку — это же слово она и пишет справа (R162, R164):
 * - `rejoin` — встреча идёт или пуста, но жива: вернуться тем же участником (пропуск из списка);
 * - `again` — встреча закончилась: новая с тем же названием, ссылка сразу в буфере (R142);
 * - `code` — пропуска нет, а встреча, может быть, идёт: войти по коду, как гость.
 */
export type RecentStep = 'rejoin' | 'again' | 'code';

/**
 * Шаг карточки по тому, что известно сейчас. Ответ ядра (`rooms/presence`) главнее снимка в списке:
 * сохранённую встречу, завершённую когда-то, снова открывают из избранного, и тогда она идёт, хотя в
 * записи осталось «завершена».
 */
export function recentStep(entry: RecentEntry, presence?: Presence) {
  const state = presence?.state;
  const ended = state ? state === 'closed' || state === 'gone' : !!entry.closedAt;
  const step: RecentStep = ended ? 'again' : entry.credential ? 'rejoin' : 'code';
  return { step, ended, live: state === 'live' };
}

/**
 * «Недавние» на главной (R148): под входом, в слоте макета DESIGN.md, который пустовал после
 * переезда избранного в панель. Пустой список — блока нет вовсе: герой стоит один, как раньше.
 *
 * Вся карточка — одна кнопка (R162, R164: «сделай просто весь элемент встречи кликабельным»). Раньше у
 * строки были свои кнопки под состояние — «Вернуться», «Создать снова», «Войти по коду», — и владелец
 * спросил, чем они отличаются. Теперь действие одно, и карточка говорит его словом справа: идёт —
 * «Вернуться», закончилась — «Создать снова». Остальное («Скопировать код», избранное, «Убрать из
 * недавних») — в «…», отдельной кнопкой рядом с карточкой, а не внутри неё: вложенная кнопка в кнопке
 * не нажимается с клавиатуры и путает чтение с экрана.
 *
 * Удалённую встречу список сам не забывает: несохранённая удаляется сразу после выхода последнего
 * (Р-38), и иначе своя встреча пропадала бы из «Недавних» в ту же секунду, как из неё вышли.
 */
export function RecentMeetings({
  onJoin,
  onCreate,
}: {
  onJoin: (destination: Destination) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const entries = useRecentMeetings();
  const favorites = useFavorites();
  const membership = useFavoriteMembership();
  const client = useQueryClient();
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const withCredential = entries.filter((entry) => entry.credential).map((entry) => entry.roomId);
  const presenceKey = ['recent-presence', withCredential.join(',')];
  const presence = useQuery({
    queryKey: presenceKey,
    queryFn: () => fetchPresence(entries),
    enabled: withCredential.length > 0,
    refetchInterval: () => (document.visibilityState === 'visible' ? PRESENCE_MS : false),
    staleTime: PRESENCE_MS / 2,
    retry: false,
  });
  if (!entries.length) return null;
  const saved = new Set(favorites.data?.map((room) => room.roomId));

  /**
   * Встреча кончилась между опросами: карточка честно меняет слово на «Создать снова» — сразу, не
   * дожидаясь следующего опроса, и после перезагрузки тоже (запись в списке).
   */
  const over = (entry: RecentEntry) => {
    markEnded(entry.roomId);
    client.setQueryData<Map<string, Presence>>(presenceKey, (known) =>
      new Map(known).set(entry.roomId, {
        roomId: entry.roomId,
        state: 'closed',
        people: 0,
        title: null,
        code: null,
      }),
    );
    toast.add({ title: t(($) => $.home.recent.over) });
  };
  const rejoin = async (entry: RecentEntry) => {
    if (!entry.credential || !entry.participantId || busy) return;
    setBusy(entry.roomId);
    try {
      const admission = {
        roomId: entry.roomId,
        credential: entry.credential,
        participantId: entry.participantId,
        inviteUrl: null,
        recoverySeconds: 0,
      } as unknown as Admission;
      admission.snapshot = await new RoomApi(admission).snapshot();
      if (admission.snapshot.closedAt) over(entry);
      else onJoin({ kind: 'recent', admission });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Комнаты нет (404) или её история уже удалена (410) — встреча кончилась.
      if (status === 404 || status === 410) over(entry);
      // Пропуск больше не годится, а встреча, может быть, идёт: войти по коду, как гость.
      else if (status === 403) onJoin({ kind: 'code', code: entry.code });
      else toast.add({ title: (error as Error).message || t(($) => $.home.recent.failed), type: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const open = (entry: RecentEntry, step: RecentStep) => {
    if (step === 'rejoin') void rejoin(entry);
    else if (step === 'code') onJoin({ kind: 'code', code: entry.code });
    else {
      offerCreateTitle(entry.title);
      onCreate();
    }
  };
  const copyCode = (entry: RecentEntry) =>
    void navigator.clipboard
      .writeText(formatCode(entry.code))
      .then(() => toast.add({ title: t(($) => $.home.recent.copied), type: 'success' }))
      .catch(() => toast.add({ title: t(($) => $.home.recent.copyFailed), type: 'danger' }));
  const toggleFavorite = (entry: RecentEntry) => {
    const was = saved.has(entry.roomId);
    void (
      was
        ? membership.remove(entry.roomId)
        : membership.save({ roomId: entry.roomId, credential: entry.credential! })
    )
      .then(() =>
        toast.add({
          title: was ? t(($) => $.home.recent.unfavorited) : t(($) => $.home.recent.favorited),
          type: 'success',
        }),
      )
      .catch((error: Error) => toast.add({ title: error.message, type: 'danger' }));
  };

  return (
    <section className="home-recent" aria-labelledby="home-recent-title">
      <header className="home-recent__head">
        <h2 id="home-recent-title" className="home-recent__title">
          {t(($) => $.home.recent.title)}
        </h2>
        <Button variant="quiet" size="sm" onClick={() => setClearing(true)}>
          {t(($) => $.home.recent.clear)}
        </Button>
      </header>
      <ul className="home-recent__list">
        {entries.map((entry) => (
          <RecentRow
            key={entry.roomId}
            entry={entry}
            presence={presence.data?.get(entry.roomId)}
            busy={busy === entry.roomId}
            favorite={saved.has(entry.roomId)}
            onOpen={(step) => open(entry, step)}
            onCopy={() => copyCode(entry)}
            onFavorite={() => toggleFavorite(entry)}
            onForget={() => forgetRecent(entry.roomId)}
          />
        ))}
      </ul>
      <Dialog
        open={clearing}
        onOpenChange={setClearing}
        size="sm"
        title={t(($) => $.home.recent.clearTitle)}
        description={t(($) => $.home.recent.clearText)}
        footer={
          <>
            <Button variant="quiet" onClick={() => setClearing(false)}>
              {t(($) => $.home.recent.cancel)}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                clearRecent();
                setClearing(false);
              }}
            >
              {t(($) => $.home.recent.clearConfirm)}
            </Button>
          </>
        }
      />
    </section>
  );
}

function RecentRow({
  entry,
  presence,
  busy,
  favorite,
  onOpen,
  onCopy,
  onFavorite,
  onForget,
}: {
  entry: RecentEntry;
  presence?: Presence;
  busy: boolean;
  /** Встреча уже в избранном: пункт меню убирает её оттуда. */
  favorite: boolean;
  onOpen: (step: RecentStep) => void;
  onCopy: () => void;
  onFavorite: () => void;
  onForget: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { step, ended, live } = recentStep(entry, presence);
  const title = presence?.title || entry.title;
  const when = visitedAt(entry.lastAt, i18n.resolvedLanguage ?? 'ru', t);
  const people = live && presence ? t(($) => $.home.recent.people, { count: presence.people }) : null;
  const word =
    step === 'rejoin'
      ? t(($) => $.home.recent.rejoin)
      : step === 'again'
        ? t(($) => $.home.recent.again)
        : t(($) => $.home.recent.byCode);
  // Имя кнопки — действие и встреча: «Вернуться: Дейли». Код, время и сколько людей — описанием.
  const label =
    step === 'rejoin'
      ? t(($) => $.home.recent.rejoinNamed, { title })
      : step === 'again'
        ? t(($) => $.home.recent.againNamed, { title })
        : t(($) => $.home.recent.byCodeNamed, { title });
  return (
    <li
      className="home-recent__row"
      data-live={live || undefined}
      data-ended={ended || undefined}
      data-step={step}
    >
      <button
        type="button"
        className="home-recent__open"
        aria-label={label}
        aria-describedby={people ? `${id}-meta ${id}-people` : `${id}-meta`}
        aria-busy={busy || undefined}
        onClick={() => onOpen(step)}
      >
        <span className="home-recent__icon" aria-hidden="true">
          {ended ? <History size={16} /> : live ? <span className="home-recent__dot" /> : <Video size={16} />}
        </span>
        <span className="home-recent__text">
          <span className="home-recent__name">{title}</span>
          <span className="home-recent__meta" id={`${id}-meta`}>
            {formatCode(entry.code)} · {when}
            {ended && <> · {t(($) => $.home.recent.ended)}</>}
          </span>
        </span>
        {people && (
          <Badge variant="success" className="home-recent__people" id={`${id}-people`}>
            {people}
          </Badge>
        )}
        <span className="home-recent__go">
          {word}
          <span className="home-recent__chevron" aria-hidden="true">
            {busy ? <span className="ui-spinner" /> : <ChevronRight size={16} />}
          </span>
        </span>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              size="sm"
              label={t(($) => $.home.recent.menu, { title })}
              className="home-recent__menu"
            >
              <MoreHorizontal size={16} />
            </IconButton>
          }
        />
        <MenuContent align="end">
          <MenuItem icon={<Copy size={16} />} onClick={onCopy}>
            {t(($) => $.home.recent.copyCode)}
          </MenuItem>
          {/* В избранное кладёт пропуск участника — у закончившейся встречи сохранять нечего. */}
          {step === 'rejoin' && (
            <MenuItem icon={favorite ? <StarOff size={16} /> : <Star size={16} />} onClick={onFavorite}>
              {favorite ? t(($) => $.home.recent.unfavorite) : t(($) => $.home.recent.favorite)}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={<Trash2 size={16} />} destructive onClick={onForget}>
            {t(($) => $.home.recent.forget)}
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

/** «сегодня, 14:20» / «вчера, 14:20» / «12 окт., 14:20» — в языке интерфейса. */
function visitedAt(at: number, locale: string, t: ReturnType<typeof useTranslation>['t']) {
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const today = day(new Date());
  if (day(date) === today) return t(($) => $.home.recent.today, { time });
  if (day(date) === today - 86_400_000) return t(($) => $.home.recent.yesterday, { time });
  return `${date.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}, ${time}`;
}
