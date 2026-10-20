import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Translate } from '../../i18n';
import type { AudioPreferences, Reception } from '../../core/preferences';
import { qualityLevels, qualityRules } from '../../media/capabilities';
import type { FrameRate, Resolution, ScreenProfile } from '../../media/profiles';
import type { NetworkMode } from '../../media/playout';
import { gradeName, pathName, type LinkState } from '../../media/link-quality';
import { Slider, Switch } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';

/**
 * Строки звука и видео, которые нужны в двух местах: в разделе «Голос и видео» окна настроек и в
 * «Перед разговором» на предпросмотре. Строки — здесь, а группы вокруг них собирает каждое место
 * своё: в окне настроек камера — это устройство, качество и превью вместе, на предпросмотре
 * устройства выбираются отдельно.
 */

const RESOLUTION_NAMES: Record<Resolution, string> = {
  720: '720p · HD',
  1080: '1080p · Full HD',
  1440: '1440p · QHD',
};

/** Разрешение и частота кадров отдачи — из того, что разрешает сервер (T44, П2: без «Авто»). */
export function QualityRows({
  kind,
  profile,
  change,
}: {
  kind: 'screen' | 'camera';
  profile: ScreenProfile;
  change: (next: ScreenProfile) => void;
}) {
  const { t } = useTranslation();
  const levels = qualityLevels(qualityRules());
  const label = t(($) => $.settings.media.kind[kind]);
  return (
    <>
      <SettingRow id={kind === 'screen' ? 'screen-resolution' : 'camera-resolution'} stack>
        <select
          className="ui-input ui-select setting-select"
          aria-label={t(($) => $.settings.media.quality, { label })}
          value={profile.resolution}
          onChange={(e) => change({ ...profile, resolution: Number(e.target.value) as Resolution })}
        >
          {levels.resolutions.map((resolution) => (
            <option key={resolution} value={resolution}>
              {RESOLUTION_NAMES[resolution]}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow id={kind === 'screen' ? 'screen-fps' : 'camera-fps'} stack>
        <select
          className="ui-input ui-select setting-select"
          aria-label={t(($) => $.settings.media.fps, { label })}
          value={profile.fps}
          onChange={(e) => change({ ...profile, fps: Number(e.target.value) as FrameRate })}
        >
          {levels.frameRates.map((fps) => (
            <option key={fps} value={fps}>
              {fps} fps
            </option>
          ))}
        </select>
      </SettingRow>
    </>
  );
}

/** Потолок сервера одной строкой — под заголовком группы показа. */
export function ceilingNote(t: Translate) {
  const { ceiling } = qualityRules();
  return t(($) => $.settings.media.ceiling, { resolution: ceiling.resolution, fps: ceiling.fps });
}

/** Группа «Видео с камеры» или «Демонстрация экрана» целиком — для предпросмотра. */
export function QualityFields({
  kind,
  profile,
  change,
}: {
  kind: 'screen' | 'camera';
  profile: ScreenProfile;
  change: (next: ScreenProfile) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingGroup
      title={t(($) => $.settings.media.group[kind])}
      collapsible={false}
      note={kind === 'screen' ? ceilingNote(t) : undefined}
    >
      <QualityRows kind={kind} profile={profile} change={change} />
    </SettingGroup>
  );
}

/**
 * Каким присылать чужое видео — отдельно от того, каким я отдаю своё: это два разных решения
 * (`Reception` в `core/preferences.ts`).
 */
export function ReceptionRow({ mode, change }: { mode: Reception; change: (mode: Reception) => void }) {
  const { t } = useTranslation();
  return (
    <SettingRow id="reception" stack>
      <select
        className="ui-input ui-select setting-select"
        aria-label={rowText(t, 'reception').label}
        value={mode}
        onChange={(e) => change(e.target.value as Reception)}
      >
        <option value="fit">{t(($) => $.settings.media.reception.fit)}</option>
        <option value="best">{t(($) => $.settings.media.reception.best)}</option>
      </select>
    </SettingRow>
  );
}

export function ReceptionFields({ mode, change }: { mode: Reception; change: (mode: Reception) => void }) {
  const { t } = useTranslation();
  return (
    <SettingGroup title={t(($) => $.settings.anchors.reception)} collapsible={false}>
      <ReceptionRow mode={mode} change={change} />
    </SettingGroup>
  );
}

type Constraints = MediaTrackSupportedConstraints & { voiceIsolation?: boolean };

export function NoiseRow({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  const constraints = navigator.mediaDevices?.getSupportedConstraints() as Constraints | undefined;
  return (
    <SettingRow id="noise" stack>
      <select
        className="ui-input ui-select setting-select"
        aria-label={rowText(t, 'noise').label}
        value={audio.suppression}
        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
          change({ ...audio, suppression: e.target.value as AudioPreferences['suppression'] })
        }
      >
        <option value="browser">{t(($) => $.settings.media.noise.browser)}</option>
        <option value="rnnoise" disabled={!('AudioWorkletNode' in window)}>
          {t(($) => $.settings.media.noise.rnnoise)}
        </option>
        <option value="voice" disabled={!constraints?.voiceIsolation}>
          {t(($) => $.settings.media.noise.voice)}
        </option>
        <option value="off">{t(($) => $.settings.media.noise.off)}</option>
      </select>
    </SettingRow>
  );
}

export function EchoRow({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingRow id="echo">
      <Switch
        checked={audio.echoCancellation}
        ariaLabel={rowText(t, 'echo').label}
        onCheckedChange={(echoCancellation) => change({ ...audio, echoCancellation })}
      />
    </SettingRow>
  );
}

export function AutoGainRow({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingRow id="mic-auto">
      <Switch
        checked={audio.autoGainControl}
        ariaLabel={rowText(t, 'mic-auto').label}
        onCheckedChange={(autoGainControl) => change({ ...audio, autoGainControl })}
      />
    </SettingRow>
  );
}

/**
 * Громкость микрофона. При автоматическом уровне громкостью владеет браузер, и ползунок, который
 * ничего не меняет, был бы враньём, — он виден, но выключен, а значение говорит «авто».
 */
export function GainRow({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  const percent = Math.round(audio.gain * 100);
  return (
    <SettingRow id="mic-volume" stack disabled={audio.autoGainControl}>
      <div className="setting-slider">
        <Slider
          min={0}
          max={200}
          step={1}
          disabled={audio.autoGainControl}
          value={percent}
          label={rowText(t, 'mic-volume').label}
          onChange={(e) => change({ ...audio, gain: Number(e.target.value) / 100 })}
        />
        <SettingValue>{audio.autoGainControl ? t(($) => $.settings.media.auto) : `${percent}%`}</SettingValue>
      </div>
    </SettingRow>
  );
}

/** Обработка микрофона одной группой — для предпросмотра. */
export function AudioFields({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  return (
    <SettingGroup title={t(($) => $.settings.media.voiceGroup)} collapsible={false}>
      <NoiseRow audio={audio} change={change} />
      <EchoRow audio={audio} change={change} />
      <AutoGainRow audio={audio} change={change} />
      <GainRow audio={audio} change={change} />
    </SettingGroup>
  );
}

const PLAYOUT: NetworkMode[] = ['auto', 'low-latency', 'stable'];

/**
 * Сколько звука держать про запас, прежде чем его услышат. На чёткость картинки не влияет —
 * только на то, как звук переживает скачки задержки; по умолчанию её не трогают, поэтому она в
 * свёрнутом «Дополнительно».
 */
export function PlayoutRow({
  mode,
  change,
  link,
}: {
  mode: NetworkMode;
  change: (mode: NetworkMode) => void;
  link?: LinkState;
}) {
  const { t } = useTranslation();
  const known = link && link.path !== 'unknown';
  return (
    <SettingRow
      id="playout"
      stack
      below={
        known ? (
          <p className="setting-note" role="status">
            {t(($) => $.settings.media.playout.now, {
              path: pathName(t, link.path),
              grade: gradeName(t, link.grade),
            })}
            {link.rttMs !== null && t(($) => $.settings.media.playout.rtt, { ms: Math.round(link.rttMs) })}
            {link.ordered && t(($) => $.settings.media.playout.tcp)}
          </p>
        ) : undefined
      }
    >
      <select
        className="ui-input ui-select setting-select"
        aria-label={rowText(t, 'playout').label}
        value={mode}
        onChange={(e) => change(e.target.value as NetworkMode)}
      >
        {PLAYOUT.map((option) => (
          <option key={option} value={option}>
            {t(($) => $.settings.media.playout.modes[option])}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
