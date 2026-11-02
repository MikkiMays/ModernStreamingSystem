// Замер буфера кинозала (R172): сколько плеер держит вперёд и сзади и сколько байт скачано против
// просмотренного — у готового файла, HLS (hls.js) и DASH (dash.js) с настройками кинозала.
//
// Из web/:
//   1. Фильм: 6 мин, 3 Мбит/с, MP4 + HLS + DASH (ffmpeg из образа службы):
//        docker run --rm -v <каталог>:/m --entrypoint sh modern-streaming-services -c '
//          cd /m && ffmpeg -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine -t 360 -c:v libx264
//          -preset ultrafast -b:v 3M -minrate 3M -maxrate 3M -bufsize 1500k -x264-params nal-hrd=cbr -g 50
//          -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart film.mp4 && mkdir -p hls dash &&
//          ffmpeg -i film.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod -master_pl_name master.m3u8
//          -hls_segment_filename hls/seg%03d.ts hls/index.m3u8 &&
//          ffmpeg -i film.mp4 -c copy -f dash -seg_duration 4 dash/manifest.mpd'
//   2. npx vite build --config scripts/cinema-buffer/vite.config.mjs
//   3. MEDIA=<каталог> node scripts/cinema-buffer/server.mjs &   (Range, общий предел полосы, счёт байт)
//   4. node scripts/cinema-buffer/run.mjs
// Готовый файл через настоящий прокси службы: поднять маршруты кинозала с CINEMA_PRIVATE_HOSTS_LINK=127.0.0.1/32:18911,
// подписать адрес `http://127.0.0.1:18911/media/film.mp4` для «По ссылке» и передать его в FILE_SRC.
// Байты считает сервер замера — всё, что ушло в сокет, вместе с буферами по дороге, а не только то, что
// разобрал плеер (`video.buffered` у готового файла знает лишь разобранное).
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 18911);
const SIZE = Number(process.env.FILM_BYTES || 140970543);
const BPS = SIZE / 360;
const RATES = { roomy: 2_500_000, tight: 570_000 };
const scenarios = (process.env.SCENARIOS || 'file:roomy,hls:roomy,hls:tight,dash:roomy')
  .split(',')
  .map((s) => s.split(':'));
const PLAY = Number(process.env.PLAY || 90),
  AFTER = Number(process.env.AFTER || 20),
  PAUSE = Number(process.env.PAUSE || 30);
const ask = (path) => fetch(BASE + path, { headers: { connection: 'close' } });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
for (const [engine, net] of scenarios) {
  await ask('/reset?rate=0');
  const page = await browser.newPage();
  await page.goto(BASE + '/');
  await page.waitForFunction(() => typeof window.start === 'function');
  await ask(`/reset?rate=${RATES[net]}&chunk=${Number(process.env.CHUNK || 0)}`);
  await page.evaluate(([e, s]) => window.start(e, s), [engine, process.env.FILE_SRC || '']);
  const samples = [];
  const tick = async (phase) => {
    const s = await page.evaluate(() => window.sample());
    s.sent = (await (await ask('/stats')).json()).sent;
    s.phase = phase;
    samples.push(s);
  };
  for (const [phase, seconds, before] of [
    ['play', PLAY, null],
    ['seek', AFTER, () => page.evaluate(() => (window.video.currentTime = 200))],
    ['pause', PAUSE, () => page.evaluate(() => window.video.pause())],
  ]) {
    if (before) await before();
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      await tick(phase);
      await page.waitForTimeout(2000);
    }
  }
  await page.close();
  const play = samples.filter((s) => s.phase === 'play' && s.now > 20);
  const last = samples.filter((s) => s.phase === 'play').at(-1);
  const paused = samples.filter((s) => s.phase === 'pause');
  console.log(
    JSON.stringify({
      scenario: `${engine}/${net}`,
      watchedS: +last.now.toFixed(1),
      bufferedAheadMaxS: +Math.max(...play.map((s) => s.ahead)).toFixed(1),
      bufferedBehindMaxS: +Math.max(...samples.map((s) => s.behind)).toFixed(1),
      fetchedAheadMaxS: +Math.max(...play.map((s) => s.sent / BPS - s.now)).toFixed(1),
      fetchedPerWatched: +(last.sent / (last.now * BPS)).toFixed(2),
      fetchedWhilePausedMB: +((paused.at(-1).sent - paused[0].sent) / 1e6).toFixed(2),
    }),
  );
}
await browser.close();
