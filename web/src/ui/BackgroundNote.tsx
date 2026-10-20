import { useEffect, useState } from 'react';
import { Info, Link, MicOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { backgroundAdvice, type BackgroundAdvice } from '../media/background';
import { locale } from '../i18n';
import { Button, IconButton } from './kit';
import { useStore } from './primitives';

/** Подсказка о фоне показывается один раз на устройстве — для каждого случая своя. */
const SEEN = 'cord:background-note:';
/**
 * Подождать после подключения: удержание микрофона (`holdMicrophone`) идёт секунду-две, и без паузы
 * человек на мгновение увидел бы «нет доступа к микрофону», которого на самом деле нет.
 */
export const ADVICE_DELAY_MS = 3000;

function seen(advice: BackgroundAdvice): boolean {
  try {
    return localStorage.getItem(SEEN + advice) === '1';
  } catch {
    return false;
  }
}

function remember(advice: BackgroundAdvice) {
  try {
    localStorage.setItem(SEEN + advice, '1');
  } catch {
    /* Приватное окно забудет об этом само. */
  }
}

/**
 * Честно о разговоре в фоне (W4, W7, `docs/mobile.md` §3).
 *
 * Два случая. При входе с телефона — один раз, что будет, если свернуть браузер или погасить экран
 * на этой платформе (`backgroundAdvice`). По возвращении на экран — если телефон глушил включённый
 * микрофон, когда и сколько вас не слышали: иначе собеседник слышит тишину, а человек не знает почему.
 * Ошибка медиа важнее подсказки: пока она на сцене, подсказка ждёт.
 */
export function BackgroundNote({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const media = useStore(meeting.media.state);
  const captured = useStore(meeting.media.captured);
  const gap = useStore(meeting.media.micGap);
  const ended = useStore(meeting.ended);
  const invite = useStore(meeting.invite);
  const [settled, setSettled] = useState(false);
  const [closed, setClosed] = useState<BackgroundAdvice>(null);
  const [copied, setCopied] = useState(false);
  const connected = media.status === 'connected';
  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => setSettled(true), ADVICE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  if (ended || media.error) return null;

  if (gap) {
    const time = new Intl.DateTimeFormat(locale(t), { hour: '2-digit', minute: '2-digit' });
    return (
      <div className="background-note media-stage" role="status">
        <MicOff size={18} aria-hidden="true" />
        <span>
          {gap.to === null
            ? t(($) => $.meeting.background.gapOpen, { from: time.format(gap.from) })
            : t(($) => $.meeting.background.gapClosed, {
                from: time.format(gap.from),
                to: time.format(gap.to),
              })}
        </span>
        <IconButton
          tone="stage"
          label={t(($) => $.meeting.background.hide)}
          onClick={() => meeting.media.micGap.set(null)}
        >
          <X size={18} />
        </IconButton>
      </div>
    );
  }

  const advice = settled ? backgroundAdvice(meeting.media.platform, captured) : null;
  if (!advice || advice === 'app' || advice === closed || seen(advice)) return null;
  const text =
    advice === 'ios-safari'
      ? t(($) => $.meeting.background.iosSafari)
      : advice === 'ios-home'
        ? t(($) => $.meeting.background.iosHome)
        : advice === 'android'
          ? t(($) => $.meeting.background.android)
          : advice === 'telegram'
            ? t(($) => $.meeting.background.telegram)
            : t(($) => $.meeting.background.noMicrophone);
  const close = () => {
    remember(advice);
    setClosed(advice);
  };
  // Ссылка той же области внутри веб-приложения «Домой» (и внутри Telegram) откроется там же, а не в
  // браузере: её можно только скопировать и вставить в браузер руками.
  const link = invite ?? window.location.href;
  return (
    <div className="background-note media-stage" role="note">
      <Info size={18} aria-hidden="true" />
      <span>{text}</span>
      {(advice === 'ios-home' || advice === 'telegram') && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Link />}
          onClick={() => {
            void navigator.clipboard
              ?.writeText(link)
              .then(() => setCopied(true))
              .catch(() => {});
          }}
        >
          {copied ? t(($) => $.meeting.background.copied) : t(($) => $.meeting.background.copyLink)}
        </Button>
      )}
      <IconButton tone="stage" label={t(($) => $.meeting.background.hide)} onClick={close}>
        <X size={18} />
      </IconButton>
    </div>
  );
}
