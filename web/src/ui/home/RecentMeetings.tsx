import { useQuery } from '@tanstack/react-query';
import { History, MoreHorizontal, Star, Trash2, Copy, Video } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Admission } from '../../api/types';
import { RoomApi } from '../../api/client';
import { favoriteApi } from '../../core/favorites';
import { formatCode, type Destination } from '../../core/invitation';
import {
  clearRecent,
  fetchPresence,
  forgetRecent,
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

/** Сколько строк видно сразу; остальные — по «Показать все». */
const VISIBLE = 6;
/** Как часто спрашивать ядро, идут ли встречи, пока главная видна. */
const PRESENCE_MS = 30_000;

/**
 * «Недавние» на главной (R148): под входом, в слоте макета DESIGN.md, который пустовал после
 * переезда избранного в панель. Пустой список — блока нет вовсе: герой стоит один, как раньше.
 *
 * У строки честное состояние и одно главное действие под него: идёт — «Вернуться» тем же
 * участником; завершена или удалена — «Создать снова» с тем же названием (ссылка сразу в буфере,
 * R142); пропуск истёк, а встреча, может быть, идёт — «Войти по коду». Удалённую встречу список сам
 * не забывает: несохранённая удаляется сразу после выхода последнего (Р-38), и иначе своя встреча
 * пропадала бы из «Недавних» в ту же секунду, как из неё вышли.
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
  const [all, setAll] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const withCredential = entries.filter((entry) => entry.credential).map((entry) => entry.roomId);
  const presence = useQuery({
    queryKey: ['recent-presence', withCredential.join(',')],
    queryFn: () => fetchPresence(entries),
    enabled: withCredential.length > 0,
    refetchInterval: () => (document.visibilityState === 'visible' ? PRESENCE_MS : false),
    staleTime: PRESENCE_MS / 2,
    retry: false,
  });
  if (!entries.length) return null;
  const shown = all ? entries : entries.slice(0, VISIBLE);

  const rejoin = async (entry: RecentEntry) => {
    if (!entry.credential || !entry.participantId) return;
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
      onJoin({ kind: 'recent', admission });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // Пропуск больше не годится, а встреча, может быть, идёт: войти по коду, как гость.
      if (status === 403 || status === 404 || status === 410) onJoin({ kind: 'code', code: entry.code });
      else toast.add({ title: (error as Error).message || t(($) => $.home.recent.failed), type: 'danger' });
    } finally {
      setBusy(null);
    }
  };
  const again = (entry: RecentEntry) => {
    offerCreateTitle(entry.title);
    onCreate();
  };
  const copyCode = (entry: RecentEntry) =>
    void navigator.clipboard
      .writeText(formatCode(entry.code))
      .then(() => toast.add({ title: t(($) => $.home.recent.copied), type: 'success' }))
      .catch(() => toast.add({ title: t(($) => $.home.recent.copyFailed), type: 'danger' }));
  const favorite = (entry: RecentEntry) =>
    void favoriteApi
      .save({ roomId: entry.roomId, credential: entry.credential } as Admission)
      .then(() => toast.add({ title: t(($) => $.home.recent.favorited), type: 'success' }))
      .catch((error: Error) => toast.add({ title: error.message, type: 'danger' }));

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
        {shown.map((entry) => (
          <RecentRow
            key={entry.roomId}
            entry={entry}
            presence={presence.data?.get(entry.roomId)}
            busy={busy === entry.roomId}
            onRejoin={() => void rejoin(entry)}
            onAgain={() => again(entry)}
            onCode={() => onJoin({ kind: 'code', code: entry.code })}
            onCopy={() => copyCode(entry)}
            onFavorite={() => favorite(entry)}
            onForget={() => forgetRecent(entry.roomId)}
          />
        ))}
      </ul>
      {entries.length > VISIBLE && (
        <Button
          variant="quiet"
          size="sm"
          className="home-recent__more"
          onClick={() => setAll((value) => !value)}
        >
          {all ? t(($) => $.home.recent.less) : t(($) => $.home.recent.more, { count: entries.length })}
        </Button>
      )}
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
  onRejoin,
  onAgain,
  onCode,
  onCopy,
  onFavorite,
  onForget,
}: {
  entry: RecentEntry;
  presence?: Presence;
  busy: boolean;
  onRejoin: () => void;
  onAgain: () => void;
  onCode: () => void;
  onCopy: () => void;
  onFavorite: () => void;
  onForget: () => void;
}) {
  const { t, i18n } = useTranslation();
  const state = presence?.state;
  const ended = state === 'closed' || state === 'gone' || (!state && !!entry.closedAt);
  const live = state === 'live';
  const canReturn = !ended && !!entry.credential;
  const title = presence?.title || entry.title;
  const when = visitedAt(entry.lastAt, i18n.resolvedLanguage ?? 'ru', t);
  return (
    <li className="home-recent__row" data-live={live || undefined} data-ended={ended || undefined}>
      <span className="home-recent__icon" aria-hidden="true">
        {ended ? <History size={16} /> : live ? <span className="home-recent__dot" /> : <Video size={16} />}
      </span>
      <span className="home-recent__text">
        <span className="home-recent__name">{title}</span>
        <span className="home-recent__meta">
          {formatCode(entry.code)} · {when}
          {ended && <> · {t(($) => $.home.recent.ended)}</>}
        </span>
      </span>
      <span className="home-recent__side">
        {live && presence && (
          <Badge variant="success" className="home-recent__people">
            {t(($) => $.home.recent.people, { count: presence.people })}
          </Badge>
        )}
        {canReturn ? (
          <Button size="sm" variant={live ? 'primary' : 'secondary'} loading={busy} onClick={onRejoin}>
            {t(($) => $.home.recent.rejoin)}
          </Button>
        ) : ended ? (
          <Button size="sm" variant="secondary" onClick={onAgain}>
            {t(($) => $.home.recent.again)}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={onCode}>
            {t(($) => $.home.recent.byCode)}
          </Button>
        )}
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
            {canReturn && (
              <MenuItem icon={<Star size={16} />} onClick={onFavorite}>
                {t(($) => $.home.recent.favorite)}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={16} />} destructive onClick={onForget}>
              {t(($) => $.home.recent.forget)}
            </MenuItem>
          </MenuContent>
        </Menu>
      </span>
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
