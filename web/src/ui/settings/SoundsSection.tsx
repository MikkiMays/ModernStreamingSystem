import { useMemo } from 'react';
import { Play } from 'lucide-react';
import type { GameKind, Preferences } from '../../core/preferences';
import { NotificationSounds, ensureNotificationAudio } from '../../core/sounds';
import { Slider, Switch } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { row, rowDomId } from './sections';

/** Сигналы, которые можно прослушать: короткие, поэтому узнать их проще, чем описать. */
const SAMPLES = [
  ['self-join', 'Ваш вход'],
  ['join', 'Кто-то вошёл'],
  ['leave', 'Кто-то вышел'],
  ['knock', 'Просятся войти'],
  ['message', 'Сообщение'],
  ['screen', 'Показ экрана'],
  ['mic-on', 'Микрофон включён'],
  ['mic-off', 'Микрофон выключен'],
] as const;

/** Игры со своими звуками стола (T45): у каждой свой выключатель под общим. */
const GAMES: [GameKind, string][] = [
  ['poker', 'Покер'],
  ['durak', 'Дурак'],
  ['chess', 'Шахматы'],
  ['gartic', 'Gartic'],
];

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
  const demo = useMemo(() => new NotificationSounds(), []);
  const enabled = preferences.notificationSounds;
  return (
    <>
      <SettingGroup title="Сигналы" collapsible={false}>
        <SettingRow id="sounds-on">
          <Switch
            checked={enabled}
            ariaLabel={row('sounds-on').label}
            onCheckedChange={(notificationSounds) => void change({ notificationSounds })}
          />
        </SettingRow>
        <SettingRow id="sounds-volume" stack disabled={!enabled}>
          <div className="setting-slider">
            <Slider
              min={0}
              max={100}
              step={5}
              disabled={!enabled}
              value={preferences.soundVolume}
              label="Громкость сигналов и звуков игр"
              onChange={(e) => void change({ soundVolume: Number(e.target.value) })}
            />
            <SettingValue>{preferences.soundVolume}%</SettingValue>
          </div>
        </SettingRow>
        <SettingRow
          id="sounds-samples"
          disabled={!enabled}
          below={
            <div className="setting-chips" role="group" aria-label="Прослушать сигналы">
              {SAMPLES.map(([cue, title]) => (
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
                  <Play size={12} aria-hidden="true" /> {title}
                </button>
              ))}
            </div>
          }
        />
      </SettingGroup>
      <div id={rowDomId('sounds-games')}>
        <SettingGroup title="Звуки игр">
          {GAMES.map(([game, title]) => (
            <div key={game} className="setting-row" data-disabled={!enabled || undefined}>
              <div className="setting-row__text">
                <span className="setting-row__label">{title}</span>
              </div>
              <div className="setting-row__control">
                <Switch
                  checked={preferences.gameSounds[game]}
                  disabled={!enabled}
                  ariaLabel={`Звуки игры: ${title}`}
                  onCheckedChange={(on) =>
                    void change({ gameSounds: { ...preferences.gameSounds, [game]: on } })
                  }
                />
              </div>
            </div>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}
