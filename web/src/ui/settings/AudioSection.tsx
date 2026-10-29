import { useTranslation } from 'react-i18next';
import { CircleDot, Play, Square } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';
import { Store } from '../../core/store';
import { Button, Slider } from '../kit';
import { useStore } from '../primitives';
import { useMicLevel } from '../useMicLevel';
import { LevelMeter, SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';
import { DeviceSelect, useMediaDevices } from './devices';
import { AutoGainRow, EchoRow, GainRow, NoiseRow } from './media-fields';
import { useDeviceCheck } from './useDeviceCheck';
import { useLiveValue } from './live-value';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/** Вне встречи своего микрофона у неё нет — шкала слушает свой захват. */
const NO_MEETING = new Store({ microphone: false });

/**
 * «Микрофон» (R100; до R114 — «Звук», имя путали с соседними «Звуками») — две карточки, как у
 * Телемоста (n08), и обе помещаются в окно без прокрутки (R101). «Микрофон»: выбор устройства с
 * «Проверить» в одной строке, уровень делениями справа от заголовка, громкость и обработка.
 * «Динамики»: выбор с «Проверить» и громкость собеседников.
 * Камеры здесь нет — и её индикатор не загорается, пока настраивают звук.
 *
 * Уровень виден сразу, без кнопки (R141): пока раздел открыт, микрофон слушается сам. Во встрече с
 * включённым микрофоном шкала показывает то, что слышит комната, и второго захвата нет. «Проверить»
 * записывает пять секунд пробы, тут же проигрывает их и забывает — проигрывателя,
 * который нечем убрать, под строкой больше нет.
 */
export function AudioSection({
  preferences,
  change,
  meeting,
}: {
  preferences: Preferences;
  change: Change;
  meeting?: Meeting;
}) {
  const { t } = useTranslation();
  const devices = useMediaDevices();
  const live = useStore(meeting?.media.state ?? NO_MEETING).microphone;
  const check = useDeviceCheck(preferences, { auto: !live });
  const published = useMicLevel(meeting);
  const audio = (next: Preferences['audio']) => {
    if (meeting) void meeting.media.setAudioSettings(next);
    else void change({ audio: next });
  };
  const failure = (kind: 'microphone' | 'speaker') =>
    check.failure?.kind === kind ? (
      <p className="setting-note" data-tone="danger" role="alert">
        {check.failure.text}
      </p>
    ) : null;
  // Громкость собеседников слышна сразу: во время перетаскивания пишется раз в кадр (R14).
  const volume = useLiveValue(preferences.outputVolume, (outputVolume) => void change({ outputVolume }));
  // Во встрече с микрофоном индикатор показывает, как вас слышат сейчас; иначе — свой захват.
  const level = check.mic ? check.level : published;
  const testing = check.test !== 'idle';
  return (
    <>
      <SettingGroup
        title={t(($) => $.settings.anchors.microphone)}
        anchor="microphone"
        aside={
          <LevelMeter
            level={level}
            label={t(($) => $.settings.voice.micLevel)}
            title={live && !check.mic ? t(($) => $.settings.voice.micInMeeting) : undefined}
          />
        }
      >
        <SettingRow id="mic-device" wide below={failure('microphone')}>
          <div className="setting-device">
            <DeviceSelect
              kind="audioinput"
              label={rowText(t, 'mic-device').label}
              devices={devices}
              preferences={preferences}
              change={change}
              meeting={meeting}
              className="setting-device__select"
            />
            <Button
              size="sm"
              variant="secondary"
              icon={testing ? <Square /> : <CircleDot />}
              loading={check.busy === 'microphone' && !check.mic}
              aria-label={
                testing ? t(($) => $.settings.voice.stopMicLabel) : t(($) => $.settings.voice.checkMicLabel)
              }
              onClick={() => void check.runTest()}
            >
              <span role={testing ? 'status' : undefined}>
                {check.test === 'recording'
                  ? t(($) => $.settings.voice.recordingNow, { seconds: check.seconds })
                  : check.test === 'playing'
                    ? t(($) => $.settings.voice.playing)
                    : t(($) => $.settings.voice.check)}
              </span>
            </Button>
          </div>
        </SettingRow>
        <AutoGainRow audio={preferences.audio} change={audio} />
        <GainRow audio={preferences.audio} change={audio} />
        <NoiseRow audio={preferences.audio} change={audio} />
        <EchoRow audio={preferences.audio} change={audio} />
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.output)} anchor="output">
        <SettingRow id="output-device" wide below={failure('speaker')}>
          <div className="setting-device">
            <DeviceSelect
              kind="audiooutput"
              label={rowText(t, 'output-device').label}
              devices={devices}
              preferences={preferences}
              change={change}
              meeting={meeting}
              className="setting-device__select"
            />
            <Button
              size="sm"
              variant="secondary"
              icon={<Play />}
              aria-label={t(($) => $.settings.voice.checkSpeakersLabel)}
              onClick={() => void check.speaker()}
            >
              {t(($) => $.settings.voice.check)}
            </Button>
          </div>
        </SettingRow>
        <SettingRow id="output-volume" stack>
          <div className="setting-slider">
            <Slider
              min={0}
              max={100}
              value={volume.value}
              label={rowText(t, 'output-volume').label}
              onChange={(e) => volume.onChange(Number(e.target.value))}
              onValueCommitted={volume.onCommit}
            />
            <SettingValue>{volume.value}%</SettingValue>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
