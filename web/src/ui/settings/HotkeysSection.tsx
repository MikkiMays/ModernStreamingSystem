import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Info } from 'lucide-react';
import {
  defaultMicHotkey,
  hotkeyFromEvent,
  hotkeyLabel,
  hotkeyNotes,
  type Hotkey,
  type HotkeyNote,
} from '../../core/hotkeys';
import { desktopHotkeyStatus, notifyDesktop } from '../../core/desktop';
import { useStore } from '../primitives';
import { Button } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowDomId } from './sections';

const TEXT = {
  // T27, слова владельца: на сайте — только в активной вкладке, на устройстве — всегда.
  browser: 'В браузере сочетания работают, только пока вкладка Cord активна. В приложении — всегда.',
  desktop: 'В приложении сочетание работает и поверх других программ.',
  recording: 'Нажмите сочетание…',
  cancelHint: 'Esc — отмена',
};

/** Клавиши, которые не настраиваются, — чтобы назначая своё, было видно, что уже занято. */
const OTHER_KEYS: { title: string; keys: [string[], string][] }[] = [
  {
    title: 'Кинозал',
    keys: [
      [['Пробел'], 'пауза'],
      [['K'], 'пауза'],
      [['M'], 'звук плеера'],
      [['F'], 'полный экран'],
      [['←', '→'], 'перемотка на 10 с, с Shift — на 30 с'],
      [['↑', '↓'], 'громкость'],
    ],
  },
  {
    title: 'Покер, в свой ход',
    keys: [
      [['F'], 'пас'],
      [['C'], 'чек или колл'],
      [['R'], 'ставка'],
      [['A'], 'ва-банк'],
    ],
  },
  {
    title: 'Главная',
    keys: [[['Alt', '↑ ↓'], 'переставить комнату в избранном']],
  },
];

function Keys({ parts }: { parts: string[] }) {
  return (
    <span className="setting-keys">
      {parts.map((part, index) => (
        <kbd key={index}>{part}</kbd>
      ))}
    </span>
  );
}

function split(key: Hotkey | null) {
  return key ? hotkeyLabel(key).split(' + ') : [];
}

/** Сочетание собирается из нажатых модификаторов, пока не нажата сама клавиша. */
function held(event: KeyboardEvent) {
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta']
    .filter(Boolean)
    .join(' + ');
}

/**
 * «Горячие клавиши» (T27). Модель сочетаний общая для веба и приложения: браузер слушает их, пока
 * вкладка активна, оболочка Windows регистрирует то же сочетание в системе. Что помешает
 * сочетанию, видно сразу при назначении (`hotkeyNotes`), а не когда оно молча не сработало.
 */
export function HotkeysSection({
  value,
  change,
}: {
  value: Hotkey | null;
  change: (key: Hotkey | null) => void;
}) {
  const desktop = !!window.chrome?.webview;
  const place = desktop ? 'desktop' : 'browser';
  const nativeStatus = useStore(desktopHotkeyStatus);
  const [recording, setRecording] = useState(false);
  const [pending, setPending] = useState('');
  const [refused, setRefused] = useState<HotkeyNote | null>(null);
  // Пока идёт запись, оболочка отпускает прежнее сочетание: иначе нажатие его самого включило бы
  // микрофон, а не записалось.
  // Вернуть оболочке после записи — то, что стоит сейчас: только что назначенное, а не прежнее.
  // Слой раскладки идёт раньше пассивных эффектов: к уборке записи ссылка уже новая.
  const current = useRef(value);
  useLayoutEffect(() => {
    current.current = value;
  });
  useEffect(() => {
    if (!recording) return;
    notifyDesktop('hotkey.configure', { hotkey: null });
    return () => notifyDesktop('hotkey.configure', { hotkey: current.current });
  }, [recording]);
  const notes = value ? hotkeyNotes(value, place) : [];
  const stop = () => {
    setRecording(false);
    setPending('');
  };
  const isDefault = !!value && hotkeyLabel(value) === hotkeyLabel(defaultMicHotkey);
  return (
    <>
      <p className="setting-banner" role="note">
        <Info size={16} aria-hidden="true" />
        <span>{desktop ? nativeStatus || TEXT.desktop : TEXT.browser}</span>
      </p>
      <SettingGroup title="Встреча" collapsible={false}>
        <SettingRow
          id="hotkey-mic"
          below={
            refused || notes.length ? (
              <>
                {refused && (
                  <p className="setting-note" data-tone="danger" role="alert">
                    {refused.text}
                  </p>
                )}
                {notes.map((note) => (
                  <p key={note.text} className="setting-note" data-tone="warning" role="status">
                    {note.text}
                  </p>
                ))}
              </>
            ) : undefined
          }
        >
          <div className="setting-hotkey">
            <span
              className="setting-hotkey__value"
              data-recording={recording || undefined}
              aria-live="polite"
            >
              {recording ? (
                <span className="setting-hotkey__prompt">{pending ? `${pending} + …` : TEXT.recording}</span>
              ) : value ? (
                <Keys parts={split(value)} />
              ) : (
                <span className="setting-hotkey__prompt">Не назначено</span>
              )}
            </span>
            <Button
              size="sm"
              variant={recording ? 'primary' : 'secondary'}
              data-hotkey-recorder
              aria-pressed={recording}
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
                const blocked = hotkeyNotes(next, place).find((note) => note.level === 'blocked');
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
              {recording ? TEXT.cancelHint : value ? 'Изменить' : 'Назначить'}
            </Button>
            {!recording && !isDefault && (
              <Button size="sm" variant="quiet" onClick={() => change({ ...defaultMicHotkey })}>
                По умолчанию
              </Button>
            )}
            {!recording && value && (
              <Button size="sm" variant="quiet" onClick={() => change(null)}>
                Отключить
              </Button>
            )}
          </div>
        </SettingRow>
      </SettingGroup>
      <div id={rowDomId('hotkey-other')}>
        <SettingGroup title="Клавиши кинозала и игр" defaultOpen={false}>
          {OTHER_KEYS.map((group) => (
            <div key={group.title} className="setting-keymap">
              <h4 className="setting-keymap__title">{group.title}</h4>
              {group.keys.map(([parts, action]) => (
                <div key={`${group.title}-${parts.join()}`} className="setting-keymap__row">
                  <Keys parts={parts} />
                  <span>{action}</span>
                </div>
              ))}
            </div>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}
