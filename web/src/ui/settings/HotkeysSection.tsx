import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { defaultMicHotkey, hotkeyNotes, type Hotkey } from '../../core/hotkeys';
import { desktopHotkeyStatus, notifyDesktop, isDesktop } from '../../core/desktop';
import { useStore } from '../primitives';
import { SettingGroup } from './Row';
import { HotkeyField, Keys } from './HotkeyField';
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

/**
 * «Горячие клавиши» (T27). Модель сочетаний общая для веба и приложения: браузер слушает их, пока
 * вкладка активна, оболочка Windows регистрирует то же сочетание в системе. Что помешает
 * сочетанию, видно сразу при назначении (`hotkeyNotes`), а не когда оно молча не сработало.
 */
export function HotkeysSection({
  value,
  change,
  overlay = null,
}: {
  value: Hotkey | null;
  change: (key: Hotkey | null) => void;
  /** Сочетание оверлея (клиент на Electron): то же назначить микрофону нельзя. */
  overlay?: Hotkey | null;
}) {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const place = desktop ? 'desktop' : 'browser';
  const nativeStatus = useStore(desktopHotkeyStatus);
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
        />
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
