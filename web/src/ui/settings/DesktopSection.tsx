import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { hasFeature } from '../../core/desktop';
import {
  changeDesktopSettings,
  desktopSettings,
  loadDesktopSettings,
  watchDesktopSettings,
  type DesktopSettings,
  type DesktopSwitch,
} from '../../core/desktop-settings';
import { useStore } from '../primitives';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { ROWS, rowAvailable, rowText, type RowId } from './sections';

/**
 * Переключатель раздела «Windows» или «Оверлей»: значение живёт в оболочке (`app.settings`), строка
 * видна только при своём флаге оболочки.
 */
export function DesktopSwitchRow({ id, setting }: { id: RowId; setting: DesktopSwitch }) {
  const { t } = useTranslation();
  const values = useStore(desktopSettings);
  if (!rowAvailable(ROWS[id], 'desktop', hasFeature)) return null;
  return (
    <SettingRow id={id}>
      <Switch
        checked={values?.[setting] ?? false}
        disabled={!values || values[setting] === undefined}
        ariaLabel={rowText(t, id).label}
        onCheckedChange={(checked) =>
          void changeDesktopSettings({ [setting]: checked } as Partial<DesktopSettings>)
        }
      />
    </SettingRow>
  );
}

/** Значения оболочки — прочитать при открытии раздела и следить, пока он открыт. */
export function useDesktopSettings() {
  useEffect(() => {
    void loadDesktopSettings();
    return watchDesktopSettings();
  }, []);
}

/**
 * «Windows» (E03, T53, E01-B2) — только в клиенте на Electron: мягкое взаимодействие с Windows,
 * мини-окно звонка (R93) и автозапуск. Каждая строка видна только при своём флаге оболочки; значения
 * живут в оболочке (`app.settings`). Оверлей в играх — свой раздел рядом («Оверлей», R62).
 *
 * Кнопок на миниатюре и значка поверх иконки нет (R138): владелец убрал их совсем — значок Cord на
 * панели задач всегда один и тот же, а микрофон и выход — в самом окне, трее и мини-окне.
 */
export function DesktopSection() {
  const { t } = useTranslation();
  useDesktopSettings();
  const shown = (id: RowId) => rowAvailable(ROWS[id], 'desktop', hasFeature);
  const taskbar = (['desktop-tray', 'desktop-flash'] as const).some(shown);
  const meeting = (['desktop-sleep', 'desktop-mini'] as const).some(shown);
  return (
    <>
      {taskbar && (
        <SettingGroup title={t(($) => $.settings.desktop.taskbar)}>
          <DesktopSwitchRow id="desktop-tray" setting="tray" />
          <DesktopSwitchRow id="desktop-flash" setting="flash" />
        </SettingGroup>
      )}
      {meeting && (
        <SettingGroup title={t(($) => $.settings.desktop.meeting)}>
          <DesktopSwitchRow id="desktop-sleep" setting="sleepBlocker" />
          <DesktopSwitchRow id="desktop-mini" setting="mini" />
        </SettingGroup>
      )}
      {shown('desktop-autostart') && (
        <SettingGroup title={t(($) => $.settings.desktop.start)}>
          <DesktopSwitchRow id="desktop-autostart" setting="autostart" />
        </SettingGroup>
      )}
    </>
  );
}
