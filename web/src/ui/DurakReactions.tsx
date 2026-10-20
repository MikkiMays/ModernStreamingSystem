import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { DurakTable } from '../api/types';
import type { Meeting } from '../core/meeting';
import { DURAK_STICKERS, stickerLabel } from '../core/durak-stickers';
import { Modal } from './primitives';
const UNIQUE = DURAK_STICKERS.filter((item) => item.id === item.canonicalId);
function StickerImage({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="durak-sticker-fallback">{label}</span>
  ) : (
    <img loading="lazy" src={src} alt="" draggable={false} onError={() => setFailed(true)} />
  );
}
export function DurakReactions({
  meeting,
  table,
  seat,
  mine,
  children,
}: {
  meeting: Meeting;
  table: DurakTable;
  seat: number;
  mine?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const supported = table.reactions !== undefined;
  const [now, setNow] = useState(() => meeting.serverNow());
  const [lastSent, setLastSent] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLDivElement>(null);
  const reaction = table.reactions?.filter((item) => item.seat === seat).at(-1);
  const sticker = DURAK_STICKERS.find((item) => item.id === reaction?.stickerId);
  const cooldown = Math.max(lastSent, reaction?.at ?? 0) + 1500;
  const until = Math.max(cooldown, reaction?.expiresAt ?? 0);
  useEffect(() => {
    setNow(meeting.serverNow());
    if (until <= meeting.serverNow()) return;
    const timer = setInterval(() => {
      const next = meeting.serverNow();
      setNow(next);
      if (next >= until) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, [meeting, until, open]);
  const send = async (id: string) => {
    if (pending || meeting.serverNow() < cooldown) return;
    setPending(true);
    setError('');
    try {
      await meeting.command('durak.react', undefined, undefined, { option: id });
      setLastSent(meeting.serverNow());
      setOpen(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      {mine && supported ? (
        <button
          className="durak-reaction-trigger"
          aria-label={t(($) => $.durak.reactions.send)}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {children}
        </button>
      ) : (
        children
      )}
      {reaction && reaction.expiresAt > now && sticker && (
        <span
          className="durak-reaction-bubble"
          role="img"
          aria-label={t(($) => $.durak.reactions.bubble, {
            name: table.seats.find((item) => item.index === seat)?.name ?? t(($) => $.durak.reactions.player),
            sticker: stickerLabel(t, sticker),
          })}
        >
          <StickerImage key={reaction.id} src={sticker.asset} label={stickerLabel(t, sticker)} />
        </span>
      )}
      {mine && supported && (
        <Modal open={open} onOpenChange={setOpen} title={t(($) => $.durak.reactions.title)}>
          <div
            className="durak-reaction-picker"
            ref={picker}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key))
                return;
              const buttons = [
                ...(picker.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
              ];
              const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (current < 0 || !buttons.length) return;
              event.preventDefault();
              const top = buttons[0]!.offsetTop;
              const columns = buttons.filter((button) => button.offsetTop === top).length || 1;
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : current +
                      (event.key === 'ArrowLeft'
                        ? -1
                        : event.key === 'ArrowRight'
                          ? 1
                          : event.key === 'ArrowUp'
                            ? -columns
                            : columns);
              buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
            }}
          >
            {UNIQUE.map((item) => (
              <button
                key={item.id}
                disabled={pending || now < cooldown}
                aria-label={stickerLabel(t, item)}
                title={stickerLabel(t, item)}
                onClick={() => void send(item.id)}
              >
                <StickerImage src={item.asset} label={stickerLabel(t, item)} />
              </button>
            ))}
          </div>
          {now < cooldown && (
            <p>{t(($) => $.durak.reactions.cooldown, { seconds: ((cooldown - now) / 1000).toFixed(1) })}</p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
