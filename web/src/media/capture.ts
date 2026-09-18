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
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  },
};
