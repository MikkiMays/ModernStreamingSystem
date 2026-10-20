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
import { useTranslation } from 'react-i18next';
import { prepareHuman, publicApi, RoomApi } from '../api/client';
import type { Admission } from '../api/types';
import type { DeviceChoice } from '../media/session';
import type { Destination } from './Home';
import { Avatar, IconButton, Logo, Modal } from './primitives';
import { readPreferences, savePreferences } from '../core/preferences';
import { autoJoinEnabled, favoriteApi } from '../core/favorites';
import { servicesApi } from '../core/services';
import { AudioFields, QualityFields, ReceptionFields } from './Settings';
import { SettingGroup, SettingRow } from './settings/Row';
import { audioCapture } from '../media/audio';
import { alreadyInMeeting, type ElsewhereMeeting } from '../core/identity';
import { MeetingElsewhere } from './MeetingElsewhere';

export function Prejoin({
  destination,
  onBack,
  onJoin,
  onElsewhere,
}: {
  destination: Destination | null;
  onBack: () => void;
  onJoin: (admission: Admission, choices: DeviceChoice & { micOn: boolean; cameraOn: boolean }) => void;
  /**
   * «Перейти туда» (T52): открыть встречу, где этот профиль уже есть. `false` — из этой вкладки
   * туда дороги нет (встреча идёт в другой вкладке или окне).
   */
  onElsewhere?: (meeting: ElsewhereMeeting) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(localStorage.getItem('cord:name') ?? '');
  const [title, setTitle] = useState(() => t(($) => $.prejoin.defaultTitle));
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
  // Ядро не пустило: этот профиль уже во встрече `elsewhere` (T52). Человек выбирает в окне.
  const [elsewhere, setElsewhere] = useState<ElsewhereMeeting | null>(null);
  const [elsewhereNote, setElsewhereNote] = useState('');
  const [going, setGoing] = useState(false);
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
    // Задача «не бот» решается в фоне, пока человек смотрит в камеру и вводит имя (E11-B).
    if (!destination) prepareHuman('create');
    else if (destination.kind === 'code') prepareHuman('code');
  }, [destination]);
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
  /**
   * Вход туда, куда человек собрался. Одна дверь на форму и на автовход: `leave` — встреча, из
   * которой ядро выведет в том же шаге, когда человек выбрал «Выйти оттуда и войти сюда» (T52).
   * Ссылка организатора из Telegram идёт через службу, а та профиля устройства не передаёт —
   * правило одной встречи этот вход не касается.
   */
  const admit = (displayName: string, leave?: string) =>
    destination?.kind === 'telegram'
      ? servicesApi.redeemClaim(destination.token, displayName, commandId.current)
      : destination?.kind === 'favorite'
        ? favoriteApi.join(destination.favorite.roomId, displayName, commandId.current, leave)
        : destination?.kind === 'recent'
          ? new RoomApi(destination.admission).rejoin(displayName, commandId.current, leave)
          : destination?.kind === 'code'
            ? publicApi.joinCode(
                { commandId: commandId.current, code: destination.code, name: displayName },
                leave,
              )
            : destination?.kind === 'invite'
              ? publicApi.join(
                  destination.roomId,
                  { commandId: commandId.current, invite: destination.invite, name: displayName },
                  leave,
                )
              : publicApi.create(
                  {
                    commandId: commandId.current,
                    title: title.trim(),
                    name: displayName,
                    approvalRequired,
                    integrationsAllowed,
                  },
                  leave,
                );
  /** Отказ входа: «вы уже во встрече» — окно выбора, всё остальное — строка ошибки в форме. */
  const refused = (e: unknown) => {
    const other = alreadyInMeeting(e);
    setElsewhere(other);
    setElsewhereNote('');
    if (!other) setError((e as Error).message);
  };
  useEffect(() => {
    if (!autoJoining || automaticStarted.current || destination?.kind !== 'favorite') return;
    automaticStarted.current = true;
    const displayName = name.trim() || t(($) => $.prejoin.defaultName);
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
          refused(e);
          setAutoJoining(false);
        }
      });
  }, [autoJoining, destination, name, choices, onJoin, t]);
  if (autoJoining)
    return (
      <main className="loading-room">
        <LoaderCircle className="spin" size={30} />
        <p role="status">{t(($) => $.prejoin.autoJoining)}</p>
        <button className="button secondary" onClick={onBack}>
          {t(($) => $.prejoin.cancel)}
        </button>
      </main>
    );
  /** Войти; `leave` — после «Выйти оттуда и войти сюда». Имя из автовхода — то же запасное. */
  const submit = async (leave?: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const admission = await admit(name.trim() || t(($) => $.prejoin.defaultName), leave);
      if (destination?.kind === 'recent') admission.inviteUrl = destination.admission.inviteUrl;
      localStorage.setItem('cord:name', name.trim());
      savePreferences({ devices: choices });
      stream.current.getTracks().forEach((t) => t.stop());
      setElsewhere(null);
      onJoin(admission, { ...choices, micOn: mic, cameraOn: camera });
    } catch (e) {
      refused(e);
    } finally {
      setBusy(false);
    }
  };
  /**
   * «Перейти туда»: в ту встречу — из соседней вкладки, прежнего входа или избранного (`App`). Нет
   * дороги — в этом браузере встреча не открыта: место держит закрытая вкладка или другое окно
   * без связи с этой страницей, и остаётся второй выбор — выйти оттуда и войти сюда.
   */
  const goElsewhere = async () => {
    if (!elsewhere) return;
    setGoing(true);
    try {
      if (!(await onElsewhere?.(elsewhere)) && mounted.current)
        setElsewhereNote(t(($) => $.prejoin.elsewhereUnreachable));
    } catch (e) {
      if (mounted.current) setElsewhereNote((e as Error).message);
    } finally {
      if (mounted.current) setGoing(false);
    }
  };
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
      setError(t(($) => $.prejoin.deviceFailed));
    } finally {
      setDeviceBusy(false);
    }
  };
  return (
    <div className="prejoin-page">
      <header className="app-header">
        <Logo />
        <button className="button ghost" onClick={onBack}>
          <ArrowLeft size={18} /> {t(($) => $.prejoin.home)}
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
              aria-label={t(($) => $.prejoin.preview)}
            />
            {!camera && (
              <div className="preview-avatar">
                <Avatar name={name || t(($) => $.prejoin.you)} src={preferences.avatar || null} large />
                <p>{t(($) => $.prejoin.cameraOff)}</p>
              </div>
            )}
            <span className="preview-label">{t(($) => $.prejoin.previewLabel)}</span>
            <div className="preview-controls">
              <IconButton
                label={mic ? t(($) => $.prejoin.micOn) : t(($) => $.prejoin.micOff)}
                className={mic ? 'active' : ''}
                disabled={deviceBusy}
                onClick={() => void toggle('audio')}
              >
                {mic ? <Mic /> : <MicOff />}
              </IconButton>
              <IconButton
                label={camera ? t(($) => $.prejoin.cameraOnLabel) : t(($) => $.prejoin.cameraOffLabel)}
                className={camera ? 'active' : ''}
                disabled={deviceBusy}
                onClick={() => void toggle('video')}
              >
                {camera ? <Video /> : <VideoOff />}
              </IconButton>
            </div>
            <IconButton
              label={t(($) => $.prejoin.settingsButton)}
              className="preview-settings"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={21} />
            </IconButton>
          </div>
          <p className="preview-caption">
            <Headphones size={17} /> {t(($) => $.prejoin.headphones)}
          </p>
        </div>
        <form
          className="prejoin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <span className="eyebrow">
            {destination ? t(($) => $.prejoin.eyebrowJoin) : t(($) => $.prejoin.eyebrowNew)}
          </span>
          <h1>
            {destination?.kind === 'favorite'
              ? destination.favorite.title
              : destination?.kind === 'recent'
                ? destination.admission.snapshot.title
                : t(($) => $.prejoin.ready)}
          </h1>
          <p className="muted">
            {t(($) => $.prejoin.check)}
            {/* Тот же случай, что и на главной: перенос прячется на узком экране. */}
            <br /> {t(($) => $.prejoin.noDevices)}
          </p>
          <label htmlFor="display-name">{t(($) => $.prejoin.name)}</label>
          <input
            id="display-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              localStorage.setItem('cord:name', e.target.value.trim());
              commandId.current = crypto.randomUUID();
            }}
            maxLength={40}
            placeholder={t(($) => $.prejoin.namePlaceholder)}
            required
            autoFocus
            autoComplete="nickname"
          />
          {!destination && (
            <>
              <label htmlFor="meeting-name">{t(($) => $.prejoin.title)}</label>
              <input
                id="meeting-name"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  commandId.current = crypto.randomUUID();
                }}
                maxLength={80}
                required
                placeholder={t(($) => $.prejoin.titlePlaceholder)}
              />
              <small className="form-footnote">{t(($) => $.prejoin.titleLater)}</small>
              {/*
                Что это за встреча — решается здесь, а не за шестерёнкой предпросмотра.

                Оба вопроса стояли в окне «Перед разговором», между качеством камеры и запасом
                буфера: настройку устройств открывают не все и не всегда, а «кого пускать» —
                это про саму встречу, и спросить об этом надо до того, как она началась.
                Решения не окончательные: то и другое меняется в настройках встречи.
              */}
              <section className="audio-settings" aria-label={t(($) => $.prejoin.access)}>
                <h3>
                  <DoorOpen size={19} /> {t(($) => $.prejoin.access)}
                </h3>
                <div role="radiogroup" aria-label={t(($) => $.prejoin.access)} className="network-modes">
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
                      {t(($) => $.prejoin.open)}
                      <small>{t(($) => $.prejoin.openHint)}</small>
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
                      {t(($) => $.prejoin.approval)}
                      <small>{t(($) => $.prejoin.approvalHint)}</small>
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
                    {t(($) => $.prejoin.integrations)}
                    <small>{t(($) => $.prejoin.integrationsHint)}</small>
                  </span>
                </label>
                <p className="form-footnote">{t(($) => $.prejoin.changeLater)}</p>
              </section>
            </>
          )}
          <p className="permission-note" role="status">
            {t(($) => $.prejoin.permissionNote)}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary full" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}{' '}
            {busy
              ? t(($) => $.prejoin.connecting)
              : destination
                ? t(($) => $.prejoin.join)
                : t(($) => $.prejoin.start)}
          </button>
          <p className="form-footnote">{t(($) => $.prejoin.inviteLater)}</p>
        </form>
      </main>
      <MeetingElsewhere
        meeting={elsewhere}
        busy={busy ? 'move' : going ? 'go' : undefined}
        note={elsewhereNote}
        onGo={() => void goElsewhere()}
        onMove={() => elsewhere && void submit(elsewhere.roomId)}
        onClose={() => setElsewhere(null)}
      />
      <Modal
        wide
        open={settings}
        onOpenChange={setSettings}
        title={t(($) => $.prejoin.settings.title)}
        description={t(($) => $.prejoin.settings.description)}
      >
        <div className="settings-form">
          <SettingGroup
            title={t(($) => $.prejoin.settings.devices)}
            collapsible={false}
            note={camera || mic ? t(($) => $.prejoin.settings.devicesBusy) : undefined}
          >
            {(['audioinput', 'videoinput', 'audiooutput'] as const).map((kind) => {
              const key = kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker';
              const label = t(($) => $.prejoin.settings.kinds[kind]);
              return (
                <SettingRow
                  key={kind}
                  id={
                    kind === 'audioinput'
                      ? 'mic-device'
                      : kind === 'videoinput'
                        ? 'camera-device'
                        : 'output-device'
                  }
                  label={label}
                  stack
                >
                  <select
                    className="ui-input ui-select setting-select"
                    aria-label={label}
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
                    <option value="">{t(($) => $.prejoin.settings.default)}</option>
                    {devices
                      .filter((d) => d.kind === kind && d.deviceId)
                      .map((d, i) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || t(($) => $.prejoin.settings.numbered, { n: i + 1 })}
                        </option>
                      ))}
                  </select>
                </SettingRow>
              );
            })}
          </SettingGroup>
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
