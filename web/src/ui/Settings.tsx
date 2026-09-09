import { useEffect, useMemo, useState } from 'react';
import { Camera, MonitorUp, Mic, Keyboard, User } from 'lucide-react';
import { Tabs } from '@base-ui/react/tabs';
import type { Meeting } from '../core/meeting';
import {
  automaticProfile,
  readPreferences,
  savePreferences,
  type AudioPreferences,
  type Preferences,
} from '../core/preferences';
import { Store } from '../core/store';
import { hotkeyFromEvent, hotkeyLabel, defaultMicHotkey, type Hotkey } from '../core/hotkeys';
import { notifyDesktop, desktopHotkeyStatus } from '../core/desktop';
import { DeviceCheck } from './DeviceCheck';
import type { ScreenProfile, FrameRate, Resolution } from '../media/profiles';
import { Modal, useStore } from './primitives';

export function QualityFields({
  kind,
  profile,
  change,
}: {
  kind: 'screen' | 'camera';
  profile: ScreenProfile;
  change: (next: ScreenProfile) => void;
}) {
  const title = kind === 'screen' ? 'Демонстрация экрана' : 'Видео с камеры';
  const label = kind === 'screen' ? 'Экран' : 'Камера';
  return (
    <section className="quality-section" aria-label={title}>
      <h3>
        {kind === 'screen' ? <MonitorUp size={19} /> : <Camera size={19} />}
        {title}
      </h3>
      <div className="settings-row">
        <label>
          Качество
          <select
            aria-label={label + ': качество'}
            value={profile.automatic ? 'auto' : profile.resolution}
            onChange={(e) =>
              change({
                ...profile,
                resolution:
                  e.target.value === 'auto'
                    ? automaticProfile(kind).resolution
                    : (Number(e.target.value) as Resolution),
                automatic: e.target.value === 'auto',
              })
            }
          >
            <option value="auto">Авто</option>
            <option value="720">720p · HD</option>
            <option value="1080">1080p · Full HD</option>
            <option value="1440">1440p · QHD</option>
          </select>
        </label>
        <label>
          Плавность
          <select
            aria-label={label + ': частота кадров'}
            value={profile.automaticFps !== false ? 'auto' : profile.fps}
            onChange={(e) =>
              change({
                ...profile,
                fps: e.target.value === 'auto' ? 30 : (Number(e.target.value) as FrameRate),
                automaticFps: e.target.value === 'auto',
              })
            }
          >
            <option value="auto">Авто · до 30 fps</option>
            <option value="15">15 fps</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps · плавнее</option>
          </select>
        </label>
      </div>
      {kind === 'screen' && (
        <fieldset className="mode-selector">
          <legend>Что показываете?</legend>
          {(['text', 'motion'] as const).map((mode) => (
            <label key={mode} data-active={profile.mode === mode}>
              <input
                type="radio"
                name="screen-mode"
                checked={profile.mode === mode}
                onChange={() => change({ ...profile, mode })}
              />
              <strong>{mode === 'text' ? 'Текст и работа' : 'Видео и движение'}</strong>
              <span>{mode === 'text' ? 'Чёткие детали' : 'Плавная картинка'}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="form-footnote">
        {!profile.automatic
          ? `Запрошено ${profile.resolution}p. Фактическое качество зависит от источника и сети.`
          : kind === 'screen'
            ? 'Авто ограничивает экран до 1080p; сеть может снижать качество.'
            : 'Авто начинает с 720p и адаптируется к сети.'}
      </p>
    </section>
  );
}
export function AudioFields({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const constraints = navigator.mediaDevices?.getSupportedConstraints() as
    (MediaTrackSupportedConstraints & { voiceIsolation?: boolean }) | undefined;
  return (
    <section className="audio-settings" aria-label="Обработка микрофона">
      <h3>
        <Mic size={19} /> Голос и микрофон
      </h3>
      <label>
        Подавление шума
        <select
          value={audio.suppression}
          onChange={(e) =>
            change({ ...audio, suppression: e.target.value as AudioPreferences['suppression'] })
          }
        >
          <option value="browser">Стандартное</option>
          <option value="rnnoise" disabled={!('AudioWorkletNode' in window)}>
            RNNoise · усиленное, на устройстве
          </option>
          <option value="voice" disabled={!constraints?.voiceIsolation}>
            Изоляция голоса · системная
          </option>
          <option value="off">Выключено · исходный звук</option>
        </select>
      </label>
      <p className="form-footnote">
        Стандартное подходит для обычного разговора. RNNoise помогает убрать вентилятор и клавиатуру, но
        использует больше ресурсов. Для передачи музыки выберите исходный звук.
      </p>
      <label className="check-setting">
        <input
          type="checkbox"
          checked={audio.echoCancellation}
          onChange={(e) => change({ ...audio, echoCancellation: e.target.checked })}
        />
        <span>
          Подавление эха<small>Помогает при разговоре через динамики.</small>
        </span>
      </label>
      <label className="check-setting">
        <input
          type="checkbox"
          checked={audio.autoGainControl}
          onChange={(e) => change({ ...audio, autoGainControl: e.target.checked })}
        />
        <span>
          Автоматический уровень микрофона<small>Выравнивает тихий и громкий голос.</small>
        </span>
      </label>
      <label className="gain-setting">
        Уровень передачи · {Math.round(audio.gain * 100)}%
        <input
          type="range"
          min="0"
          max="200"
          step="5"
          value={audio.gain * 100}
          onChange={(e) => change({ ...audio, gain: Number(e.target.value) / 100 })}
        />
      </label>
    </section>
  );
}
function HotkeyField({ value, change }: { value: Hotkey | null; change: (key: Hotkey | null) => void }) {
  const [recording, setRecording] = useState(false);
  const nativeStatus = useStore(desktopHotkeyStatus);
  useEffect(() => {
    if (recording) notifyDesktop('hotkey.configure', { hotkey: null });
    return () => {
      if (recording) notifyDesktop('hotkey.configure', { hotkey: value });
    };
  }, [recording, value]);
  return (
    <section className="hotkey-settings">
      <h3>Включить / выключить микрофон</h3>
      <button
        className="hotkey-recorder button secondary"
        data-hotkey-recorder
        aria-label="Назначить сочетание микрофона"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') {
            setRecording(false);
            return;
          }
          const next = hotkeyFromEvent(e.nativeEvent);
          if (next) {
            change(next);
            setRecording(false);
          }
        }}
      >
        {recording ? 'Нажмите сочетание… Esc — отмена' : hotkeyLabel(value)}
      </button>
      <div className="check-actions">
        <button className="button ghost" onClick={() => change({ ...defaultMicHotkey })}>
          По умолчанию
        </button>
        <button className="button ghost" onClick={() => change(null)}>
          Отключить сочетание
        </button>
      </div>
      {window.chrome?.webview && nativeStatus && (
        <p role="status" className="form-footnote">
          {nativeStatus}
        </p>
      )}
      <p className="form-footnote">
        В браузере сочетание работает в открытой вкладке встречи и не мешает вводу текста. В приложении
        Windows сочетания с Ctrl или Alt могут работать и поверх других программ.
      </p>
    </section>
  );
}
export function Settings({
  meeting,
  open,
  onOpenChange,
}: {
  meeting?: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const saved = useMemo(() => new Store(readPreferences()), []);
  const preferences = useStore(meeting?.media.preferences ?? saved);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [tab, setTab] = useState('audio');
  const change = (patch: Partial<Preferences>) => {
    if (meeting) meeting.media.saveSettings(patch);
    else saved.set(savePreferences(patch));
  };
  useEffect(() => {
    if (!open) return;
    if (!meeting) saved.set(readPreferences());
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
  }, [open, meeting, saved]);
  const device = (kind: MediaDeviceKind) => {
    const key = kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker';
    return (
      <label key={kind}>
        {kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Вывод звука'}
        <select
          value={preferences.devices[key] ?? ''}
          disabled={kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype)}
          onChange={(e) => {
            if (meeting) void meeting.media.switchDevice(kind, e.target.value);
            else change({ devices: { ...preferences.devices, [key]: e.target.value } });
          }}
        >
          <option value="">По умолчанию</option>
          {devices
            .filter((d) => d.kind === kind && d.deviceId)
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Устройство ${i + 1}`}
              </option>
            ))}
        </select>
      </label>
    );
  };
  return (
    <Modal
      wide
      open={open}
      onOpenChange={onOpenChange}
      title="Настроить под себя"
      description="Настройки сохраняются на этом устройстве."
    >
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))} className="settings-tabs">
        <Tabs.List className="settings-navigation" aria-label="Разделы настроек">
          <Tabs.Tab value="audio">
            <Mic size={17} /> Звук
          </Tabs.Tab>
          <Tabs.Tab value="video">
            <Camera size={17} /> Видео
          </Tabs.Tab>
          <Tabs.Tab value="profile">
            <User size={17} /> Профиль
          </Tabs.Tab>
          <Tabs.Tab value="hotkeys">
            <Keyboard size={17} /> Клавиши
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="audio" className="settings-form">
          {device('audioinput')}
          {device('audiooutput')}
          <AudioFields
            audio={preferences.audio}
            change={(audio) => {
              if (meeting) void meeting.media.setAudioSettings(audio);
              else change({ audio });
            }}
          />
          {open && <DeviceCheck preferences={preferences} />}
        </Tabs.Panel>
        <Tabs.Panel value="video" className="settings-form">
          {device('videoinput')}
          <QualityFields
            kind="camera"
            profile={preferences.camera}
            change={(camera) => {
              if (meeting) void meeting.media.setCameraProfile(camera);
              else change({ camera });
            }}
          />
          <QualityFields
            kind="screen"
            profile={preferences.screen}
            change={(screen) => {
              if (meeting) void meeting.media.setProfile(screen);
              else change({ screen });
            }}
          />
          {open && <DeviceCheck preferences={preferences} />}
        </Tabs.Panel>
        <Tabs.Panel value="profile" className="settings-form">
          <label>
            Имя по умолчанию
            <input
              maxLength={40}
              value={preferences.name}
              autoComplete="nickname"
              placeholder="Как к вам обращаться?"
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <p className="form-footnote">
            Это имя будет подставляться при следующем входе во встречу. Его можно изменить перед подключением.
          </p>
        </Tabs.Panel>
        <Tabs.Panel value="hotkeys" className="settings-form">
          <HotkeyField value={preferences.micHotkey} change={(micHotkey) => change({ micHotkey })} />
        </Tabs.Panel>
      </Tabs.Root>
      <label className="check-row">
        <input
          type="checkbox"
          checked={preferences.notificationSounds}
          onChange={(e) => change({ notificationSounds: e.target.checked })}
        />{' '}
        Звуки уведомлений
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={preferences.showPing}
          onChange={(e) => change({ showPing: e.target.checked })}
        />{' '}
        Показывать задержку / PING
      </label>
    </Modal>
  );
}
