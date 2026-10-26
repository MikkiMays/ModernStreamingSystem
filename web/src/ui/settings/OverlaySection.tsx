import { useEffect, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Gamepad2, MoreHorizontal, Plus } from 'lucide-react';
import {
  desktopOverlayHotkeyStatus,
  desktopOverlayLockStatus,
  hasFeature,
  hotkeyStatusText,
  notifyDesktop,
} from '../../core/desktop';
import {
  desktopGames,
  forgetDesktopGame,
  loadDesktopGames,
  pickDesktopGame,
  setDesktopGame,
  watchDesktopGames,
  type DesktopGame,
} from '../../core/desktop-games';
import {
  changeDesktopSettings,
  desktopSettings,
  OVERLAY_CORNERS,
  OVERLAY_NAMES,
  OVERLAY_OPACITY,
  OVERLAY_SIZES,
  type OverlayCorner,
  type OverlayNames,
  type OverlaySize,
} from '../../core/desktop-settings';
import { defaultOverlayLockHotkey, hotkeyNotes, type Hotkey } from '../../core/hotkeys';
import type { Preferences } from '../../core/preferences';
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  Slider,
  Switch,
} from '../kit';
import { Avatar, useStore } from '../primitives';
import { DesktopSwitchRow, useDesktopSettings } from './DesktopSection';
import { HotkeyField } from './HotkeyField';
import { useLiveValue } from './live-value';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { ROWS, rowAvailable, rowText, type RowId } from './sections';

/**
 * «Оверлей» (R62, R63, R104) — как «Игровой оверлей» и «Зарегистрированные игры» Discord, но без
 * того, что требует аккаунтов (X2: IGDB, активность друзей, конфиденциальность) и без бесполезных
 * переключателей (X3: устаревший оверлей, режим совместимости, интерактивные области).
 *
 * Группы: «Оверлей в играх» — переключатель, клавиши показа и разблокировки, всплывашка «Показать
 * игру»; «Игры» — игра, запущенная сейчас, и список: что Cord узнал сам или что добавили, у каждой —
 * свой переключатель и «Забыть»; «Говорящие» — живой образец виджета и его положение, размер, имена и
 * прозрачность. Каждая строка видна только при своём флаге оболочки: оболочка 1.0.7 покажет здесь
 * только переключатель и клавишу, как раньше.
 */
export function OverlaySection({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  useDesktopSettings();
  const toggleStatus = useStore(desktopOverlayHotkeyStatus);
  const lockStatus = useStore(desktopOverlayLockStatus);
  const shown = (id: RowId) => rowAvailable(ROWS[id], 'desktop', hasFeature);
  const native = hasFeature('ptt');
  const widget = (['overlay-corner', 'overlay-size', 'overlay-names', 'overlay-opacity'] as const).some(
    shown,
  );
  return (
    <>
      <SettingGroup
        title={t(($) => $.settings.overlay.title)}
        note={t(($) => $.settings.desktop.overlayNote)}
      >
        <DesktopSwitchRow id="desktop-overlay" setting="overlay" />
        {shown('desktop-overlay-hotkey') && hasFeature('hotkeys') && (
          <HotkeyField
            id="desktop-overlay-hotkey"
            value={preferences.overlayHotkey}
            change={(overlayHotkey: Hotkey | null) => void change({ overlayHotkey })}
            // Raw Input (флаг `ptt`): любая клавиша и кнопки мыши поверх всего — заметки другие.
            notes={(key) => hotkeyNotes(t, key, native ? 'native' : 'desktop', false)}
            mouse={native}
            taken={{ key: preferences.micHotkey, text: t(($) => $.settings.desktop.overlayTaken) }}
            labels={{
              change: t(($) => $.settings.desktop.changeLabel),
              assign: t(($) => $.settings.desktop.assignLabel),
              reset: t(($) => $.settings.desktop.resetLabel),
            }}
            pause={{
              start: () => notifyDesktop('hotkey.configure', { paused: true }),
              end: (current) => notifyDesktop('hotkey.configure', { overlay: current, paused: false }),
            }}
            status={preferences.overlayHotkey ? hotkeyStatusText(t, toggleStatus) : null}
          />
        )}
        {shown('overlay-lock-hotkey') && (
          <HotkeyField
            id="overlay-lock-hotkey"
            value={preferences.overlayLockHotkey}
            defaultValue={defaultOverlayLockHotkey}
            change={(overlayLockHotkey: Hotkey | null) => void change({ overlayLockHotkey })}
            notes={(key) => hotkeyNotes(t, key, native ? 'native' : 'desktop', false)}
            mouse={native}
            taken={{ key: preferences.micHotkey, text: t(($) => $.settings.desktop.overlayTaken) }}
            labels={{
              change: t(($) => $.settings.overlay.lockChange),
              assign: t(($) => $.settings.overlay.lockAssign),
              reset: t(($) => $.settings.overlay.lockReset),
            }}
            pause={{
              start: () => notifyDesktop('hotkey.configure', { paused: true }),
              end: (current) => notifyDesktop('hotkey.configure', { lock: current, paused: false }),
            }}
            status={preferences.overlayLockHotkey ? hotkeyStatusText(t, lockStatus) : null}
          />
        )}
        <DesktopSwitchRow id="overlay-toast" setting="overlayToast" />
      </SettingGroup>
      {shown('overlay-games') && <GamesGroup />}
      {widget && <WidgetGroup name={preferences.name} />}
    </>
  );
}

/** «Последний запуск 5 дней назад» — словами языка интерфейса. */
function lastSeen(language: string, at: number, now: number): string {
  const seconds = Math.round((at - now) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 86400],
    ['month', 30 * 86400],
    ['week', 7 * 86400],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  for (const [unit, size] of units)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, 'minute');
}

/** «Игры»: запущенная сейчас — карточкой сверху, под ней все, что Cord помнит, и «Добавить игру». */
function GamesGroup() {
  const { t, i18n } = useTranslation();
  const games = useStore(desktopGames);
  useEffect(() => {
    void loadDesktopGames();
    return watchDesktopGames();
  }, []);
  const active = games?.active ?? null;
  const now = Date.now();
  const status = (game: DesktopGame) => {
    if (active?.exe === game.exe)
      return active.exclusive ? t(($) => $.settings.overlay.exclusive) : t(($) => $.settings.overlay.running);
    return game.lastSeen
      ? t(($) => $.settings.overlay.lastSeen, {
          when: lastSeen(i18n.resolvedLanguage ?? 'ru', game.lastSeen, now),
        })
      : t(($) => $.settings.overlay.added);
  };
  const toggle = (game: DesktopGame) => (
    <Switch
      checked={game.enabled}
      ariaLabel={t(($) => $.settings.overlay.gameSwitch, { name: game.name })}
      onCheckedChange={(checked) => void setDesktopGame(game.exe, checked)}
    />
  );
  const current = active ? (games?.games.find((game) => game.exe === active.exe) ?? null) : null;
  return (
    <SettingGroup id="overlay-games" title={t(($) => $.settings.overlay.games)}>
      <div className="overlay-now" data-active={current ? 'true' : undefined}>
        <span className="overlay-now__label">{t(($) => $.settings.overlay.now)}</span>
        {current ? (
          <div className="overlay-game overlay-game--now">
            <span className="overlay-game__icon" aria-hidden="true">
              <Gamepad2 size={20} />
            </span>
            <span className="overlay-game__text">
              <span className="overlay-game__name">{current.name}</span>
              <span className="overlay-game__status" data-tone={active?.exclusive ? 'warning' : undefined}>
                {status(current)}
              </span>
            </span>
            {toggle(current)}
          </div>
        ) : (
          <p className="overlay-now__none">{t(($) => $.settings.overlay.none)}</p>
        )}
      </div>
      {games && games.games.length === 0 && (
        <p className="overlay-games__empty">{t(($) => $.settings.overlay.empty)}</p>
      )}
      {!!games?.games.length && (
        <ul className="overlay-games">
          {games.games.map((game) => (
            <li key={game.exe} className="overlay-game">
              <span className="overlay-game__text">
                <span className="overlay-game__name">{game.name}</span>
                <span className="overlay-game__status">{status(game)}</span>
              </span>
              {toggle(game)}
              <Menu>
                <MenuTrigger
                  render={
                    <IconButton size="sm" label={t(($) => $.settings.overlay.more, { name: game.name })}>
                      <MoreHorizontal size={16} />
                    </IconButton>
                  }
                />
                <MenuContent align="end">
                  <MenuItem onClick={() => void forgetDesktopGame(game.exe)}>
                    {t(($) => $.settings.overlay.forget)}
                  </MenuItem>
                </MenuContent>
              </Menu>
            </li>
          ))}
        </ul>
      )}
      <div className="overlay-games__add">
        <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => void pickDesktopGame()}>
          {t(($) => $.settings.overlay.add)}
        </Button>
      </div>
    </SettingGroup>
  );
}

/**
 * «Говорящие»: живой образец виджета на сцене-«игре» — в выбранном углу, выбранного размера, с теми
 * же правилами имён и прозрачностью; под ним — сами настройки.
 */
function WidgetGroup({ name }: { name: string }) {
  const { t } = useTranslation();
  const values = useStore(desktopSettings);
  const corner = values?.overlayCorner ?? 'tl';
  const size = values?.overlaySize ?? 'm';
  const names = values?.overlayNames ?? 'always';
  const ready = !!values && values.overlayCorner !== undefined;
  const opacity = useLiveValue(
    values?.overlayOpacity ?? 100,
    (overlayOpacity) => void changeDesktopSettings({ overlayOpacity }),
    {
      live: false,
    },
  );
  const samples = [
    { id: 'you', name: name.trim() || t(($) => $.settings.overlay.sample1), tier: 3, muted: false },
    { id: 'b', name: t(($) => $.settings.overlay.sample2), tier: 0, muted: true },
    { id: 'c', name: t(($) => $.settings.overlay.sample3), tier: 0, muted: false },
  ];
  const label = (id: RowId) => rowText(t, id).label;
  return (
    <SettingGroup title={t(($) => $.settings.overlay.widget)}>
      <div className="overlay-preview" aria-label={t(($) => $.settings.overlay.preview)} role="img">
        <div
          className="overlay-preview__widget"
          data-corner={corner}
          data-size={size}
          data-names={names}
          style={{ '--preview-opacity': opacity.value / 100 } as CSSProperties}
        >
          {samples.map((sample) => (
            <span
              key={sample.id}
              className="overlay-preview__person"
              data-tier={sample.tier}
              data-muted={sample.muted || undefined}
            >
              <Avatar name={sample.name} />
              <span className="overlay-preview__name">{sample.name}</span>
            </span>
          ))}
        </div>
      </div>
      <SettingRow id="overlay-corner">
        <Segmented<OverlayCorner>
          aria-label={label('overlay-corner')}
          size="sm"
          disabled={!ready}
          value={corner}
          onValueChange={(overlayCorner) => void changeDesktopSettings({ overlayCorner })}
          options={OVERLAY_CORNERS.map((value) => ({
            value,
            label: <span className="overlay-corner-icon" data-corner={value} aria-hidden="true" />,
            ariaLabel: t(($) => $.settings.overlay.corners[value]),
            title: t(($) => $.settings.overlay.corners[value]),
          }))}
        />
      </SettingRow>
      <SettingRow id="overlay-size">
        <Segmented<OverlaySize>
          aria-label={label('overlay-size')}
          size="sm"
          disabled={!ready}
          value={size}
          onValueChange={(overlaySize) => void changeDesktopSettings({ overlaySize })}
          options={OVERLAY_SIZES.map((value) => ({
            value,
            label: t(($) => $.settings.overlay.sizes[value]),
          }))}
        />
      </SettingRow>
      <SettingRow id="overlay-names">
        <Segmented<OverlayNames>
          aria-label={label('overlay-names')}
          size="sm"
          disabled={!ready}
          value={names}
          onValueChange={(overlayNames) => void changeDesktopSettings({ overlayNames })}
          options={OVERLAY_NAMES.map((value) => ({
            value,
            label: t(($) => $.settings.overlay.names[value]),
          }))}
        />
      </SettingRow>
      <SettingRow id="overlay-opacity" stack>
        <div className="setting-slider">
          <Slider
            min={OVERLAY_OPACITY.min}
            max={OVERLAY_OPACITY.max}
            disabled={!ready}
            value={opacity.value}
            label={label('overlay-opacity')}
            onChange={(event) => opacity.onChange(Number(event.target.value))}
            onValueCommitted={opacity.onCommit}
          />
          <SettingValue>{opacity.value}%</SettingValue>
        </div>
      </SettingRow>
    </SettingGroup>
  );
}
