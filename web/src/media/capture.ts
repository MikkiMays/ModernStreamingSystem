import { captureConstraints, type ScreenProfile } from './profiles';

/** A Windows/WebView host can supply capture without changing room or UI state. */
export interface CaptureAdapter {
  supported(): boolean;
  capture(profile: ScreenProfile): Promise<MediaStream>;
}

/**
 * Звук показа, который приходит не из `getDisplayMedia`, а отдельно и позже (E01-B3): звук
 * приложения и «система кроме Cord» в клиенте на Electron. `ready` — живая дорожка; `failed` —
 * готовая подсказка для человека (показ идёт без звука); `ended` — дорожки больше нет.
 */
export type ScreenAudioEvent =
  { state: 'ready'; track: MediaStreamTrack } | { state: 'failed'; message: string } | { state: 'ended' };

export interface ScreenAudioSource {
  /** Подписаться — до `getDisplayMedia`, чтобы не пропустить отказ; вернуть отписку. */
  watch(listener: (event: ScreenAudioEvent) => void): () => void;
}

/**
 * ЗАЧЕМ ЗДЕСЬ РАЗМЕР КАДРА. Раньше у `getDisplayMedia` спрашивалась только частота, а про
 * размер не говорилось ничего — и браузер брал его на своё усмотрение. На практике это
 * означало 1920×1080 и вопрос «почему показ идёт в 1080, если выбрано 1440»: выбор доезжал
 * до `applyConstraints` уже после захвата, а тот умеет только урезать то, что дали.
 *
 * Просится выбранный уровень: лестницы «Авто», ради которой захват когда-то шёл по верху
 * лестницы (1440p60), больше нет — выбранное публикуется сразу (T44). Сколько из захвата
 * отдавать, решают ограничения дорожки, которые накладываются сразу после.
 *
 * `ideal`, а не `exact`: экран меньше запрошенного не растянуть, и требовать этого нельзя —
 * `exact` здесь означал бы отказ захватывать вовсе.
 */
/**
 * Умеет ли браузер не отдавать нам наш собственный звук.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. «Весь экран со звуком системы» — это цифровая копия того, что
 * играет машина, **включая сам Cord**. Значит, в трансляцию вместе с фильмом уходит и
 * разговор: зритель слышит комнату вторым слоем и собственный голос с задержкой. Наушники
 * тут не спасают — копия снимается не с воздуха, а с того, что уходит в звуковую карту.
 *
 * `restrictOwnAudio` — единственный способ это разорвать: браузер вычитает из системного
 * звука то, что произвела сама захватывающая вкладка. Своими силами такого не сделать:
 * вычесть уже смешанное можно только эхоподавителем, а он выгрыз бы вместе с разговором и
 * фильм — тот играет через те же динамики.
 *
 * Спрашивать надо у самой дорожки, а не у `getSupportedConstraints`: имя ограничения
 * браузер знает раньше, чем умеет его выполнять на этой платформе, — проверено, там
 * `restrictOwnAudio: true` в списке поддерживаемых и `false` в настройках выданной дорожки.
 *
 * @returns правда, если в трансляцию уйдёт и звук самого Cord.
 */
export function ownAudioLeaks(video?: MediaStreamTrack, audio?: MediaStreamTrack): boolean {
  // Звук вкладки или окна — не системный: чужой программы в нём нет, и Cord тоже.
  if (!audio || video?.getSettings().displaySurface !== 'monitor') return false;
  const settings = audio.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean };
  return settings.restrictOwnAudio !== true;
}

export const browserCapture: CaptureAdapter = {
  supported: () => typeof navigator.mediaDevices?.getDisplayMedia === 'function',
  capture: (profile) =>
    navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(profile),
      // Незнакомое имя ограничения браузер просто игнорирует, поэтому просить можно всегда;
      // а понял он просьбу или нет — видно по `ownAudioRestrictable`.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      } as MediaTrackConstraints,
    }),
};

/**
 * Устройство захвата — карта захвата приставки, виртуальная камера OBS (вкладка «Устройства» окна
 * показа, R60). Публикуется как показ экрана, а не как камера: с теми же уровнем, режимом и
 * превью, что выбраны в окне. Звук — микрофонный вход того же устройства (тот же `groupId`, так
 * карта захвата отдаёт звук приставки), если он есть и его попросили; без обработки голоса —
 * это не речь.
 */
export async function deviceCapture(
  deviceId: string,
  profile: Pick<ScreenProfile, 'resolution' | 'fps'>,
  withSound: boolean,
): Promise<MediaStream> {
  const sound = withSound ? await deviceSound(deviceId) : null;
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...captureConstraints(profile) },
    audio: sound
      ? {
          deviceId: { exact: sound },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
  });
}

/** Звуковой вход того же устройства захвата (`groupId`); нет — `null`. */
export async function deviceSound(deviceId: string): Promise<string | null> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const video = devices.find((device) => device.kind === 'videoinput' && device.deviceId === deviceId);
  if (!video?.groupId) return null;
  return (
    devices.find(
      (device) => device.kind === 'audioinput' && device.groupId === video.groupId && device.deviceId,
    )?.deviceId ?? null
  );
}
