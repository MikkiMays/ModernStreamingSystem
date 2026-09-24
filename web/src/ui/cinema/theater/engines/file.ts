import type { Playback } from './playback';

/**
 * Адрес, который браузер играет сам: готовый файл — и HLS в Safari, который умеет его
 * по-настоящему.
 *
 * Движка здесь нет: адрес уходит прямо в `<video>`, и выбирать в нём нечего — ни ступеней, ни
 * озвучек. Об ошибке такого адреса сообщает сам `<video>`, и разбирает её тот, кто держит плеер
 * (`usePlayback`): у файла это единственное место, где о ней вообще становится известно.
 */
export function attachFile(video: HTMLVideoElement, url: string): Playback {
  video.src = url;
  return {
    levels: [],
    quality() {},
    voice: () => '',
    destroy() {},
  };
}
