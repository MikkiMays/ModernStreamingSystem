import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  hotkeyFromEvent,
  hotkeyFromMouse,
  hotkeyLabel,
  sameHotkey,
  type Hotkey,
  type HotkeyNote,
} from '../../core/hotkeys';
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

/**
 * Строка «сочетание — изменить / сбросить» (T27, R23–R25): запись нажатием, отказ и предупреждения
 * сразу при назначении. Общая для микрофона («Горячие клавиши») и оверлея («Windows»).
 *
 * Во время записи та же кнопка — «Esc — отмена», и щелчок по ней отменяет запись так же, как Esc
 * (R24). «Сбросить» одна (R25): вернуть сочетание по умолчанию, а где умолчания нет (оверлей) —
 * снять назначение; видна, только когда есть что сбрасывать.
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
  mouse = false,
  hint,
}: {
  id: RowId;
  value: Hotkey | null;
  change: (key: Hotkey | null) => void;
  /** Что мешает сочетанию здесь (`hotkeyNotes`). */
  notes: (key: Hotkey) => HotkeyNote[];
  /** Имена кнопок для диктора: «Изменить сочетание микрофона», «Сбросить сочетание микрофона». */
  labels: { change: string; assign: string; reset: string };
  /** Сочетание по умолчанию: к нему ведёт «Сбросить». Нет — «Сбросить» снимает назначение. */
  defaultValue?: Hotkey;
  /** Сочетание другого действия Cord: его же назначить нельзя. */
  taken?: { key: Hotkey | null; text: string };
  /**
   * Пока идёт запись, оболочка отпускает сочетания: иначе нажатие самого сочетания сработало бы,
   * а не записалось. После записи ей возвращают то, что стоит сейчас, — только что назначенное.
   */
  pause: { start(): void; end(current: Hotkey | null): void };
  /** Ответ оболочки про это сочетание (`hotkeyStatusText`): только то, что мешает. */
  status?: ReactNode;
  /**
   * Записывать и кнопки мыши Mouse3–Mouse5 (E01-B3) — только при Raw Input оболочки (флаг `ptt`):
   * без него кнопку мыши поверх других программ никто не поймает.
   */
  mouse?: boolean;
  /** Своё пояснение строки вместо записанного в `ROWS` («Удерживайте, чтобы говорить»). */
  hint?: string;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState('');
  const [refused, setRefused] = useState<HotkeyNote | null>(null);
  // Слой раскладки идёт раньше пассивных эффектов: к уборке записи ссылка уже новая.
  const current = useRef(value);
  const recorder = useRef<HTMLButtonElement>(null);
  const paused = useRef(pause);
  const stop = () => {
    setRecording(false);
    setPending('');
  };
  /** Записать сочетание — с той же проверкой «нельзя» для клавиши и для кнопки мыши. */
  const commit = (next: Hotkey) => {
    const blocked =
      notes(next).find((note) => note.level === 'blocked') ??
      (taken && sameHotkey(next, taken.key) ? { level: 'blocked' as const, text: taken.text } : undefined);
    stop();
    if (blocked) {
      setRefused(blocked);
      return;
    }
    setRefused(null);
    change(next);
  };
  const committed = useRef(commit);
  useLayoutEffect(() => {
    current.current = value;
    paused.current = pause;
    committed.current = commit;
  });
  useEffect(() => {
    if (!recording) return;
    paused.current.start();
    return () => paused.current.end(current.current);
  }, [recording]);
  useEffect(() => {
    if (!recording || !mouse) return;
    // Кнопку жмут где угодно, не обязательно над полем: слушает окно, до того как фокус уйдёт.
    const press = (event: MouseEvent) => {
      const next = hotkeyFromMouse(event);
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      committed.current(next);
    };
    window.addEventListener('mousedown', press, true);
    return () => window.removeEventListener('mousedown', press, true);
  }, [recording, mouse]);
  const shown = value ? notes(value) : [];
  const resettable = defaultValue ? !value || !sameHotkey(value, defaultValue) : !!value;
  // Своё предупреждение точнее общего ответа оболочки — второй строкой о том же не повторяемся.
  const shell = shown.length ? null : status;
  return (
    <SettingRow
      id={id}
      hint={hint}
      below={
        refused || shown.length || shell ? (
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
            {shell && (
              <p className="setting-note" data-tone="warning" role="status">
                {shell}
              </p>
            )}
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
          ref={recorder}
          aria-label={
            recording ? t(($) => $.settings.hotkeys.cancelLabel) : value ? labels.change : labels.assign
          }
          // Второй щелчок — по «Esc — отмена» — отменяет запись, как и клавиша Esc (R24).
          onClick={() => {
            if (recording) {
              stop();
              return;
            }
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
            commit(next);
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
        {!recording && resettable && (
          <Button
            size="sm"
            variant="quiet"
            aria-label={labels.reset}
            onClick={() => {
              setRefused(null);
              change(defaultValue ? { ...defaultValue } : null);
              // «Сбросить» сейчас исчезнет (сбрасывать стало нечего) — фокус остаётся у сочетания.
              recorder.current?.focus({ preventScroll: true });
            }}
          >
            {t(($) => $.settings.hotkeys.reset)}
          </Button>
        )}
      </div>
    </SettingRow>
  );
}
