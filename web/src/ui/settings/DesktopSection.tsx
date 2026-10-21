import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { desktopOverlayHotkeyStatus, hasFeature, notifyDesktop } from '../../core/desktop';
import {
  changeDesktopSettings,
  desktopSettings,
  loadDesktopSettings,
  watchDesktopSettings,
  type DesktopSettings,
} from '../../core/desktop-settings';
import { hotkeyNotes, type Hotkey } from '../../core/hotkeys';
import type { Preferences } from '../../core/preferences';
import { useStore } from '../primitives';
import { Switch } from '../kit';
import { HotkeyField } from './HotkeyField';
import { SettingGroup, SettingRow } from './Row';
import { ROWS, rowAvailable, rowText, type RowId } from './sections';

/**
 * «Windows» (E03, T53, E01-B2) — только в клиенте на Electron: мягкое взаимодействие с Windows,
 * оверлей в играх с его сочетанием и автозапуск. Каждая строка видна только при своём флаге
 * оболочки; значения живут в оболочке (`app.settings`), сочетание оверлея — в профиле страницы,
 * рядом с сочетанием микрофона: модель сочетаний одна (E03).
 */
export function DesktopSection({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const values = useStore(desktopSettings);
  const overlayStatus = useStore(desktopOverlayHotkeyStatus);
  useEffect(() => {
    void loadDesktopSettings();
    return watchDesktopSettings();
  }, []);
  const shown = (id: RowId) => rowAvailable(ROWS[id], 'desktop', hasFeature);
  const toggle = (id: RowId, key: keyof DesktopSettings) =>
    shown(id) && (
      <SettingRow id={id}>
        <Switch
          checked={values?.[key] ?? false}
          disabled={!values}
          ariaLabel={rowText(t, id).label}
          onCheckedChange={(checked) =>
            void changeDesktopSettings({ [key]: checked } as Partial<DesktopSettings>)
          }
        />
      </SettingRow>
    );
  const taskbar = (['desktop-tray', 'desktop-thumbar', 'desktop-badge', 'desktop-flash'] as const).some(
    shown,
  );
  const meeting = (['desktop-sleep', 'desktop-overlay'] as const).some(shown);
  return (
    <>
      {taskbar && (
        <SettingGroup title={t(($) => $.settings.desktop.taskbar)}>
          {toggle('desktop-tray', 'tray')}
          {toggle('desktop-thumbar', 'thumbar')}
          {toggle('desktop-badge', 'badge')}
          {toggle('desktop-flash', 'flash')}
        </SettingGroup>
      )}
      {meeting && (
        <SettingGroup
          title={t(($) => $.settings.desktop.meeting)}
          note={shown('desktop-overlay') ? t(($) => $.settings.desktop.overlayNote) : undefined}
        >
          {toggle('desktop-sleep', 'sleepBlocker')}
          {toggle('desktop-overlay', 'overlay')}
          {shown('desktop-overlay-hotkey') && hasFeature('hotkeys') && (
            <HotkeyField
              id="desktop-overlay-hotkey"
              value={preferences.overlayHotkey}
              change={(overlayHotkey: Hotkey | null) => void change({ overlayHotkey })}
              // Raw Input (флаг `ptt`): любая клавиша и кнопки мыши поверх всего — заметки другие.
              notes={(key) => hotkeyNotes(t, key, hasFeature('ptt') ? 'native' : 'desktop', false)}
              mouse={hasFeature('ptt')}
              taken={{ key: preferences.micHotkey, text: t(($) => $.settings.desktop.overlayTaken) }}
              labels={{
                change: t(($) => $.settings.desktop.changeLabel),
                assign: t(($) => $.settings.desktop.assignLabel),
                disable: t(($) => $.settings.desktop.disableLabel),
              }}
              pause={{
                start: () => notifyDesktop('hotkey.configure', { paused: true }),
                end: (current) => notifyDesktop('hotkey.configure', { overlay: current, paused: false }),
              }}
              status={preferences.overlayHotkey ? overlayStatus : null}
            />
          )}
        </SettingGroup>
      )}
      {shown('desktop-autostart') && (
        <SettingGroup title={t(($) => $.settings.desktop.start)}>
          {toggle('desktop-autostart', 'autostart')}
        </SettingGroup>
      )}
    </>
  );
}
