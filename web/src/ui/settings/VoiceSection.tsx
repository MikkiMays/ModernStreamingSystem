import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Square, Video, Volume2, Disc } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';
import { Button, Slider } from '../kit';
import { useMicLevel } from '../useMicLevel';
import { LevelBar, SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';
import { AutoGainRow, ceilingNote, EchoRow, GainRow, NoiseRow, QualityRows } from './media-fields';
import { useDeviceCheck } from './useDeviceCheck';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/** Устройства, которые видит браузер, — и снова, когда что-то подключили или вынули. */
function useMediaDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (active) setDevices(list);
        })
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, []);
  return devices;
}

const DEVICE_KEY = { audioinput: 'microphone', videoinput: 'camera', audiooutput: 'speaker' } as const;

function DeviceSelect({
  kind,
  label,
  devices,
  preferences,
  change,
  meeting,
}: {
  kind: MediaDeviceKind;
  label: string;
  devices: MediaDeviceInfo[];
  preferences: Preferences;
  change: Change;
  meeting?: Meeting;
}) {
  const { t } = useTranslation();
  const key = DEVICE_KEY[kind];
  const unsupported = kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype);
  return (
    <select
      className="ui-input ui-select setting-select"
      aria-label={label}
      value={preferences.devices[key] ?? ''}
      disabled={unsupported}
      title={unsupported ? t(($) => $.settings.voice.systemOutputOnly) : undefined}
      onChange={(e) => {
        if (meeting) void meeting.media.switchDevice(kind, e.target.value);
        else void change({ devices: { ...preferences.devices, [key]: e.target.value } });
      }}
    >
      <option value="">{t(($) => $.settings.voice.defaultDevice)}</option>
      {devices
        .filter((device) => device.kind === kind && device.deviceId)
        .map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || t(($) => $.settings.voice.device, { number: index + 1 })}
          </option>
        ))}
    </select>
  );
}

/**
 * «Голос и видео» по образцу FACEIT (T31): у каждого устройства — выбор, громкость и проверка в
 * той же группе, а не в отдельном блоке внизу. Подразделы — якоря слева, как у Discord.
 */
export function VoiceSection({
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
  const failure = (kind: 'microphone' | 'camera' | 'speaker') =>
    check.failure?.kind === kind ? (
      <p className="setting-note" data-tone="danger" role="alert">
        {check.failure.text}
      </p>
    ) : null;
  // Во встрече полоса показывает, как вас слышат сейчас; своя проверка — пока она идёт.
  const level = check.mic ? check.level : published;
  const micHint = meeting && !check.mic ? t(($) => $.settings.voice.micInMeeting) : undefined;
  return (
    <>
      <SettingGroup title={t(($) => $.settings.anchors.microphone)} anchor="microphone">
        <SettingRow id="mic-device" stack>
          <DeviceSelect
            kind="audioinput"
            label={rowText(t, 'mic-device').label}
            devices={devices}
            preferences={preferences}
            change={change}
            meeting={meeting}
          />
        </SettingRow>
        <GainRow audio={preferences.audio} change={audio} />
        <AutoGainRow audio={preferences.audio} change={audio} />
        <SettingRow
          id="mic-check"
          hint={micHint}
          stack
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
          <div className="setting-check">
            <LevelBar level={level} label={t(($) => $.settings.voice.micLevel)} />
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
              variant={check.mic ? 'secondary' : 'primary'}
              icon={check.mic ? <Square /> : <Mic />}
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
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.output)} anchor="output">
        <SettingRow id="output-device" stack>
          <DeviceSelect
            kind="audiooutput"
            label={rowText(t, 'output-device').label}
            devices={devices}
            preferences={preferences}
            change={change}
            meeting={meeting}
          />
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
        <SettingRow id="output-check" below={failure('speaker')}>
          <Button
            size="sm"
            variant="secondary"
            icon={<Volume2 />}
            aria-label={t(($) => $.settings.voice.checkSpeakersLabel)}
            onClick={() => void check.speaker()}
          >
            {t(($) => $.settings.voice.check)}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.processing)} anchor="processing">
        <NoiseRow audio={preferences.audio} change={audio} />
        <EchoRow audio={preferences.audio} change={audio} />
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.camera)} anchor="camera">
        <SettingRow id="camera-device" stack>
          <DeviceSelect
            kind="videoinput"
            label={rowText(t, 'camera-device').label}
            devices={devices}
            preferences={preferences}
            change={change}
            meeting={meeting}
          />
        </SettingRow>
        <QualityRows
          kind="camera"
          profile={preferences.camera}
          change={(camera) => {
            if (meeting) void meeting.media.setCameraProfile(camera);
            else void change({ camera });
          }}
        />
        <SettingRow
          id="camera-preview"
          below={
            <>
              {failure('camera')}
              {check.camera && (
                <video
                  ref={check.video}
                  className="setting-preview"
                  autoPlay
                  muted
                  playsInline
                  aria-label={t(($) => $.settings.voice.previewLabel)}
                />
              )}
            </>
          }
        >
          <Button
            size="sm"
            variant="secondary"
            icon={check.camera ? <Square /> : <Video />}
            loading={check.busy === 'camera'}
            aria-label={
              check.camera
                ? t(($) => $.settings.voice.hidePreviewLabel)
                : t(($) => $.settings.voice.showPreviewLabel)
            }
            onClick={() => void check.toggle('camera')}
          >
            {check.camera ? t(($) => $.settings.voice.hide) : t(($) => $.settings.voice.show)}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.screen)} anchor="screen" note={ceilingNote(t)}>
        <QualityRows
          kind="screen"
          profile={preferences.screen}
          change={(screen) => {
            if (meeting) void meeting.media.setProfile(screen);
            else void change({ screen });
          }}
        />
      </SettingGroup>
    </>
  );
}
