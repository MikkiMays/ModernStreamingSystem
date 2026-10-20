import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { hotkeyFromEvent, hotkeyLabel, type Hotkey, type HotkeyNote } from '../../core/hotkeys';
import type { Translate } from '../../i18n';
import { Button } from '../kit';
import { SettingRow } from './Row';
import type { RowId } from './sections';

/** Пробел называется словом, остальные клавиши — своим знаком. */
const SPACE = 'Space';

export function Keys({ parts }: { parts: string[] }) {
  const { t } = useTranslation();
  return (
    <span className="setting-keys">
      {parts.map((part, index) => (
        <kbd key={index}>{part === SPACE ? t(($) => $.hotkeys.space) : part}</kbd>
      ))}
    </span>
  );
}

function split(t: Translate, key: Hotkey | null) {
  return key ? hotkeyLabel(t, key).split(' + ') : [];
}

/** Сочетание собирается из нажатых модификаторов, пока не нажата сама клавиша. */
function held(event: KeyboardEvent) {
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta']
    .filter(Boolean)
    .join(' + ');
}

function same(a: Hotkey | null | undefined, b: Hotkey | null | undefined) {
  return (
    !!a &&
    !!b &&
    a.code === b.code &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

/**
 * Строка «сочетание — изменить / по умолчанию / отключить» (T27): запись нажатием, отказ и
 * предупреждения сразу при назначении. Общая для микрофона («Горячие клавиши») и оверлея («Windows»).
 */
export function HotkeyField({
  id,
  value,
  change,
  notes,
  labels,
  defaultValue,
  taken,
  pause,
  status,
}: {
  id: RowId;
  value: Hotkey | null;
  change: (key: Hotkey | null) => void;
  /** Что мешает сочетанию здесь (`hotkeyNotes`). */
  notes: (key: Hotkey) => HotkeyNote[];
  /** Имена кнопок для диктора: «Изменить сочетание микрофона». */
  labels: { change: string; assign: string; disable: string; reset?: string };
  /** Есть — показывается «По умолчанию». */
  defaultValue?: Hotkey;
  /** Сочетание другого действия Cord: его же назначить нельзя. */
  taken?: { key: Hotkey | null; text: string };
  /**
   * Пока идёт запись, оболочка отпускает сочетания: иначе нажатие самого сочетания сработало бы,
   * а не записалось. После записи ей возвращают то, что стоит сейчас, — только что назначенное.
   */
  pause: { start(): void; end(current: Hotkey | null): void };
  /** Ответ оболочки про это сочетание. */
  status?: ReactNode;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState('');
  const [refused, setRefused] = useState<HotkeyNote | null>(null);
  // Слой раскладки идёт раньше пассивных эффектов: к уборке записи ссылка уже новая.
  const current = useRef(value);
  const paused = useRef(pause);
  useLayoutEffect(() => {
    current.current = value;
    paused.current = pause;
  });
  useEffect(() => {
    if (!recording) return;
    paused.current.start();
    return () => paused.current.end(current.current);
  }, [recording]);
  const shown = value ? notes(value) : [];
  const stop = () => {
    setRecording(false);
    setPending('');
  };
  const isDefault = !defaultValue || (!!value && same(value, defaultValue));
  return (
    <SettingRow
      id={id}
      below={
        refused || shown.length || status ? (
          <>
            {refused && (
              <p className="setting-note" data-tone="danger" role="alert">
                {refused.text}
              </p>
            )}
            {shown.map((note) => (
              <p key={note.text} className="setting-note" data-tone="warning" role="status">
                {note.text}
              </p>
            ))}
            {status && <p className="setting-note">{status}</p>}
          </>
        ) : undefined
      }
    >
      <div className="setting-hotkey">
        <span className="setting-hotkey__value" data-recording={recording || undefined} aria-live="polite">
          {recording ? (
            <span className="setting-hotkey__prompt">
              {pending ? `${pending} + …` : t(($) => $.settings.hotkeys.recording)}
            </span>
          ) : value ? (
            <Keys parts={split(t, value)} />
          ) : (
            <span className="setting-hotkey__prompt">{t(($) => $.hotkeys.unassigned)}</span>
          )}
        </span>
        <Button
          size="sm"
          variant={recording ? 'primary' : 'secondary'}
          data-hotkey-recorder
          aria-label={
            recording ? t(($) => $.settings.hotkeys.cancelLabel) : value ? labels.change : labels.assign
          }
          onClick={() => {
            setRefused(null);
            setRecording(true);
          }}
          onBlur={stop}
          onKeyDown={(event) => {
            if (!recording) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.code === 'Escape') {
              stop();
              return;
            }
            const next = hotkeyFromEvent(event.nativeEvent);
            if (!next) {
              setPending(held(event));
              return;
            }
            const blocked =
              notes(next).find((note) => note.level === 'blocked') ??
              (taken && same(next, taken.key) ? { level: 'blocked' as const, text: taken.text } : undefined);
            stop();
            if (blocked) {
              setRefused(blocked);
              return;
            }
            setRefused(null);
            change(next);
          }}
          onKeyUp={(event) => {
            if (recording) setPending(held(event));
          }}
        >
          {recording
            ? t(($) => $.settings.hotkeys.cancel)
            : value
              ? t(($) => $.settings.hotkeys.change)
              : t(($) => $.settings.hotkeys.assign)}
        </Button>
        {!recording && !isDefault && defaultValue && (
          <Button
            size="sm"
            variant="quiet"
            aria-label={labels.reset}
            onClick={() => {
              setRefused(null);
              change({ ...defaultValue });
            }}
          >
            {t(($) => $.settings.hotkeys.reset)}
          </Button>
        )}
        {!recording && value && (
          <Button
            size="sm"
            variant="quiet"
            aria-label={labels.disable}
            onClick={() => {
              setRefused(null);
              change(null);
            }}
          >
            {t(($) => $.settings.hotkeys.disable)}
          </Button>
        )}
      </div>
    </SettingRow>
  );
}
