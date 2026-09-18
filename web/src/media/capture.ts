import { captureCeiling, type ScreenProfile } from './profiles';

/** A Windows/WebView host can supply capture without changing room or UI state. */
export interface CaptureAdapter {
  supported(): boolean;
  capture(profile: ScreenProfile): Promise<MediaStream>;
}

/**
 * ЗАЧЕМ ЗДЕСЬ РАЗМЕР КАДРА. Раньше у `getDisplayMedia` спрашивалась только частота, а про
 * размер не говорилось ничего — и браузер брал его на своё усмотрение. На практике это
 * означало 1920×1080 и вопрос «почему показ идёт в 1080, если выбрано 1440»: выбор доезжал
 * до `applyConstraints` уже после захвата, а тот умеет только урезать то, что дали.
 *
 * Просить надо **потолок**, а не текущую ступень: в «Авто» уровень меняется по ходу показа,
 * и источник, захваченный под 1080p30, не дал бы подняться выше, сколько бы ни было канала.
 * Захват идёт по верхней границе, а сколько из него отдавать — решают ограничения дорожки,
 * которые накладываются сразу после.
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
  capture: (profile) => {
    const ceiling = captureCeiling(profile);
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: Math.round((ceiling.resolution * 16) / 9) },
        height: { ideal: ceiling.resolution },
        frameRate: { ideal: ceiling.fps, max: ceiling.fps },
      },
      // Незнакомое имя ограничения браузер просто игнорирует, поэтому просить можно всегда;
      // а понял он просьбу или нет — видно по `ownAudioRestrictable`.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      } as MediaTrackConstraints,
    });
  },
};
