import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import {
  defaultMicHotkey,
  hotkeyFromEvent,
  hotkeyLabel,
  hotkeyNotes,
  type Hotkey,
  type HotkeyNote,
} from '../../core/hotkeys';
import { desktopHotkeyStatus, notifyDesktop, isDesktop } from '../../core/desktop';
import type { Translate } from '../../i18n';
import { useStore } from '../primitives';
import { Button } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';

/** Пробел называется словом, остальные клавиши — своим знаком. */
const SPACE = 'Space';

type OtherAction =
  | 'pause'
  | 'playerSound'
  | 'fullscreen'
  | 'seek'
  | 'volume'
  | 'fold'
  | 'checkCall'
  | 'bet'
  | 'allIn'
  | 'reorder';

/** Клавиши, которые не настраиваются, — чтобы назначая своё, было видно, что уже занято. */
const OTHER_KEYS: { id: 'cinema' | 'poker' | 'home'; keys: [string[], OtherAction][] }[] = [
  {
    id: 'cinema',
    keys: [
      [[SPACE], 'pause'],
      [['K'], 'pause'],
      [['M'], 'playerSound'],
      [['F'], 'fullscreen'],
      [['←', '→'], 'seek'],
      [['↑', '↓'], 'volume'],
    ],
  },
  {
    id: 'poker',
    keys: [
      [['F'], 'fold'],
      [['C'], 'checkCall'],
      [['R'], 'bet'],
      [['A'], 'allIn'],
    ],
  },
  {
    id: 'home',
    keys: [[['Alt', '↑ ↓'], 'reorder']],
  },
];

function Keys({ parts }: { parts: string[] }) {
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
  const { t } = useTranslation();
  const desktop = isDesktop();
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
  const notes = value ? hotkeyNotes(t, value, place) : [];
  const stop = () => {
    setRecording(false);
    setPending('');
  };
  const isDefault = !!value && hotkeyLabel(t, value) === hotkeyLabel(t, defaultMicHotkey);
  return (
    <>
      <p className="setting-banner" role="note">
        <Info size={16} aria-hidden="true" />
        <span>
          {desktop
            ? nativeStatus || t(($) => $.settings.hotkeys.desktop)
            : t(($) => $.settings.hotkeys.browser)}
        </span>
      </p>
      <SettingGroup title={t(($) => $.settings.hotkeys.meeting)} collapsible={false}>
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
                recording
                  ? t(($) => $.settings.hotkeys.cancelLabel)
                  : value
                    ? t(($) => $.settings.hotkeys.changeLabel)
                    : t(($) => $.settings.hotkeys.assignLabel)
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
                const blocked = hotkeyNotes(t, next, place).find((note) => note.level === 'blocked');
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
            {!recording && !isDefault && (
              <Button
                size="sm"
                variant="quiet"
                aria-label={t(($) => $.settings.hotkeys.resetLabel)}
                onClick={() => {
                  setRefused(null);
                  change({ ...defaultMicHotkey });
                }}
              >
                {t(($) => $.settings.hotkeys.reset)}
              </Button>
            )}
            {!recording && value && (
              <Button
                size="sm"
                variant="quiet"
                aria-label={t(($) => $.settings.hotkeys.disableLabel)}
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
      </SettingGroup>
      <SettingGroup title={rowText(t, 'hotkey-other').label} id="hotkey-other" defaultOpen={false}>
        {OTHER_KEYS.map((group) => (
          <div key={group.id} className="setting-keymap">
            <h4 className="setting-keymap__title">{t(($) => $.settings.hotkeys.groups[group.id])}</h4>
            {group.keys.map(([parts, action]) => (
              <div key={`${group.id}-${parts.join()}`} className="setting-keymap__row">
                <Keys parts={parts} />
                <span>{t(($) => $.settings.hotkeys.actions[action])}</span>
              </div>
            ))}
          </div>
        ))}
      </SettingGroup>
    </>
  );
}
