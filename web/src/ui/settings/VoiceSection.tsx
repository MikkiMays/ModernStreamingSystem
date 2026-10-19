import { useEffect, useState } from 'react';
import { Mic, Square, Video, Volume2, Disc } from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';
import type { LinkState } from '../../media/link-quality';
import { Button, Slider, Switch } from '../kit';
import { useMicLevel } from '../useMicLevel';
import { LevelBar, SettingGroup, SettingRow, SettingValue } from './Row';
import { row } from './sections';
import {
  AutoGainRow,
  ceilingNote,
  EchoRow,
  GainRow,
  NoiseRow,
  PlayoutRow,
  QualityRows,
  ReceptionRow,
} from './media-fields';
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
  const key = DEVICE_KEY[kind];
  const unsupported = kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype);
  return (
    <select
      className="ui-input ui-select setting-select"
      aria-label={label}
      value={preferences.devices[key] ?? ''}
      disabled={unsupported}
      title={unsupported ? 'Этот браузер выводит звук только в системное устройство' : undefined}
      onChange={(e) => {
        if (meeting) void meeting.media.switchDevice(kind, e.target.value);
        else void change({ devices: { ...preferences.devices, [key]: e.target.value } });
      }}
    >
      <option value="">По умолчанию</option>
      {devices
        .filter((device) => device.kind === kind && device.deviceId)
        .map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Устройство ${index + 1}`}
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
  link,
}: {
  preferences: Preferences;
  change: Change;
  meeting?: Meeting;
  link?: LinkState;
}) {
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
  const micHint = check.mic
    ? row('mic-check').hint
    : meeting
      ? 'Так вас слышат во встрече сейчас'
      : undefined;
  return (
    <>
      <SettingGroup title="Микрофон" anchor="microphone">
        <SettingRow id="mic-device" stack>
          <DeviceSelect
            kind="audioinput"
            label={row('mic-device').label}
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
                  aria-label="Ваша тестовая запись"
                />
              )}
            </>
          }
        >
          <div className="setting-check">
            <LevelBar level={level} label="Уровень микрофона" />
            {check.mic && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Disc />}
                disabled={check.recording}
                onClick={check.record}
              >
                {check.recording ? 'Записываем…' : 'Записать 5 с'}
              </Button>
            )}
            <Button
              size="sm"
              variant={check.mic ? 'secondary' : 'primary'}
              icon={check.mic ? <Square /> : <Mic />}
              loading={check.busy === 'microphone'}
              aria-pressed={check.mic}
              onClick={() => void check.toggle('microphone')}
            >
              {check.mic ? 'Остановить' : 'Проверить'}
            </Button>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Динамики" anchor="output">
        <SettingRow id="output-device" stack>
          <DeviceSelect
            kind="audiooutput"
            label={row('output-device').label}
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
              label={row('output-volume').label}
              onChange={(e) => void change({ outputVolume: Number(e.target.value) })}
            />
            <SettingValue>{preferences.outputVolume}%</SettingValue>
          </div>
        </SettingRow>
        <SettingRow id="output-check" below={failure('speaker')}>
          <Button size="sm" variant="secondary" icon={<Volume2 />} onClick={() => void check.speaker()}>
            Проверить
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Обработка звука" anchor="processing">
        <NoiseRow audio={preferences.audio} change={audio} />
        <EchoRow audio={preferences.audio} change={audio} />
      </SettingGroup>

      <SettingGroup title="Камера" anchor="camera">
        <SettingRow id="camera-device" stack>
          <DeviceSelect
            kind="videoinput"
            label={row('camera-device').label}
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
        <SettingRow id="camera-yields">
          <Switch
            checked={preferences.cameraYieldsToScreen}
            ariaLabel={row('camera-yields').label}
            onCheckedChange={(cameraYieldsToScreen) => void change({ cameraYieldsToScreen })}
          />
        </SettingRow>
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
                  aria-label="Превью камеры только для вас"
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
            aria-pressed={check.camera}
            onClick={() => void check.toggle('camera')}
          >
            {check.camera ? 'Скрыть' : 'Показать'}
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Демонстрация экрана" anchor="screen" note={ceilingNote()}>
        <QualityRows
          kind="screen"
          profile={preferences.screen}
          change={(screen) => {
            if (meeting) void meeting.media.setProfile(screen);
            else void change({ screen });
          }}
        />
      </SettingGroup>

      <SettingGroup title="Чужое видео" anchor="reception">
        <ReceptionRow
          mode={preferences.reception}
          change={(reception) => {
            if (meeting) void meeting.media.setReception(reception);
            else void change({ reception });
          }}
        />
      </SettingGroup>

      <SettingGroup title="Дополнительно" anchor="advanced" defaultOpen={false}>
        <PlayoutRow mode={preferences.network} link={link} change={(network) => void change({ network })} />
      </SettingGroup>
    </>
  );
}
