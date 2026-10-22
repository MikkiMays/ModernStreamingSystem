import { useTranslation } from 'react-i18next';
import { isDesktop } from '../../core/desktop';
import type { AudioPreferences } from '../../core/preferences';
import { CHOICE_FRAME_RATES, qualityRules, RESOLUTIONS, type Level } from '../../media/capabilities';
import type { FrameRate, Resolution, ScreenProfile } from '../../media/profiles';
import { Segmented, Slider, Switch, type SegmentedOption } from '../kit';
import { SettingGroup, SettingRow, SettingValue } from './Row';
import { rowText } from './sections';
import { useLiveValue } from './live-value';

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
    <SettingGroup
      title={t(($) => $.settings.media.group[props.kind])}
      note={props.kind === 'screen' ? t(($) => $.settings.media.floorNote) : undefined}
    >
      <QualityRows {...props} />
    </SettingGroup>
  );
}

type Constraints = MediaTrackSupportedConstraints & { voiceIsolation?: boolean };

/**
 * Шумоподавление — сегментом (S4): «Выкл. / Стандартное / Усиленное», как у Discord. «Изоляция
 * голоса» — это Voice Focus Windows (только машины с NPU, исследование §2.4): пункт есть только в
 * клиенте для Windows и только если движок её объявил — или если она уже выбрана. В браузере и на
 * телефоне четвёртый пункт был бы шумом и не влезал бы в строку.
 */
export function NoiseRow({
  audio,
  change,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
}) {
  const { t } = useTranslation();
  const constraints = navigator.mediaDevices?.getSupportedConstraints?.() as Constraints | undefined;
  const isolation = (isDesktop() && !!constraints?.voiceIsolation) || audio.suppression === 'voice';
  const options: SegmentedOption<AudioPreferences['suppression']>[] = [
    { value: 'off', label: t(($) => $.settings.media.noise.off) },
    { value: 'browser', label: t(($) => $.settings.media.noise.browser) },
    {
      value: 'rnnoise',
      label: t(($) => $.settings.media.noise.rnnoise),
      disabled: !('AudioWorkletNode' in window),
    },
    ...(isolation ? [{ value: 'voice' as const, label: t(($) => $.settings.media.noise.voice) }] : []),
  ];
  return (
    <SettingRow id="noise" stack>
      <Segmented
        size="sm"
        aria-label={rowText(t, 'noise').label}
        value={audio.suppression}
        onValueChange={(suppression) => change({ ...audio, suppression })}
        options={options}
      />
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
  // Пишется, когда ползунок отпустили: во встрече это `applyConstraints` и пересборка обработки,
  // а в проверке — перезапуск захвата; себя во время перетаскивания человек всё равно не слышит (R14).
  const gain = useLiveValue(
    Math.round(audio.gain * 100),
    (percent) => change({ ...audio, gain: percent / 100 }),
    { live: false },
  );
  const percent = gain.value;
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
            onChange={(e) => gain.onChange(Number(e.target.value))}
            onValueCommitted={gain.onCommit}
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
