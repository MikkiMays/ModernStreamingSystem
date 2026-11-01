// Стенд замера буфера кинозала (R172): настоящие движки плеера на одном <video> — `npm run`-а нет, см. run.mjs.
import { attachDash } from '../../src/ui/cinema/theater/engines/dash';
import { attachHls } from '../../src/ui/cinema/theater/engines/hls';

const video = document.getElementById('v') as HTMLVideoElement;
video.muted = true;
const noop = () => {};
const hlsCallbacks = {
  alive: () => true,
  levels: noop,
  automatic: noop,
  voices: noop,
  wanted: () => 0,
  voice: noop,
  texts: noop,
  expired: () => false,
  fail: (message: string) => console.error('fail', message),
};
const dashCallbacks = {
  alive: () => true,
  levels: noop,
  voices: noop,
  error: () => console.error('dash error'),
};

/** Готовый файл — по адресу `src` (прокси службы) или прямо с сервера замера. */
async function start(engine: string, src?: string) {
  if (engine === 'file') video.src = src || '/media/film.mp4';
  else if (engine === 'hls') attachHls(video, '/media/hls/master.m3u8', '', hlsCallbacks);
  else await attachDash(video, '/media/dash/manifest.mpd', '', dashCallbacks);
  await video.play();
}

/** Где плеер сейчас и сколько у него разобрано вперёд и назад. */
function sample() {
  const now = video.currentTime;
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < video.buffered.length; i++) {
    const start = video.buffered.start(i);
    const end = video.buffered.end(i);
    if (start <= now + 0.5 && end >= now) {
      ahead = end - now;
      behind = now - start;
    }
  }
  return { now, ahead, behind };
}

Object.assign(window, { start, sample, video });
