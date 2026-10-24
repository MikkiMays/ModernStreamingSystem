import { useEffect, useId, useState, type ReactNode } from 'react';
import { AppWindow, Monitor, Settings2, Video } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  captureAudioModes,
  listCaptureSources,
  systemAudioAvailable,
  type CaptureAudio,
  type CaptureSources,
} from '../core/desktop-capture';
import { modeOf, type ScreenMode, type ScreenProfile } from '../media/profiles';
import { Button, Dialog, IconButton, Popover, Segmented, Switch, Tab, TabList, TabPanel, Tabs } from './kit';
import { QualityRows } from './settings/media-fields';
// Строки качества — те же, что в настройках «Видео» (R78), и выглядят так же: стили строк — оттуда.
import './settings/settings.css';
import './capture-picker.css';

/** Миниатюры окон меняются, пока окно выбора открыто: раз в четыре секунды — как живые, но без нагрузки. */
const REFRESH_MS = 4000;

/** Вкладки окна (R60, как у Discord): приложения (окна), весь экран, устройства захвата. */
type Kind = 'window' | 'screen' | 'device';

/** Устройство захвата: карта захвата, виртуальная камера — всё `videoinput`, кроме своей камеры. */
interface CaptureDevice {
  id: string;
  name: string;
  /** У устройства есть свой звуковой вход (тот же `groupId`). */
  sound: boolean;
}

export type CaptureChoice =
  | { kind: 'source'; id: string; audio: CaptureAudio; profile: ScreenProfile }
  | { kind: 'device'; deviceId: string; sound: boolean; profile: ScreenProfile };

/**
 * Окно показа в клиенте на Electron (R60, R80, R82 → n05; ADR 0001 §4.1) — единственное: окно
 * выбора оболочки удалено (WD2). Как у Discord и Телемоста: вкладки «Приложения · Весь экран ·
 * Устройства», сетка плиток с миниатюрой и подписью, выбранная — обводкой акцента; двойной щелчок —
 * сразу показать. Внизу слева — «Звук компьютера» (Телемост), по центру — сводка («Плавность · 1080p
 * · 60 fps»), справа — режим «Чёткость / Плавность» (R95), шестерёнка с качеством 720 / 1080 / 1440
 * и 30 / 60 (те же сегменты, что в настройках «Видео», R78 — нижняя граница, X10), превью зрителям
 * (R80) и режимом звука, и одна главная кнопка «Показать»; отмена — крестик окна.
 *
 * Выбор помнится (`preferences.screen`): следующий показ откроется с тем же режимом, качеством,
 * превью и звуком. «Не слышать свой показ» Discord здесь нет: свой показ Cord себе не проигрывает —
 * слышно только сам источник, и выключатель ничего бы не менял (X3).
 */
export function CapturePicker({
  open,
  onOpenChange,
  onChoose,
  initial,
  camera,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: CaptureChoice) => void;
  /** Что выбрано для показа сейчас (`preferences.screen`) — с этим окно и открывается. */
  initial: ScreenProfile;
  /** Своя камера (`preferences.devices.camera`): в «Устройствах» её нет — это не источник показа. */
  camera?: string;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<CaptureSources | null>(null);
  const [devices, setDevices] = useState<CaptureDevice[] | null>(null);
  const [kind, setKind] = useState<Kind>('screen');
  const [chosen, setChosen] = useState<string | null>(null);
  const [profile, setProfile] = useState(initial);
  /** Звук включён (выключатель слева) и какой — из запомненного; доступность — по выбору ниже. */
  const [sound, setSound] = useState(initial.audio !== undefined && initial.audio !== 'none');
  const [preferred, setPreferred] = useState<CaptureAudio>(initial.audio ?? 'none');
  const soundName = useId();

  // Окно открылось — с тем, что выбрано для показа сейчас. Пока оно открыто, `initial` не меняется:
  // настройки за модальным окном не открыть, а правки здесь — свои, пока не нажали «Показать».
  useEffect(() => {
    if (!open) return;
    setProfile(initial);
    setSound(initial.audio !== undefined && initial.audio !== 'none');
    setPreferred(initial.audio ?? 'none');
  }, [open, initial]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      const [next, inputs] = await Promise.all([listCaptureSources(), captureDevices(camera)]);
      busy = false;
      if (!alive) return;
      setFound(next);
      setDevices(inputs);
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      setFound(null);
      setDevices(null);
      setChosen(null);
    };
  }, [open, camera]);

  const sources = found?.sources ?? [];
  const device = devices?.find((item) => `device:${item.id}` === chosen) ?? null;
  // Закрытое за это время окно (или вынутая карта захвата) из выбора пропадает само.
  const selected = sources.some((source) => source.id === chosen) || device ? chosen : null;
  const selectedKind: Kind = device
    ? 'device'
    : (sources.find((source) => source.id === selected)?.kind ?? kind);

  /** Какой звук можно взять у выбранного (или у открытой вкладки, пока ничего не выбрано). */
  const soundModes = (which: Kind): CaptureAudio[] => {
    if (which === 'device' || !found) return [];
    const modes = captureAudioModes(which, found);
    if (modes) return modes.filter((mode) => mode !== 'none');
    return systemAudioAvailable() && found.systemAudio ? ['system'] : [];
  };
  /** Звук по выключателю: запомненный, если он здесь есть, иначе лучший для этого источника. */
  const audioFor = (which: Kind): CaptureAudio => {
    const modes = soundModes(which);
    if (!sound || !modes.length) return 'none';
    if (modes.includes(preferred)) return preferred;
    const best: CaptureAudio[] = which === 'window' ? ['app', 'system-except-cord'] : ['system-except-cord'];
    return best.find((mode) => modes.includes(mode)) ?? modes[0]!;
  };
  const modes = soundModes(selectedKind);
  const audio = audioFor(selectedKind);
  const deviceSoundOn = sound && !!device?.sound;

  const choose = (id: string | null) => {
    if (!id) return;
    const picked = devices?.find((item) => `device:${item.id}` === id);
    const next = { ...profile, audio: picked ? profile.audio : audio };
    if (picked) {
      onChoose({ kind: 'device', deviceId: picked.id, sound: sound && picked.sound, profile: next });
      return;
    }
    const which = sources.find((source) => source.id === id)?.kind ?? kind;
    const chosenAudio = audioFor(which);
    onChoose({ kind: 'source', id, audio: chosenAudio, profile: { ...profile, audio: chosenAudio } });
  };

  const mode = modeOf(profile);
  const modeLabel = t(($) => $.capture.modes[mode]);
  const summary = [
    modeLabel,
    `${profile.resolution}p`,
    mode === 'sharp'
      ? t(($) => $.capture.fpsUpTo, { fps: profile.fps })
      : t(($) => $.capture.fps, { fps: profile.fps }),
    audio !== 'none'
      ? t(($) => $.capture.audioModes[audio])
      : deviceSoundOn
        ? t(($) => $.capture.deviceSound)
        : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const empty = (text: string, icon?: ReactNode) => (
    <div className="capture-picker__empty" role="status">
      {icon}
      <p>{text}</p>
    </div>
  );

  const grid = (which: 'screen' | 'window') => {
    const shown = sources.filter((source) => source.kind === which);
    if (!found) return empty(t(($) => $.capture.loading));
    if (!shown.length)
      return empty(which === 'screen' ? t(($) => $.capture.noScreens) : t(($) => $.capture.noWindows));
    return (
      <div
        className="capture-picker__grid"
        data-kind={which}
        role="group"
        aria-label={t(($) => $.capture.sources)}
      >
        {shown.map((source) => (
          <button
            key={source.id}
            type="button"
            className="capture-tile"
            aria-pressed={selected === source.id}
            onClick={() => setChosen(source.id)}
            onDoubleClick={() => choose(source.id)}
          >
            <span className="capture-tile__thumb">
              {source.thumbnail ? (
                <img src={source.thumbnail} alt="" draggable={false} />
              ) : which === 'screen' ? (
                <Monitor size={28} aria-hidden="true" />
              ) : (
                <AppWindow size={28} aria-hidden="true" />
              )}
            </span>
            <span className="capture-tile__label">
              {source.icon && <img src={source.icon} alt="" width={16} height={16} draggable={false} />}
              <span>{source.name || t(($) => $.capture.untitled)}</span>
            </span>
          </button>
        ))}
      </div>
    );
  };

  const deviceGrid = () => {
    if (!devices) return empty(t(($) => $.capture.loading));
    if (!devices.length)
      return empty(
        t(($) => $.capture.noDevices),
        <Video size={32} aria-hidden="true" />,
      );
    return (
      <div
        className="capture-picker__grid"
        data-kind="device"
        role="group"
        aria-label={t(($) => $.capture.sources)}
      >
        {devices.map((item, index) => {
          const id = `device:${item.id}`;
          return (
            <button
              key={id}
              type="button"
              className="capture-tile"
              aria-pressed={selected === id}
              onClick={() => setChosen(id)}
              onDoubleClick={() => choose(id)}
            >
              <span className="capture-tile__thumb">
                <Video size={28} aria-hidden="true" />
              </span>
              <span className="capture-tile__label">
                <span>{item.name || t(($) => $.capture.device, { n: index + 1 })}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  // Звук слева: у окна и экрана — звук компьютера (если оболочка его умеет), у устройства — свой вход.
  const soundSwitch =
    selectedKind === 'device' ? (
      device?.sound ? (
        <Switch
          className="capture-picker__audio"
          checked={sound}
          onCheckedChange={setSound}
          label={t(($) => $.capture.deviceSound)}
        />
      ) : null
    ) : modes.length ? (
      <Switch
        className="capture-picker__audio"
        checked={sound}
        onCheckedChange={setSound}
        label={
          selectedKind === 'window' && audio === 'app'
            ? t(($) => $.capture.audioModes.app)
            : t(($) => $.capture.sound)
        }
        // Где человек может ошибиться — словами: «звук системы» уносит в показ и голоса встречи.
        description={
          audio === 'system' && modes.length === 1
            ? t(($) => $.capture.systemAudioHint)
            : audio === 'system' || audio === 'system-except-cord'
              ? t(($) => $.capture.audioHints[audio])
              : undefined
        }
      />
    ) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(($) => $.capture.title)}
      size="lg"
      className="capture-picker"
      footer={
        <>
          <div className="capture-picker__start">
            {soundSwitch}
            <p className="capture-picker__summary" aria-live="polite">
              {summary}
            </p>
          </div>
          <div className="capture-picker__end">
            <Segmented<ScreenMode>
              size="sm"
              aria-label={t(($) => $.capture.mode)}
              value={mode}
              onValueChange={(next) => setProfile({ ...profile, mode: next })}
              options={(['sharp', 'smooth'] as const).map((value) => ({
                value,
                label: t(($) => $.capture.modes[value]),
                title: t(($) => $.capture.modeHints[value]),
              }))}
            />
            <Popover
              side="top"
              align="end"
              mobile="popover"
              className="capture-picker__options"
              trigger={
                <IconButton label={t(($) => $.capture.options)}>
                  <Settings2 />
                </IconButton>
              }
            >
              <div className="capture-picker__rows">
                <QualityRows
                  kind="screen"
                  value={profile}
                  onChange={(next) => setProfile({ ...profile, ...next })}
                />
                <Switch
                  className="capture-picker__preview"
                  checked={profile.preview !== false}
                  onCheckedChange={(preview) => setProfile({ ...profile, preview })}
                  label={t(($) => $.capture.preview)}
                />
                {modes.length > 1 && (
                  <div
                    role="radiogroup"
                    aria-label={t(($) => $.capture.audio)}
                    className="capture-picker__modes"
                  >
                    <span className="capture-picker__modes-title">{t(($) => $.capture.audio)}</span>
                    {modes.map((value) => (
                      <label key={value} className="capture-picker__mode">
                        <input
                          type="radio"
                          name={soundName}
                          value={value}
                          checked={audio === value}
                          onChange={() => {
                            setPreferred(value);
                            setSound(true);
                          }}
                        />
                        <span>{t(($) => $.capture.audioModes[value])}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Popover>
            <Button variant="primary" disabled={!selected} onClick={() => choose(selected)}>
              {t(($) => $.capture.share)}
            </Button>
          </div>
        </>
      }
    >
      <Tabs value={kind} onValueChange={(value) => setKind(value as Kind)}>
        <TabList aria-label={t(($) => $.capture.kinds)}>
          <Tab value="window" icon={<AppWindow size={16} />}>
            {t(($) => $.capture.apps)}
          </Tab>
          <Tab value="screen" icon={<Monitor size={16} />}>
            {t(($) => $.capture.screens)}
          </Tab>
          <Tab value="device" icon={<Video size={16} />}>
            {t(($) => $.capture.devices)}
          </Tab>
        </TabList>
        <TabPanel value="window">{grid('window')}</TabPanel>
        <TabPanel value="screen">{grid('screen')}</TabPanel>
        <TabPanel value="device">{deviceGrid()}</TabPanel>
      </Tabs>
    </Dialog>
  );
}

/**
 * Устройства захвата для вкладки «Устройства»: все камеры, кроме своей (выбранной в настройках, а
 * без выбора — первой: её и берёт браузер по умолчанию). Без разрешения на камеру у устройств нет
 * имён — тогда они нумеруются.
 */
async function captureDevices(camera?: string): Promise<CaptureDevice[]> {
  const all = await navigator.mediaDevices?.enumerateDevices().catch(() => []);
  if (!all) return [];
  const cameras = all.filter((item) => item.kind === 'videoinput' && item.deviceId);
  const own = camera && cameras.some((item) => item.deviceId === camera) ? camera : cameras[0]?.deviceId;
  return cameras
    .filter((item) => item.deviceId !== own)
    .map((item) => ({
      id: item.deviceId,
      name: item.label,
      // Свой звуковой вход у карты захвата — в той же группе (`deviceCapture` берёт его же).
      sound:
        !!item.groupId && all.some((input) => input.kind === 'audioinput' && input.groupId === item.groupId),
    }));
}
