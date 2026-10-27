import { ArrowLeft, Mic, MicOff, Video, VideoOff, ArrowRight, LoaderCircle, Settings2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { prepareHuman, publicApi, RoomApi } from '../api/client';
import type { Admission } from '../api/types';
import type { DeviceChoice } from '../media/session';
import type { Destination } from './Home';
import { Avatar, Logo } from './primitives';
import { readPreferences, savePreferences } from '../core/preferences';
import { autoJoinEnabled, favoriteApi } from '../core/favorites';
import { servicesApi } from '../core/services';
import { AudioFields, QualityFields } from './Settings';
import { SettingGroup, SettingRow } from './settings/Row';
import { audioCapture } from '../media/audio';
import { alreadyInMeeting, type ElsewhereMeeting } from '../core/identity';
import { HelpButton } from './support/HelpButton';
import { MeetingElsewhere } from './MeetingElsewhere';
import { Button, Dialog, Field, IconButton, Input, Segmented, Switch } from './kit';
import { previewConstraints, touchFirst } from '../media/profiles';
import './prejoin.css';

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
  /** Отказ камеры или микрофона: строка под превью и «Помощь» с ответом на этот вопрос рядом. */
  const [deviceError, setDeviceError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Ядро не пустило: этот профиль уже во встрече `elsewhere` (T52). Человек выбирает в окне.
  const [elsewhere, setElsewhere] = useState<ElsewhereMeeting | null>(null);
  const [elsewhereNote, setElsewhereNote] = useState('');
  const [going, setGoing] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const accessId = useId();
  const preview = useRef<HTMLVideoElement>(null);
  const cameraUsed = useRef(false);
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
        <LoaderCircle className="spin" size={32} />
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
    setDeviceError(false);
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
    setDeviceError(false);
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
                  // Первое включение на телефоне — фронтальная, как и во встрече (`MediaSession.toggle`).
                  ...(touchFirst() && !cameraUsed.current
                    ? { facingMode: 'user' }
                    : { deviceId: choices.camera || undefined }),
                  // Под выбранное качество: превью показывает тот кадр, с которым камера войдёт во встречу.
                  ...previewConstraints(preferences.camera),
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
      if (kind === 'video') {
        setCamera(!enabled);
        cameraUsed.current = true;
      } else setMic(!enabled);
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
      setDeviceError(true);
    } finally {
      setDeviceBusy(false);
    }
  };
  return (
    <div className="prejoin-page">
      <header className="app-header">
        <Logo />
        <div className="app-header__end">
          <HelpButton faq="camera" />
          <Button variant="quiet" icon={<ArrowLeft size={20} />} onClick={onBack}>
            {t(($) => $.prejoin.home)}
          </Button>
        </div>
      </header>
      {/*
        Две колонки с одной верхней линии (R73, R76): превью слева, форма справа; узко — одна
        колонка, превью сверху. Размеры тянутся плавно от ширины и высоты окна (`prejoin.css`), а
        кнопка входа прилипает к низу окна, если форма всё же выше него.
      */}
      <main className="prejoin-main">
        <section className="prejoin-preview" aria-label={t(($) => $.prejoin.preview)}>
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
            {/* Метка, микрофон с камерой и шестерёнка — одной строкой по низу превью. */}
            <div className="preview-bar">
              <span className="preview-label">{t(($) => $.prejoin.you)}</span>
              <div className="preview-controls">
                <IconButton
                  tone="stage"
                  size="lg"
                  className="preview-toggle"
                  label={mic ? t(($) => $.prejoin.micOn) : t(($) => $.prejoin.micOff)}
                  pressed={mic}
                  disabled={deviceBusy}
                  onClick={() => void toggle('audio')}
                >
                  {mic ? <Mic /> : <MicOff />}
                </IconButton>
                <IconButton
                  tone="stage"
                  size="lg"
                  className="preview-toggle"
                  label={camera ? t(($) => $.prejoin.cameraOnLabel) : t(($) => $.prejoin.cameraOffLabel)}
                  pressed={camera}
                  disabled={deviceBusy}
                  onClick={() => void toggle('video')}
                >
                  {camera ? <Video /> : <VideoOff />}
                </IconButton>
              </div>
              <IconButton
                tone="stage"
                size="lg"
                label={t(($) => $.prejoin.settingsButton)}
                className="preview-settings"
                onClick={() => setSettings(true)}
              >
                <Settings2 />
              </IconButton>
            </div>
          </div>
          {/* Отказ камеры или микрофона — под превью и только после отказа (R74), с ответом рядом (T36). */}
          {deviceError && (
            <div className="prejoin-device-error" role="alert">
              <span>{t(($) => $.prejoin.deviceFailed)}</span>
              <HelpButton faq="camera" look="text" />
            </div>
          )}
        </section>
        <form
          className="prejoin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h1>
            {destination?.kind === 'favorite'
              ? destination.favorite.title
              : destination?.kind === 'recent'
                ? destination.admission.snapshot.title
                : t(($) => $.prejoin.ready)}
          </h1>
          <Field label={t(($) => $.prejoin.name)}>
            <Input
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
          </Field>
          {!destination && (
            <>
              <Field label={t(($) => $.prejoin.title)}>
                <Input
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
              </Field>
              {/*
                Что это за встреча — решается здесь, а не за шестерёнкой предпросмотра: «кого
                пускать» — про саму встречу, и спросить надо до того, как она началась. Оба решения
                меняются потом в настройках встречи — там же, сегментом и переключателем (R53, R55).
              */}
              <div className="prejoin-access" role="group" aria-labelledby={accessId}>
                <span className="prejoin-label" id={accessId}>
                  {t(($) => $.prejoin.access)}
                </span>
                <Segmented<'open' | 'approval'>
                  full
                  aria-labelledby={accessId}
                  value={approvalRequired ? 'approval' : 'open'}
                  onValueChange={(next) => {
                    setApprovalRequired(next === 'approval');
                    commandId.current = crypto.randomUUID();
                  }}
                  options={[
                    { value: 'open', label: t(($) => $.prejoin.open) },
                    { value: 'approval', label: t(($) => $.prejoin.approval) },
                  ]}
                />
              </div>
              {/* Да или нет — переключателем, а не галочкой (X4, R55). */}
              <Switch
                className="prejoin-switch"
                checked={integrationsAllowed}
                onCheckedChange={(checked) => {
                  setIntegrationsAllowed(checked);
                  commandId.current = crypto.randomUUID();
                }}
                label={t(($) => $.prejoin.integrations)}
              />
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="prejoin-submit">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              full
              loading={busy}
              disabled={!name.trim()}
              icon={<ArrowRight size={24} />}
            >
              {busy
                ? t(($) => $.prejoin.connecting)
                : destination
                  ? t(($) => $.prejoin.join)
                  : t(($) => $.prejoin.start)}
            </Button>
          </div>
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
      {/* «Перед разговором» (R72): окно набора; качество — сегментами 720 / 1080 / 1440 и 30 / 60 (R78). */}
      <Dialog
        size="lg"
        open={settings}
        onOpenChange={setSettings}
        title={t(($) => $.prejoin.settings.title)}
        className="prejoin-settings"
      >
        <div className="settings-form">
          <SettingGroup
            title={t(($) => $.prejoin.settings.devices)}
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
            value={preferences.camera}
            onChange={(p) => {
              setPreferences(savePreferences({ camera: p }));
              // Включённое превью меняет кадр и частоту на лету — тем же захватом, без перезапуска.
              for (const track of stream.current.getVideoTracks())
                void track.applyConstraints(previewConstraints(p)).catch(() => {});
            }}
          />
          <QualityFields
            kind="screen"
            value={preferences.screen}
            onChange={(p) => setPreferences(savePreferences({ screen: p }))}
          />
        </div>
      </Dialog>
    </div>
  );
}
