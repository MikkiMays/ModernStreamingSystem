import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Play } from 'lucide-react';
import type { GameKind, Preferences } from '../../core/preferences';
import { NotificationSounds, ensureNotificationAudio } from '../../core/sounds';
import { Slider, Switch } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';
import { useLiveValue } from './live-value';

/** Сигналы, которые можно прослушать: короткие, поэтому узнать их проще, чем описать. */
const SAMPLES = ['self-join', 'join', 'leave', 'knock', 'message', 'screen', 'mic-on', 'mic-off'] as const;

/** Игры со своими звуками стола (T45): у каждой свой выключатель под общим. */
const GAMES: GameKind[] = ['poker', 'durak', 'chess', 'gartic'];

/**
 * «Звуки»: сигналы встречи и звуки игр — одной ручкой громкости (П10) и общим выключателем,
 * под которым у каждой игры свой.
 */
export function SoundsSection({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const demo = useMemo(() => new NotificationSounds(), []);
  const enabled = preferences.notificationSounds;
  const volume = useLiveValue(preferences.soundVolume, (soundVolume) => void change({ soundVolume }));
  return (
    <>
      <SettingGroup title={t(($) => $.settings.sounds.cues)}>
        <SettingRow id="sounds-on">
          <Switch
            checked={enabled}
            ariaLabel={rowText(t, 'sounds-on').label}
            onCheckedChange={(notificationSounds) => void change({ notificationSounds })}
          />
        </SettingRow>
        <SettingRow id="sounds-volume" stack disabled={!enabled}>
          <div className="setting-slider">
            <Slider
              min={0}
              max={100}
              disabled={!enabled}
              value={volume.value}
              label={t(($) => $.settings.sounds.volume)}
              onChange={(e) => volume.onChange(Number(e.target.value))}
              onValueCommitted={volume.onCommit}
            />
            <SettingValue>{volume.value}%</SettingValue>
          </div>
        </SettingRow>
        <SettingRow
          id="sounds-samples"
          disabled={!enabled}
          below={
            <div className="setting-chips" role="group" aria-label={t(($) => $.settings.sounds.samplesLabel)}>
              {SAMPLES.map((cue) => (
                <button
                  key={cue}
                  type="button"
                  className="setting-chip"
                  disabled={!enabled}
                  onClick={() => {
                    ensureNotificationAudio();
                    demo.play(cue);
                  }}
                >
                  <Play size={16} aria-hidden="true" /> {t(($) => $.settings.sounds.samples[cue])}
                </button>
              ))}
            </div>
          }
        />
      </SettingGroup>
      <SettingGroup title={rowText(t, 'sounds-games').label} id="sounds-games">
        {GAMES.map((game) => (
          <div key={game} className="setting-row" data-disabled={!enabled || undefined}>
            <div className="setting-row__text">
              <span className="setting-row__label">{t(($) => $.settings.sounds.games[game])}</span>
            </div>
            <div className="setting-row__control">
              <Switch
                checked={preferences.gameSounds[game]}
                disabled={!enabled}
                ariaLabel={t(($) => $.settings.sounds.gameLabel, {
                  game: t(($) => $.settings.sounds.games[game]),
                })}
                onCheckedChange={(on) =>
                  void change({ gameSounds: { ...preferences.gameSounds, [game]: on } })
                }
              />
            </div>
          </div>
        ))}
      </SettingGroup>
    </>
  );
}
