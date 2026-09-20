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
  DoorOpen,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { publicApi, RoomApi } from '../api/client';
import type { Admission } from '../api/types';
import type { DeviceChoice } from '../media/session';
import type { Destination } from './Home';
import { Avatar, IconButton, Logo, Modal } from './primitives';
import { readPreferences, savePreferences } from '../core/preferences';
import { autoJoinEnabled, favoriteApi } from '../core/favorites';
import { servicesApi } from '../core/services';
import { AudioFields, QualityFields, ReceptionFields } from './Settings';
import { audioCapture } from '../media/audio';

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
  const [integrationsAllowed, setIntegrationsAllowed] = useState(true);
  const [autoJoining, setAutoJoining] = useState(
    () => destination?.kind === 'favorite' && autoJoinEnabled(destination.favorite.roomId),
  );
  const automaticStarted = useRef(false);
  const [preferences, setPreferences] = useState(readPreferences);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [choices, setChoices] = useState<DeviceChoice>(() => readPreferences().devices);
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
    const media = stream.current;
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => {
      mounted.current = false;
      media.getTracks().forEach((t) => t.stop());
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices);
    };
  }, []);
  useEffect(() => {
    if (destination?.kind !== 'telegram') return;
    let active = true;
    void servicesApi
      .previewClaim(destination.token)
      .then((value) => {
        if (active) {
          setTitle(value.title);
          setName((current) => current || value.name);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [destination]);
  useEffect(() => {
    if (!autoJoining || automaticStarted.current || destination?.kind !== 'favorite') return;
    automaticStarted.current = true;
    const displayName = name.trim() || 'Участник';
    void favoriteApi
      .join(destination.favorite.roomId, displayName, commandId.current)
      .then((admission) => {
        if (!mounted.current) {
          void new RoomApi(admission)
            .command({ commandId: crypto.randomUUID(), type: 'leave' })
            .catch(() => {});
          return;
        }
        savePreferences({ name: displayName });
        onJoin(admission, { ...choices, micOn: true, cameraOn: false });
      })
      .catch((e) => {
        if (mounted.current) {
          setError((e as Error).message);
          setAutoJoining(false);
        }
      });
  }, [autoJoining, destination, name, choices, onJoin]);
  if (autoJoining)
    return (
      <main className="loading-room">
        <LoaderCircle className="spin" size={30} />
        <p role="status">Подключаемся к комнате…</p>
        <button className="button secondary" onClick={onBack}>
          Отмена
        </button>
      </main>
    );
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
                  ...audioCapture(preferences.audio, choices.microphone),
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
        // Зеркалим себя, а не камеру: у задней зеркала нет, там смотрят на мир.
        // `environment` — единственное, что его отменяет; молчание камеры значит «фронтальная».
        const facing = stream.current.getVideoTracks()[0]?.getSettings().facingMode;
        preview.current.style.transform = facing === 'environment' ? 'none' : 'scaleX(-1)';
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
                <Avatar name={name || 'Вы'} src={preferences.avatar || null} large />
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
                destination?.kind === 'telegram'
                  ? await servicesApi.redeemClaim(destination.token, name.trim(), commandId.current)
                  : destination?.kind === 'favorite'
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
                              integrationsAllowed,
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
            {/* Тот же случай, что и на главной: перенос прячется на узком экране. */}
            <br /> Подключиться можно и без устройств.
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
              <small className="form-footnote">Название можно будет поменять во встрече.</small>
              {/*
                Что это за встреча — решается здесь, а не за шестерёнкой предпросмотра.

                Оба вопроса стояли в окне «Перед разговором», между качеством камеры и запасом
                буфера: настройку устройств открывают не все и не всегда, а «кого пускать» —
                это про саму встречу, и спросить об этом надо до того, как она началась.
                Решения не окончательные: то и другое меняется в настройках встречи.
              */}
              <section className="audio-settings" aria-label="Кто может войти">
                <h3>
                  <DoorOpen size={19} /> Кто может войти
                </h3>
                <div role="radiogroup" aria-label="Кто может войти" className="network-modes">
                  <label className="check-setting">
                    <input
                      type="radio"
                      name="admission"
                      checked={!approvalRequired}
                      onChange={() => {
                        setApprovalRequired(false);
                        commandId.current = crypto.randomUUID();
                      }}
                    />
                    <span>
                      По ссылке и коду — сразу
                      <small>Кто открыл приглашение, тот и вошёл. Подходит для своих.</small>
                    </span>
                  </label>
                  <label className="check-setting">
                    <input
                      type="radio"
                      name="admission"
                      checked={approvalRequired}
                      onChange={() => {
                        setApprovalRequired(true);
                        commandId.current = crypto.randomUUID();
                      }}
                    />
                    <span>
                      Только с вашего подтверждения
                      <small>Каждый входящий ждёт, пока вы его впустите.</small>
                    </span>
                  </label>
                </div>
                <label className="check-setting">
                  <input
                    type="checkbox"
                    checked={integrationsAllowed}
                    onChange={(e) => {
                      setIntegrationsAllowed(e.target.checked);
                      commandId.current = crypto.randomUUID();
                    }}
                  />
                  <span>
                    Разрешить интеграции всем участникам
                    <small>Иначе кинозал и музыку добавляете и убираете только вы.</small>
                  </span>
                </label>
                <p className="form-footnote">Это можно поменять и потом, уже во встрече.</p>
              </section>
            </>
          )}
          <p className="permission-note" role="status">
            Камеру и микрофон можно включить здесь или во встрече. Разрешение потребуется при первом
            включении.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary full" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}{' '}
            {busy ? 'Подключаемся…' : destination ? 'Войти во встречу' : 'Начать встречу'}
          </button>
          <p className="form-footnote">Ссылка и QR для приглашения появятся в комнате.</p>
        </form>
      </main>
      <Modal
        wide
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
          <AudioFields
            audio={preferences.audio}
            change={(audio) => setPreferences(savePreferences({ audio }))}
          />
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
          <ReceptionFields
            mode={preferences.reception}
            change={(reception) => setPreferences(savePreferences({ reception }))}
          />
        </div>
      </Modal>
    </div>
  );
}
