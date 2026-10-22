import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { AudioPreferences } from '../../core/preferences';
import { CHOICE_FRAME_RATES, qualityRules, RESOLUTIONS, type Level } from '../../media/capabilities';
import type { FrameRate, Resolution, ScreenProfile } from '../../media/profiles';
import { Segmented, Slider, Switch } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';

/**
 * Строки звука и видео, которые нужны в двух местах: в разделе «Голос и видео» окна настроек и в
 * «Перед разговором» на предпросмотре. Строки — здесь, а группы вокруг них собирает каждое место
 * своё: в окне настроек камера — это устройство, качество и превью вместе, на предпросмотре
 * устройства выбираются отдельно.
 */

/**
 * Разрешение и частота кадров отдачи (R78): сегменты 720 / 1080 / 1440 и 30 / 60 — как SD / HD у
 * Discord, одинаково для камеры и показа, без «Авто». Что выше потолка сервера — недоступно, и
 * причина — в подсказке пункта, а не строкой под группой.
 */
export function QualityRows({
  kind,
  value,
  onChange,
  ceiling = qualityRules().ceiling,
}: {
  kind: 'screen' | 'camera';
  value: ScreenProfile;
  onChange: (next: ScreenProfile) => void;
  /** Потолок сервера; по умолчанию — из запомненных правил (`capabilities.quality`). */
  ceiling?: Level;
}) {
  const { t } = useTranslation();
  const label = t(($) => $.settings.media.kind[kind]);
  const reason = t(($) => $.settings.media.ceiling, { resolution: ceiling.resolution, fps: ceiling.fps });
  const above = (over: boolean) => (over ? { disabled: true, title: reason } : {});
  return (
    <>
      <SettingRow id={kind === 'screen' ? 'screen-resolution' : 'camera-resolution'}>
        <Segmented<Resolution>
          size="sm"
          aria-label={t(($) => $.settings.media.quality, { label })}
          value={value.resolution}
          onValueChange={(resolution) => onChange({ ...value, resolution })}
          options={RESOLUTIONS.map((resolution) => ({
            value: resolution,
            label: `${resolution}p`,
            ...above(resolution > ceiling.resolution),
          }))}
        />
      </SettingRow>
      <SettingRow id={kind === 'screen' ? 'screen-fps' : 'camera-fps'}>
        <Segmented<FrameRate>
          size="sm"
          aria-label={t(($) => $.settings.media.fps, { label })}
          value={value.fps}
          onValueChange={(fps) => onChange({ ...value, fps })}
          options={CHOICE_FRAME_RATES.map((fps) => ({
            value: fps,
            label: String(fps),
            ariaLabel: `${fps} fps`,
            ...above(fps > ceiling.fps),
          }))}
        />
      </SettingRow>
    </>
  );
}

/**
 * Качество камеры или показа одной группой — для предпросмотра и окна показа (W7). Пропы — те же,
 * что у `QualityRows`: значение, правка и потолок сервера.
 */
export function QualityFields(props: Parameters<typeof QualityRows>[0]) {
  const { t } = useTranslation();
  return (
    <SettingGroup title={t(($) => $.settings.media.group[props.kind])}>
      <QualityRows {...props} />
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
      {/* Имя ползунка — видимая подпись строки (`aria-labelledby`): так и диктор, и axe знают, что
          бледная подпись принадлежит выключенному управлению, а не просто текст без контраста. */}
      {(a11y) => (
        <div className="setting-slider">
          <Slider
            {...a11y}
            min={0}
            max={200}
            step={1}
            disabled={audio.autoGainControl}
            value={percent}
            onChange={(e) => change({ ...audio, gain: Number(e.target.value) / 100 })}
          />
          <SettingValue>
            {audio.autoGainControl ? t(($) => $.settings.media.auto) : `${percent}%`}
          </SettingValue>
        </div>
      )}
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
    <SettingGroup title={t(($) => $.settings.media.voiceGroup)}>
      <NoiseRow audio={audio} change={change} />
      <EchoRow audio={audio} change={change} />
      <AutoGainRow audio={audio} change={change} />
      <GainRow audio={audio} change={change} />
    </SettingGroup>
  );
}
