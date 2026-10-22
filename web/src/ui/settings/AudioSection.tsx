import { useTranslation } from 'react-i18next';
import { CircleDot, Disc, Play, Square } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';
import { Button, Slider } from '../kit';
import { useMicLevel } from '../useMicLevel';
import { LevelMeter, SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';
import { DeviceSelect, useMediaDevices } from './devices';
import { AutoGainRow, EchoRow, GainRow, NoiseRow } from './media-fields';
import { useDeviceCheck } from './useDeviceCheck';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/**
 * «Звук» (R100) — две карточки, как у Телемоста (n08), и обе помещаются в окно без прокрутки
 * (R101). «Микрофон»: выбор устройства с «Проверить» в одной строке, уровень делениями справа от
 * заголовка, громкость и обработка. «Динамики»: выбор с «Проверить» и громкость собеседников.
 * Камеры здесь нет — и её индикатор не загорается, пока настраивают звук.
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
  const check = useDeviceCheck(preferences);
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
  // Во встрече индикатор показывает, как вас слышат сейчас; своя проверка — пока она идёт.
  const level = check.mic ? check.level : published;
  return (
    <>
      <SettingGroup
        title={t(($) => $.settings.anchors.microphone)}
        anchor="microphone"
        aside={
          <LevelMeter
            level={level}
            label={t(($) => $.settings.voice.micLevel)}
            title={meeting && !check.mic ? t(($) => $.settings.voice.micInMeeting) : undefined}
          />
        }
      >
        <SettingRow
          id="mic-device"
          wide
          below={
            <>
              {failure('microphone')}
              {check.recorded && (
                <audio
                  ref={check.playback}
                  className="setting-recording"
                  controls
                  src={check.recorded}
                  aria-label={t(($) => $.settings.voice.recording)}
                />
              )}
            </>
          }
        >
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
            {check.mic && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Disc />}
                disabled={check.recording}
                aria-label={
                  check.recording
                    ? t(($) => $.settings.voice.recordingLabel)
                    : t(($) => $.settings.voice.recordLabel)
                }
                onClick={check.record}
              >
                {check.recording
                  ? t(($) => $.settings.voice.recordingNow)
                  : t(($) => $.settings.voice.record)}
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={check.mic ? <Square /> : <CircleDot />}
              loading={check.busy === 'microphone'}
              aria-label={
                check.mic ? t(($) => $.settings.voice.stopMicLabel) : t(($) => $.settings.voice.checkMicLabel)
              }
              onClick={() => void check.toggle('microphone')}
            >
              {check.mic ? t(($) => $.settings.voice.stop) : t(($) => $.settings.voice.check)}
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
              step={5}
              value={preferences.outputVolume}
              label={rowText(t, 'output-volume').label}
              onChange={(e) => void change({ outputVolume: Number(e.target.value) })}
            />
            <SettingValue>{preferences.outputVolume}%</SettingValue>
          </div>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
