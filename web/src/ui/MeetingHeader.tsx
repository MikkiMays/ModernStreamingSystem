import { useEffect, useState } from 'react';
import { Link, Pencil, Star } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { MediaState } from '../media/session';
import type { Participant } from '../api/types';
import { favoriteApi } from '../core/favorites';
import { formatCode } from '../core/invitation';
import { formatDuration, readStartedAt, spokenDuration } from '../core/meeting-clock';
import { IconButton } from './kit';
import { Logo } from './brand/Logo';
import { useStore } from './primitives';
import { useFavorites, useFavoritesLimit } from './useFavorites';
import './meeting-header.css';

/** Строки шапки — в одном месте, до слоя переводов (E14). */
const TEXT = {
  code: 'Код встречи',
  invite: 'Пригласить',
  inviteAll: 'Пригласить участников',
  settings: 'Настройки встречи',
  clock: 'Время встречи',
  save: 'Сохранить комнату в избранное',
  unsave: 'Убрать комнату из избранного',
  full: (max: number) => `В избранном уже ${max} комнат. Уберите одну, чтобы добавить эту`,
  ended: 'Завершено',
  waiting: 'Ожидание входа',
  recovering: 'Связь восстанавливается…',
  connecting: 'Подключаемся…',
};

export interface HeaderStatus {
  label: string;
  tone: 'neutral' | 'progress' | 'warning';
}

/**
 * Что сказать рядом с названием (T25).
 *
 * Нормальное состояние молчит: «В эфире» в шапке говорило то, что и так видно по лицам на сцене,
 * и стояло отдельной таблеткой на самом заметном месте экрана. Остаются только состояния, о которых
 * надо знать, — и стоят они у названия встречи, к которой относятся.
 */
export function headerStatus(
  ended: string | null,
  self: Pick<Participant, 'status'> | undefined,
  media: Pick<MediaState, 'status'>,
): HeaderStatus | null {
  if (ended) return { label: TEXT.ended, tone: 'neutral' };
  if (self?.status === 'WAITING') return { label: TEXT.waiting, tone: 'neutral' };
  if (media.status === 'connected') return null;
  if (media.status === 'recovering') return { label: TEXT.recovering, tone: 'warning' };
  return { label: TEXT.connecting, tone: 'progress' };
}

/**
 * Сколько идёт встреча — по часам сервера, раз в секунду. Пока ядро не прислало `startedAt`
 * (во встрече ещё нет двоих, или ядро старше WP1), времени нет.
 */
function useDuration(meeting: Meeting, startedAt: number | null, running: boolean) {
  const [now, setNow] = useState(() => meeting.serverNow());
  useEffect(() => {
    if (startedAt === null || !running) return;
    setNow(meeting.serverNow());
    const timer = setInterval(() => setNow(meeting.serverNow()), 1000);
    return () => clearInterval(timer);
  }, [meeting, startedAt, running]);
  return startedAt === null ? null : now - startedAt;
}

export function MeetingHeader({
  meeting,
  canEdit,
  onInvite,
  onSettings,
}: {
  meeting: Meeting;
  /** Ведущему название — ещё и кнопка настроек встречи. */
  canEdit: boolean;
  onInvite: () => void;
  onSettings: () => void;
}) {
  const snapshot = useStore(meeting.snapshot);
  const media = useStore(meeting.media.state);
  const ended = useStore(meeting.ended);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const status = headerStatus(ended, self, media);
  const startedAt = ended ? null : readStartedAt(snapshot);
  const duration = useDuration(meeting, startedAt, !ended);

  const favorites = useFavorites();
  const limit = useFavoritesLimit();
  const isFavorite = !!favorites.data?.some((f) => f.roomId === meeting.admission.roomId);
  // Предел избранного (П3): звезда «добавить» на десятой комнате неактивна и говорит почему —
  // теми же словами, что и отказ ядра, если до него всё же дойдёт.
  const full = !isFavorite && (favorites.data?.length ?? 0) >= limit;
  const [saving, setSaving] = useState(false);
  const toggleFavorite = async () => {
    setSaving(true);
    try {
      if (isFavorite) await favoriteApi.remove(meeting.admission.roomId);
      else await favoriteApi.save(meeting.admission);
      await favorites.refetch();
    } catch (error) {
      meeting.media.report(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <header className="meeting-header">
      <div className="meeting-header__identity">
        <Logo className="meeting-header__brand" />
        <span className="meeting-header__rule" aria-hidden="true" />
        <div className="meeting-header__text">
          {/* Туда же, где название написано, и идут, чтобы его исправить. Остальным нажимать не на
              что, и заголовок остаётся заголовком. */}
          {/* Заголовок остаётся заголовком и у ведущего: внутри кнопки он перестал бы им быть для
              диктора. Нажимается вся строка с карандашом — кнопка лежит поверх неё (`::after`). */}
          <div className="meeting-header__name" data-editable={(canEdit && !ended) || undefined}>
            <h1 className="meeting-header__title">{snapshot.title}</h1>
            {canEdit && !ended && (
              <button
                type="button"
                className="meeting-header__rename"
                aria-label={TEXT.settings}
                title={TEXT.settings}
                onClick={onSettings}
              >
                <Pencil size={13} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="meeting-header__meta">
            <button type="button" className="meeting-header__code" aria-label={TEXT.code} onClick={onInvite}>
              {snapshot.code ? formatCode(snapshot.code) : TEXT.invite}
            </button>
            {duration !== null && (
              <span
                className="meeting-header__clock"
                role="timer"
                aria-label={`${TEXT.clock}: ${spokenDuration(duration)}`}
                title={TEXT.clock}
              >
                {formatDuration(duration)}
              </span>
            )}
            {status && (
              <span className="meeting-header__status" role="status" data-tone={status.tone}>
                <span className="meeting-header__dot" aria-hidden="true" />
                {status.label}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="meeting-header__actions">
        {/* На пределе кнопка не `disabled`, а `aria-disabled`: выключенная теряет фокус и подсказку,
            а здесь подсказка и есть ответ на вопрос «почему не добавляется». */}
        <IconButton
          label={full ? TEXT.full(limit) : isFavorite ? TEXT.unsave : TEXT.save}
          pressed={isFavorite}
          className="meeting-header__favorite"
          aria-disabled={full || undefined}
          disabled={saving || !self || self.status === 'WAITING'}
          onClick={() => {
            if (!full) void toggleFavorite();
          }}
        >
          <Star size={19} fill={isFavorite ? 'currentColor' : 'none'} />
        </IconButton>
        <IconButton label={TEXT.inviteAll} onClick={onInvite}>
          <Link size={18} />
        </IconButton>
      </div>
    </header>
  );
}
