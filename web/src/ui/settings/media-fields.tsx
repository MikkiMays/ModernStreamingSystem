import type { ChangeEvent } from 'react';
import type { AudioPreferences, Reception } from '../../core/preferences';
import { qualityLevels, qualityRules } from '../../media/capabilities';
import type { FrameRate, Resolution, ScreenProfile } from '../../media/profiles';
import type { NetworkMode } from '../../media/playout';
import { gradeName, pathName, type LinkState } from '../../media/link-quality';
import { Slider, Switch } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { row } from './sections';

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
  const levels = qualityLevels(qualityRules());
  const label = kind === 'screen' ? 'Экран' : 'Камера';
  return (
    <>
      <SettingRow id={kind === 'screen' ? 'screen-resolution' : 'camera-resolution'} stack>
        <select
          className="ui-input ui-select setting-select"
          aria-label={`${label}: качество`}
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
          aria-label={`${label}: частота кадров`}
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
export function ceilingNote() {
  const { ceiling } = qualityRules();
  return `Этот сервер допускает до ${ceiling.resolution}p · ${ceiling.fps} fps`;
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
  return (
    <SettingGroup
      title={kind === 'screen' ? 'Демонстрация экрана' : 'Видео с камеры'}
      collapsible={false}
      note={kind === 'screen' ? ceilingNote() : undefined}
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
  return (
    <SettingRow id="reception" stack>
      <select
        className="ui-input ui-select setting-select"
        aria-label="Качество приёма"
        value={mode}
        onChange={(e) => change(e.target.value as Reception)}
      >
        <option value="fit">По размеру окна</option>
        <option value="best">Всегда лучшее</option>
      </select>
    </SettingRow>
  );
}

export function ReceptionFields({ mode, change }: { mode: Reception; change: (mode: Reception) => void }) {
  return (
    <SettingGroup title="Чужое видео" collapsible={false}>
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
  const constraints = navigator.mediaDevices?.getSupportedConstraints() as Constraints | undefined;
  return (
    <SettingRow id="noise" stack>
      <select
        className="ui-input ui-select setting-select"
        aria-label={row('noise').label}
        value={audio.suppression}
        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
          change({ ...audio, suppression: e.target.value as AudioPreferences['suppression'] })
        }
      >
        <option value="browser">Стандартное</option>
        <option value="rnnoise" disabled={!('AudioWorkletNode' in window)}>
          RNNoise — усиленное
        </option>
        <option value="voice" disabled={!constraints?.voiceIsolation}>
          Изоляция голоса
        </option>
        <option value="off">Выключено</option>
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
  return (
    <SettingRow id="echo">
      <Switch
        checked={audio.echoCancellation}
        ariaLabel={row('echo').label}
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
  return (
    <SettingRow id="mic-auto">
      <Switch
        checked={audio.autoGainControl}
        ariaLabel={row('mic-auto').label}
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
          label="Громкость микрофона"
          onChange={(e) => change({ ...audio, gain: Number(e.target.value) / 100 })}
        />
        <SettingValue>{audio.autoGainControl ? 'Авто' : `${percent}%`}</SettingValue>
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
  return (
    <SettingGroup title="Голос и микрофон" collapsible={false}>
      <NoiseRow audio={audio} change={change} />
      <EchoRow audio={audio} change={change} />
      <AutoGainRow audio={audio} change={change} />
      <GainRow audio={audio} change={change} />
    </SettingGroup>
  );
}

const PLAYOUT: { value: NetworkMode; title: string }[] = [
  { value: 'auto', title: 'Автоматически' },
  { value: 'low-latency', title: 'Минимальная задержка' },
  { value: 'stable', title: 'Максимальная устойчивость' },
];

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
  const known = link && link.path !== 'unknown';
  return (
    <SettingRow
      id="playout"
      stack
      below={
        known ? (
          <p className="setting-note" role="status">
            Сейчас: {pathName(link.path)} · {gradeName(link.grade)}
            {link.rttMs !== null && ` · оборот ${Math.round(link.rttMs)} мс`}
            {link.ordered &&
              '. Через TCP запас поднят сам; если это повторяется, проверьте, пропускает ли сеть UDP.'}
          </p>
        ) : undefined
      }
    >
      <select
        className="ui-input ui-select setting-select"
        aria-label="Запас буфера приёма"
        value={mode}
        onChange={(e) => change(e.target.value as NetworkMode)}
      >
        {PLAYOUT.map((option) => (
          <option key={option.value} value={option.value}>
            {option.title}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
