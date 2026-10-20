import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Hand } from 'lucide-react';
import type { Command, Snapshot } from '../../api/types';
import type { Meeting } from '../../core/meeting';
import { Presence, SAMPLE_MS } from '../../core/presence';
import { locale } from '../../i18n';
import './notices.css';

/* «Вы ещё здесь?» (A2, E10-B): браузер сам подтверждает присутствие, ядро спрашивает молчащих. */

/**
 * Команда ядра `presence.confirm` (`Contracts.COMMAND_TYPES`). В `generated.ts` она появится с
 * регенерацией контрактов интегрирующей сессией; до тех пор — приведение здесь, в одном месте.
 */
const CONFIRM = 'presence.confirm' as Command['type'];

/** До какого момента ответить ядру, или `null`, если не спрашивали (`you.presenceBy`). */
export function readPresenceBy(snapshot: Snapshot): number | null {
  const value = snapshot.you?.presenceBy;
  return typeof value === 'number' ? value : null;
}

/**
 * Следить за тем, что за браузером кто-то есть, и сообщать об этом ядру (`core/presence.ts`).
 * Мышь, клавиши и касания — сразу; голос и камера — проходом раз в несколько секунд.
 */
export function usePresence(meeting: Meeting, active: boolean): Presence {
  const presence = useMemo(() => new Presence(() => meeting.command(CONFIRM)), [meeting]);
  useEffect(() => {
    if (!active) return;
    const touch = () => presence.touch();
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true, capture: true });
    const self = meeting.admission.participantId;
    const timer = setInterval(
      () =>
        presence.tick({
          speaking: () => meeting.media.levels.tier(self) >= 2,
          camera: () => meeting.media.state.get().camera,
        }),
      SAMPLE_MS,
    );
    return () => {
      for (const name of events) window.removeEventListener(name, touch, { capture: true });
      clearInterval(timer);
    };
  }, [meeting, presence, active]);
  return presence;
}

/**
 * Плашка «Вы ещё здесь?»: ядро спросило полем `you.presenceBy`. Без ответа к этому сроку — обычный
 * выход; ответ — одна кнопка. Время показывается по часам этого устройства с поправкой на сервер.
 */
export function PresenceAsk({ snapshot, presence }: { snapshot: Snapshot; presence: Presence }) {
  const { t } = useTranslation();
  const by = readPresenceBy(snapshot);
  const [sending, setSending] = useState(false);
  const time = useMemo(
    () =>
      by === null
        ? ''
        : new Date(Date.now() + by - snapshot.serverTime).toLocaleTimeString(locale(t), {
            hour: '2-digit',
            minute: '2-digit',
          }),
    [by, snapshot.serverTime, t],
  );
  if (by === null) return null;
  return (
    <div className="presence-ask" role="alertdialog" aria-labelledby="presence-ask-title">
      <Hand size={20} aria-hidden="true" />
      <div>
        <strong id="presence-ask-title">{t(($) => $.meeting.presence.title)}</strong>
        <span>{t(($) => $.meeting.presence.text, { time })}</span>
      </div>
      <button
        type="button"
        className="presence-ask__button"
        disabled={sending}
        autoFocus
        onClick={() => {
          setSending(true);
          presence
            .confirm()
            .catch(() => {})
            .finally(() => setSending(false));
        }}
      >
        {t(($) => $.meeting.presence.confirm)}
      </button>
    </div>
  );
}
