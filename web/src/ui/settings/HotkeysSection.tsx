import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { defaultMicHotkey, hotkeyNotes, type Hotkey, type MicHotkeyMode } from '../../core/hotkeys';
import { desktopHotkeyStatus, hasFeature, notifyDesktop, isDesktop } from '../../core/desktop';
import { useStore } from '../primitives';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { HotkeyField, Keys } from './HotkeyField';
import { ROWS, rowAvailable, rowText } from './sections';

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

/**
 * «Горячие клавиши» (T27). Модель сочетаний общая для веба и приложения: браузер слушает их, пока
 * вкладка активна, оболочка Windows регистрирует то же сочетание в системе. Что помешает
 * сочетанию, видно сразу при назначении (`hotkeyNotes`), а не когда оно молча не сработало.
 *
 * С Raw Input оболочки (флаг `ptt`, `cord-native`, E01-B3) — «Нажми и говори» (микрофон включён,
 * пока сочетание удерживается) и запись кнопок мыши Mouse3–Mouse5; без флага всё как раньше.
 */
export function HotkeysSection({
  value,
  change,
  overlay = null,
  mode = 'toggle',
  changeMode = () => {},
}: {
  value: Hotkey | null;
  change: (key: Hotkey | null) => void;
  /** Сочетание оверлея (клиент на Electron): то же назначить микрофону нельзя. */
  overlay?: Hotkey | null;
  /** Как работает сочетание микрофона: переключение или удержание. */
  mode?: MicHotkeyMode;
  changeMode?: (mode: MicHotkeyMode) => void;
}) {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const native = desktop && hasFeature('ptt');
  const place = native ? 'native' : desktop ? 'desktop' : 'browser';
  const nativeStatus = useStore(desktopHotkeyStatus);
  const ptt = rowAvailable(ROWS['hotkey-ptt'], desktop ? 'desktop' : 'browser', hasFeature);
  const hold = ptt && mode === 'hold';
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
      <SettingGroup title={t(($) => $.settings.hotkeys.meeting)}>
        <HotkeyField
          id="hotkey-mic"
          value={value}
          change={change}
          notes={(key) => hotkeyNotes(t, key, place)}
          defaultValue={defaultMicHotkey}
          taken={{ key: overlay, text: t(($) => $.settings.desktop.micTaken) }}
          labels={{
            change: t(($) => $.settings.hotkeys.changeLabel),
            assign: t(($) => $.settings.hotkeys.assignLabel),
            disable: t(($) => $.settings.hotkeys.disableLabel),
            reset: t(($) => $.settings.hotkeys.resetLabel),
          }}
          pause={{
            // Оболочка отпускает все сочетания на время записи; WinUI — своё единственное.
            start: () => notifyDesktop('hotkey.configure', { hotkey: null, paused: true }),
            end: (current) => notifyDesktop('hotkey.configure', { hotkey: current, paused: false }),
          }}
          mouse={native}
          hint={hold ? t(($) => $.settings.hotkeys.holdHint) : undefined}
        />
        {ptt && (
          <SettingRow id="hotkey-ptt">
            <Switch
              checked={mode === 'hold'}
              ariaLabel={rowText(t, 'hotkey-ptt').label}
              onCheckedChange={(on) => changeMode(on ? 'hold' : 'toggle')}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title={rowText(t, 'hotkey-other').label} id="hotkey-other">
        <div className="setting-keymaps">
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
        </div>
      </SettingGroup>
    </>
  );
}
