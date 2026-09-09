import {
  ArrowLeft,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Headphones,
  ArrowRight,
  LoaderCircle,
  Settings2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { publicApi, RoomApi } from '../api/client';
import type { Admission } from '../api/types';
import type { DeviceChoice } from '../media/session';
import type { Destination } from './Home';
import { Avatar, IconButton, Logo, Modal } from './primitives';
import { readPreferences, savePreferences } from '../core/preferences';
import { requestDevicePermissions, type DevicePermissions } from '../core/permissions';
import { favoriteApi } from '../core/favorites';
import { QualityFields } from './Settings';

export function Prejoin({
  destination,
  onBack,
  onJoin,
}: {
  destination: Destination | null;
  onBack: () => void;
  onJoin: (admission: Admission, choices: DeviceChoice & { micOn: boolean; cameraOn: boolean }) => void;
}) {
  const [name, setName] = useState(localStorage.getItem('cord:name') ?? '');
  const [title, setTitle] = useState('Наша встреча');
  const [settings, setSettings] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [preferences, setPreferences] = useState(readPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [choices, setChoices] = useState<DeviceChoice>(() => readPreferences().devices);
  const [permissions, setPermissions] = useState<DevicePermissions | null>(null);
  const [camera, setCamera] = useState(false);
  const [mic, setMic] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef(new MediaStream());
  const commandId = useRef(crypto.randomUUID());
  const mounted = useRef(true);
  const refreshDevices = () => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => {});
  };
  useEffect(() => {
    mounted.current = true;
    void import('../media/session');
    refreshDevices();
    void requestDevicePermissions().then((result) => {
      if (mounted.current) {
        setPermissions(result);
        refreshDevices();
      }
    });
    const media = stream.current;
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      mounted.current = false;
      media.getTracks().forEach((t) => t.stop());
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
    };
  }, []);
  const toggle = async (kind: 'audio' | 'video') => {
    if (deviceBusy) return;
    setDeviceBusy(true);
    setError('');
    const enabled = kind === 'audio' ? mic : camera;
    try {
      if (enabled) {
        stream.current
          .getTracks()
          .filter((t) => t.kind === kind)
          .forEach((t) => {
            t.stop();
            stream.current.removeTrack(t);
          });
      } else {
        const acquired = await navigator.mediaDevices.getUserMedia(
          kind === 'video'
            ? {
                video: {
                  deviceId: choices.camera || undefined,
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                },
              }
            : {
                audio: {
                  deviceId: choices.microphone || undefined,
                  echoCancellation: true,
                  noiseSuppression: true,
                },
              },
        );
        if (!mounted.current) {
          acquired.getTracks().forEach((t) => t.stop());
          return;
        }
        acquired.getTracks().forEach((t) => stream.current.addTrack(t));
      }
      if (kind === 'video') setCamera(!enabled);
      else setMic(!enabled);
      if (preview.current) {
        preview.current.srcObject = stream.current;
        void preview.current.play().catch(() => {});
      }
      refreshDevices();
    } catch {
      setError(
        'Не удалось получить доступ к устройству. Проверьте разрешения браузера. Войти слушателем можно без них.',
      );
    } finally {
      setDeviceBusy(false);
    }
  };
  return (
    <div className="prejoin-page">
      <header className="app-header">
        <Logo />
        <button className="button ghost" onClick={onBack}>
          <ArrowLeft size={18} /> На главную
        </button>
      </header>
      <main className="prejoin-main">
        <div className="preview-column">
          <div className="preview-stage">
            <video
              ref={preview}
              muted
              autoPlay
              playsInline
              className={camera ? 'preview-video' : 'preview-video hidden'}
              aria-label="Предпросмотр вашей камеры"
            />
            {!camera && (
              <div className="preview-avatar">
                <Avatar name={name || 'Вы'} large />
                <p>Камера выключена</p>
              </div>
            )}
            <span className="preview-label">Вы · предпросмотр</span>
            <div className="preview-controls">
              <IconButton
                label={mic ? 'Выключить микрофон' : 'Включить микрофон'}
                className={mic ? 'active' : ''}
                disabled={deviceBusy}
                onClick={() => void toggle('audio')}
              >
                {mic ? <Mic /> : <MicOff />}
              </IconButton>
              <IconButton
                label={camera ? 'Выключить камеру' : 'Включить камеру'}
                className={camera ? 'active' : ''}
                disabled={deviceBusy}
                onClick={() => void toggle('video')}
              >
                {camera ? <Video /> : <VideoOff />}
              </IconButton>
            </div>
            <IconButton
              label="Настройки предпросмотра"
              className="preview-settings"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={21} />
            </IconButton>
          </div>
          <p className="preview-caption">
            <Headphones size={17} /> Для лучшего звука рекомендуем наушники
          </p>
        </div>
        <form
          className="prejoin-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError('');
            try {
              const admission =
                destination?.kind === 'favorite'
                  ? await favoriteApi.join(destination.favorite.roomId, name.trim(), commandId.current)
                  : destination?.kind === 'recent'
                    ? await new RoomApi(destination.admission).rejoin(name.trim(), commandId.current)
                    : destination?.kind === 'code'
                      ? await publicApi.joinCode({
                          commandId: commandId.current,
                          code: destination.code,
                          name: name.trim(),
                        })
                      : destination?.kind === 'invite'
                        ? await publicApi.join(destination.roomId, {
                            commandId: commandId.current,
                            invite: destination.invite,
                            name: name.trim(),
                          })
                        : await publicApi.create({
                            commandId: commandId.current,
                            title: title.trim(),
                            name: name.trim(),
                            approvalRequired,
                          });
              if (destination?.kind === 'recent') admission.inviteUrl = destination.admission.inviteUrl;
              localStorage.setItem('cord:name', name.trim());
              savePreferences({ devices: choices });
              stream.current.getTracks().forEach((t) => t.stop());
              onJoin(admission, { ...choices, micOn: mic, cameraOn: camera });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <span className="eyebrow">{destination ? 'ПОЧТИ НА МЕСТЕ' : 'НОВАЯ ВСТРЕЧА'}</span>
          <h1>
            {destination?.kind === 'favorite'
              ? destination.favorite.title
              : destination?.kind === 'recent'
                ? destination.admission.snapshot.title
                : 'Готовы к разговору?'}
          </h1>
          <p className="muted">
            Проверьте, как вас видят и слышат.
            <br />
            Подключиться можно и без устройств.
          </p>
          <label htmlFor="display-name">Ваше имя</label>
          <input
            id="display-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              localStorage.setItem('cord:name', e.target.value.trim());
              commandId.current = crypto.randomUUID();
            }}
            maxLength={40}
            placeholder="Как к вам обращаться?"
            required
            autoFocus
            autoComplete="nickname"
          />
          {!destination && (
            <>
              <label htmlFor="meeting-name">Название встречи</label>
              <input
                id="meeting-name"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  commandId.current = crypto.randomUUID();
                }}
                maxLength={80}
                required
                placeholder="Например, Вечер с друзьями"
              />
              <small className="form-footnote">Название задаётся один раз и останется у этой комнаты.</small>
            </>
          )}
          <p className="permission-note" role="status">
            {!permissions
              ? 'Проверяем разрешения камеры и микрофона…'
              : permissions.camera === 'granted' && permissions.microphone === 'granted'
                ? 'Доступ разрешён. Камера и микрофон выключены — включите их, когда будете готовы.'
                : 'Можно войти без устройств. Доступ к камере и микрофону меняется в настройках браузера.'}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary full" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}{' '}
            {busy
              ? 'Подключаемся…'
              : destination?.kind === 'code'
                ? 'Запросить подключение'
                : destination
                  ? 'Войти во встречу'
                  : 'Начать встречу'}
          </button>
          <p className="form-footnote">Ссылка и QR для приглашения появятся в комнате.</p>
        </form>
      </main>
      <Modal
        open={settings}
        onOpenChange={setSettings}
        title="Перед разговором"
        description="Устройства и качество сохраняются на этом устройстве. Камеру и микрофон вы включаете сами."
      >
        <div className="settings-form">
          <h3>Устройства</h3>
          {(['audioinput', 'videoinput', 'audiooutput'] as const).map((kind) => {
            const key = kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker';
            return (
              <label key={kind}>
                {kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Вывод звука'}
                <select
                  value={choices[key] ?? ''}
                  disabled={
                    kind === 'audioinput'
                      ? mic
                      : kind === 'videoinput'
                        ? camera
                        : !('setSinkId' in HTMLMediaElement.prototype)
                  }
                  onChange={(e) => {
                    const next = { ...choices, [key]: e.target.value };
                    setChoices(next);
                    savePreferences({ devices: next });
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
          })}
          {(camera || mic) && (
            <small className="muted">Выключите предпросмотр устройства, чтобы сменить его.</small>
          )}
          <QualityFields
            kind="camera"
            profile={preferences.camera}
            change={(p) => setPreferences(savePreferences({ camera: p }))}
          />
          <QualityFields
            kind="screen"
            profile={preferences.screen}
            change={(p) => setPreferences(savePreferences({ screen: p }))}
          />
          {!destination && (
            <label className="check-setting">
              <input
                type="checkbox"
                checked={approvalRequired}
                onChange={(e) => {
                  setApprovalRequired(e.target.checked);
                  commandId.current = crypto.randomUUID();
                }}
              />{' '}
              Подтверждать вход по приглашению
            </label>
          )}
        </div>
      </Modal>
    </div>
  );
}
