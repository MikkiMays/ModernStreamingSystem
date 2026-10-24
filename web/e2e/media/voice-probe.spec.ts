/**
 * Живой замер речи на плохом канале (R107): «звук говорящего будто обрезается».
 *
 * Говорящий — браузер с «речью» из файла (`gen-voice.mjs`), слушатель — второй браузер, при
 * желании в своём сетевом пространстве имён с netem (`netns.sh`, `listener-server.mjs`). У обоих
 * снимается огибающая звука: у говорящего — то, что уходит в отправитель, у слушателя — то, что
 * уходит в динамик (выход WebAudio) и что пришло дорожкой до WebAudio. Сравнение огибающих
 * показывает обрывы так, как их слышит человек, а getStats слушателя — почему (заглушка NetEq,
 * потери, запас буфера).
 *
 * Включается `CORD_MEDIA_PROBE=1`; нужен стенд с SFU. Переменные:
 *   VOICE_WAV           — файл речи (`node e2e/media/gen-voice.mjs /tmp/voice.wav`), обязателен;
 *   CORD_LISTENER_WS    — ws-адрес браузера-слушателя в netns (иначе слушатель — здесь же, без потерь);
 *   PROBE_INVITE        — войти обоим по приглашению во встречу «якоря» (`anchor.mjs`);
 *   PROBE_MS / WARM_MS  — длина замера и разогрева (по умолчанию 120 с и 15 с);
 *   PROBE_CAMERA=1      — говорящий ещё и с камерой (канал делят видео и речь);
 *   PROBE_NO_PLAYOUT=1  — у слушателя без нашего jitterBufferTarget (NetEq сам);
 *   PROBE_FIXED_TARGET  — у слушателя постоянный jitterBufferTarget, мс (сколько запаса на самом деле нужно);
 *   PROBE_NO_DTX=1      — у говорящего без DTX (usedtx снят из SDP);
 *   PROBE_NO_RED=1      — говорящий публикует только Opus (RED вниз тогда кодирует SFU);
 *   PROBE_SPEAKER_ARGS  — ключи Chromium говорящего (например, полевой опыт RED с двумя повторами);
 *   PROBE_SPEAKER_WAV   — свой файл «микрофона» говорящего (R113: `gen-voice.mjs … --left-only`);
 *   PROBE_SUPPRESSION   — шумоподавление говорящего: off | browser | rnnoise | voice;
 *   PROBE_STALL_CMD     — команда в середине окна (PROBE_STALL_AT, мс): «канал замер и отпустил»;
 *   PROBE_WEB_DIST=dir  — страница из локальной сборки (`npx vite build --outDir …`), ядро/SFU — стенда
 *                         (слушателю в netns — CORD_EXTRA_ARGS с тем же ключом LNA, см. listener-server.mjs);
 *   PROBE_ASSERT=0      — только записать, без порогов;
 *   OUT                 — каталог итогов (по умолчанию /tmp/voice-probe), имя — PROBE_LABEL.
 *
 * Пороги (R107): заглушка речи ≤ 1 %, ни одного слышимого обрыва длиннее 60 мс, запас буфера
 * приёма ≤ 250 мс, фразы не короче отправленных больше чем на 60 мс (не срезаны края слов);
 * речь у слушателя в обоих ушах — правый канал не тише левого больше чем на 3 дБ (R113).
 */
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { heardSummary, latency, phrases, statsSummary } from './voice-analysis.mjs';

const VOICE = process.env.VOICE_WAV ?? '';
// Своя «гарнитура» говорящего (R113: стерео с пустым правым каналом) и его шумоподавление.
const SPEAKER_WAV = process.env.PROBE_SPEAKER_WAV ?? '';
const SUPPRESSION = process.env.PROBE_SUPPRESSION ?? '';
const LISTENER_WS = process.env.CORD_LISTENER_WS ?? '';
const PROBE_MS = Number(process.env.PROBE_MS ?? 120000);
const WARM_MS = Number(process.env.WARM_MS ?? 15000);
const OUT = process.env.OUT ?? '/tmp/voice-probe';
const LABEL = process.env.PROBE_LABEL ?? 'run';
const DIST = process.env.PROBE_WEB_DIST ?? '';
// Страница, отданная `route.fulfill`, для Chromium — «публичная», а стенд — адрес этой же машины:
// проверка доступа к локальной сети (LNA) рвёт сокеты ядра и SFU. Только для тестового браузера.
const LOCAL_PAGE =
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights';
const ASSERT = process.env.PROBE_ASSERT !== '0';
const INVITE = process.env.PROBE_INVITE ?? '';
const STALL_CMD = process.env.PROBE_STALL_CMD ?? '';
const STALL_AT = Number(process.env.PROBE_STALL_AT ?? 30000);

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1, VOICE_WAV=…');
test.setTimeout(PROBE_MS + WARM_MS + 4 * 60_000);

/** Перехват соединений и огибающие звука. Выполняется до кода страницы. */
const probe = (flags: { noPlayout: boolean; noDtx: boolean; fixedTarget: number; noRed?: boolean }) => {
  const w = window as any;
  if (!window.RTCPeerConnection) return;
  w.__pcs = [];
  w.__taps = {};
  w.__outContexts = [];
  const Native = window.RTCPeerConnection;
  class Wrapped extends Native {
    constructor(...a: any[]) {
      super(...(a as []));
      w.__pcs.push(this);
      this.addEventListener('track', (event: RTCTrackEvent) => {
        if (event.track.kind === 'audio') void tapTrack('recv', event.track);
      });
    }
  }
  window.RTCPeerConnection = Wrapped as any;

  if (flags.noDtx) {
    const strip = (d?: RTCSessionDescriptionInit | null) =>
      d && d.sdp ? { type: d.type, sdp: d.sdp.replace(/;usedtx=1/g, '').replace(/usedtx=1;?/g, '') } : d;
    const setRemote = Native.prototype.setRemoteDescription;
    Native.prototype.setRemoteDescription = function (d?: any, ...rest: any[]) {
      return (setRemote as any).call(this, strip(d), ...rest);
    } as any;
    const setLocal = Native.prototype.setLocalDescription;
    Native.prototype.setLocalDescription = function (d?: any, ...rest: any[]) {
      return (setLocal as any).call(this, d ? strip(d) : d, ...rest);
    } as any;
  }
  if (flags.noRed) {
    // Издатель без RED (только Opus): тогда RED вниз кодирует сам SFU (`audio.active_red_encoding`).
    const stripRed = (sdp: string) =>
      sdp
        .split('m=')
        .map((section) => {
          const pt = section.startsWith('audio')
            ? section.match(/a=rtpmap:(\d+) red\/48000\/2/i)?.[1]
            : undefined;
          if (!pt) return section;
          const lines = section.split('\r\n');
          lines[0] = lines[0]!
            .split(' ')
            .filter((v, i) => i < 3 || v !== pt)
            .join(' ');
          return lines.filter((l) => !new RegExp(`^a=(rtpmap|fmtp|rtcp-fb):${pt}[ :]`).test(l)).join('\r\n');
        })
        .join('m=');
    const createOffer = Native.prototype.createOffer;
    Native.prototype.createOffer = async function (this: RTCPeerConnection, ...a: any[]) {
      const offer = await (createOffer as any).apply(this, a);
      return { type: offer.type, sdp: stripRed(offer.sdp ?? '') };
    } as any;
  }
  if (flags.noPlayout || flags.fixedTarget) {
    // NetEq сам (или постоянный запас): приложение думает, что просит, но приёмник получает своё.
    const native = Object.getOwnPropertyDescriptor(RTCRtpReceiver.prototype, 'jitterBufferTarget');
    Object.defineProperty(RTCRtpReceiver.prototype, 'jitterBufferTarget', {
      configurable: true,
      get(this: RTCRtpReceiver) {
        return native?.get?.call(this) ?? null;
      },
      set(this: RTCRtpReceiver) {
        if (flags.fixedTarget && this.track?.kind === 'audio') native?.set?.call(this, flags.fixedTarget);
      },
    });
  }

  // Огибающая: RMS по 384 отсчёта (8 мс при 48 кГц), метка — стенные часы начала блока.
  // Правый канал считается отдельно (R113): «слышно только в левом ухе» видно как R ≪ L.
  const code = `class Tap extends AudioWorkletProcessor {
    constructor(){super();this.e=0;this.er=0;this.n=0;this.first=0;this.out=[];this.right=[];}
    process(inputs){const ch=inputs[0]&&inputs[0][0];const r=inputs[0]&&inputs[0][1];
      if(this.n===0&&this.out.length===0)this.first=currentFrame;
      for(let i=0;i<128;i++){const v=ch?ch[i]:0;this.e+=v*v;const w=r?r[i]:v;this.er+=w*w;}
      this.n+=128;
      if(this.n>=384){this.out.push(this.e/this.n);this.right.push(this.er/this.n);this.e=0;this.er=0;this.n=0;
        if(this.out.length>=50){this.port.postMessage({f:this.first,rms:this.out,right:this.right});this.out=[];this.right=[];}}
      return true;}}
    registerProcessor('cord-tap',Tap);`;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  const connect = AudioNode.prototype.connect as any;
  const own = new WeakSet<AudioNode>();
  // Один узел на имя: все источники одного имени суммируются (WebAudio складывает входы).
  const nodes = new Map<string, Promise<AudioWorkletNode>>();
  function tapNode(context: AudioContext, wanted: string) {
    // Каждый контекст с выходом пишется отдельно (звуки интерфейса живут в своём): речь — в одном из них.
    if (wanted === 'out' && !w.__outContexts.includes(context)) w.__outContexts.push(context);
    const name = wanted === 'out' ? `out#${w.__outContexts.indexOf(context)}` : wanted;
    let made = nodes.get(name);
    if (!made) {
      made = context.audioWorklet.addModule(url).then(() => {
        // Вход узла — сколько каналов пришло (`max`): моно остаётся моно и в динамике звучит в обоих
        // ушах (R = L), стерео — как есть, без сведения.
        const node = new AudioWorkletNode(context, 'cord-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCountMode: 'max',
          channelInterpretation: 'discrete',
        });
        const mute = context.createGain();
        mute.gain.value = 0;
        own.add(node);
        own.add(mute);
        connect.call(connect.call(node, mute), context.destination);
        const sink = (w.__taps[name] = { t: [] as number[], v: [] as number[], r: [] as number[] });
        node.port.onmessage = (event) => {
          const { f, rms, right } = event.data as { f: number; rms: number[]; right: number[] };
          const stamp = context.getOutputTimestamp();
          const ok = !!stamp.performanceTime && !!stamp.contextTime;
          const base =
            performance.timeOrigin +
            (ok ? stamp.performanceTime! : performance.now()) -
            ((ok ? stamp.contextTime! : context.currentTime) - f / context.sampleRate) * 1000;
          const step = (384 / context.sampleRate) * 1000;
          rms.forEach((value, i) => {
            sink.t.push(base + i * step);
            sink.v.push(value);
            sink.r.push(right[i] ?? value);
          });
        };
        return node;
      });
      nodes.set(name, made);
    }
    return made;
  }
  const contexts: Record<string, AudioContext> = {};
  async function tapTrack(name: string, track: MediaStreamTrack) {
    const context = (contexts[name] ??= new AudioContext({ sampleRate: 48000 }));
    if (context.state !== 'running') await context.resume().catch(() => {});
    const source = context.createMediaStreamSource(new MediaStream([track]));
    // Дорожка Chrome отдаёт звук в WebAudio, только если её где-то играют: элемент без звука.
    const element = new Audio();
    element.muted = true;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => {});
    w.__keep = [...(w.__keep ?? []), element];
    connect.call(source, await tapNode(context, name));
  }
  // Что уходит в динамик: всё, что приложение подключает к выходу своего контекста.
  AudioNode.prototype.connect = function (this: AudioNode, destination: any, ...rest: any[]) {
    const result = connect.call(this, destination, ...rest);
    if (
      destination instanceof AudioDestinationNode &&
      !own.has(this) &&
      this.context instanceof AudioContext
    ) {
      const context = this.context;
      void tapNode(context, 'out').then((node) => connect.call(this, node));
    }
    return result;
  } as any;
  // Что уходит в отправитель: дорожка микрофона в addTransceiver / replaceTrack.
  const add = Native.prototype.addTransceiver;
  Native.prototype.addTransceiver = function (this: RTCPeerConnection, what: any, init?: any) {
    if (typeof what !== 'string' && what.kind === 'audio') void tapTrack('sent', what);
    return add.call(this, what, init);
  } as any;
  const replace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
    if (track && track.kind === 'audio') void tapTrack('sent', track);
    return replace.call(this, track);
  };
};

async function inbound(page: Page) {
  return page.evaluate(async () => {
    const out: any[] = [];
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      const targets = new Map<string, number | null>();
      for (const r of pc.getReceivers())
        if (r.track?.kind === 'audio') targets.set(r.track.id, (r as any).jitterBufferTarget ?? null);
      const report = await pc.getStats();
      const codecs = new Map<string, string>();
      report.forEach((s: any) => {
        if (s.type === 'codec') codecs.set(s.id, s.mimeType);
      });
      report.forEach((s: any) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
        out.push({
          ssrc: s.ssrc,
          track: s.trackIdentifier,
          target: targets.get(s.trackIdentifier) ?? null,
          codec: codecs.get(s.codecId) ?? null,
          ts: s.timestamp,
          packets: s.packetsReceived,
          lost: s.packetsLost,
          jitter: s.jitter,
          jbDelay: s.jitterBufferDelay,
          jbEmitted: s.jitterBufferEmittedCount,
          jbTargetDelay: s.jitterBufferTargetDelay,
          jbMinDelay: s.jitterBufferMinimumDelay,
          total: s.totalSamplesReceived,
          concealed: s.concealedSamples,
          silentConcealed: s.silentConcealedSamples,
          events: s.concealmentEvents,
          decel: s.insertedSamplesForDeceleration,
          accel: s.removedSamplesForAcceleration,
          discarded: s.packetsDiscarded,
          fec: s.fecPacketsReceived,
          nacks: s.nackCount,
          retransmitted: s.retransmittedPacketsReceived,
          level: s.audioLevel,
        });
      });
    }
    return out;
  });
}

async function outbound(page: Page) {
  return page.evaluate(async () => {
    const out: any[] = [];
    for (const pc of (window as any).__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      const report = await pc.getStats();
      const codecs = new Map<string, string>();
      report.forEach((s: any) => {
        if (s.type === 'codec') codecs.set(s.id, `${s.mimeType} ${s.sdpFmtpLine ?? ''}`);
      });
      report.forEach((s: any) => {
        if (s.type === 'outbound-rtp' && s.kind === 'audio')
          out.push({
            type: 'out',
            ts: s.timestamp,
            codec: codecs.get(s.codecId),
            bytes: s.bytesSent,
            packets: s.packetsSent,
          });
        if (s.type === 'remote-inbound-rtp' && s.kind === 'audio')
          out.push({
            type: 'remote',
            ts: s.timestamp,
            lost: s.packetsLost,
            fraction: s.fractionLost,
            rtt: s.roundTripTime,
          });
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
          out.push({ type: 'pair', rtt: s.currentRoundTripTime, out: s.availableOutgoingBitrate });
      });
    }
    return out;
  });
}

const taps = (page: Page) =>
  page.evaluate(() => {
    const all = (window as any).__taps as Record<string, { t: number[]; v: number[]; r: number[] }>;
    const out: Record<string, { t: number; db: number; right: number }[]> = {};
    for (const [name, { t, v, r }] of Object.entries(all ?? {}))
      out[name] = t.map((time, i) => ({
        t: time,
        db: 10 * Math.log10(v[i]! + 1e-12),
        right: 10 * Math.log10((r[i] ?? v[i]!) + 1e-12),
      }));
    return out;
  });

/** Насколько правое ухо тише левого: средняя разница по блокам, где вообще что-то звучит. */
function balance(list: { db: number; right?: number }[]) {
  const loud = list.filter((b) => b.db > -50 || (b.right ?? -120) > -50);
  if (!loud.length) return null;
  return Math.round((loud.reduce((s, b) => s + (b.db - (b.right ?? b.db)), 0) / loud.length) * 10) / 10;
}

/** Сколько процессора было свободно и сколько отнял гипервизор: замер на занятой машине не замер. */
function cpu() {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = (line[3] ?? 0) + (line[4] ?? 0);
  const steal = line[7] ?? 0;
  return { total: line.reduce((a, b) => a + b, 0), idle, steal };
}

/** Страница из локальной сборки: всё, кроме ядра, SFU и загрузок, — из `dist`. */
async function serveDist(context: BrowserContext, origin: string) {
  if (!DIST) return;
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
  };
  await context.route(
    (url) => url.origin === origin && !/^\/(api|rtc|uploads|downloads|tg)(\/|$)/.test(url.pathname),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      let file = join(DIST, decodeURIComponent(path));
      if (!file.startsWith(resolve(DIST)) || !existsSync(file) || statSync(file).isDirectory())
        file = join(DIST, 'index.html');
      await route.fulfill({
        status: 200,
        body: readFileSync(file),
        headers: {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    },
  );
}

test('речь на плохом канале: без слышимых обрывов', async ({ baseURL }) => {
  expect(VOICE, 'VOICE_WAV — файл речи').not.toBe('');
  mkdirSync(OUT, { recursive: true });
  const origin = new URL(baseURL!).origin;
  const flags = {
    noPlayout: !!process.env.PROBE_NO_PLAYOUT,
    noDtx: !!process.env.PROBE_NO_DTX,
    fixedTarget: Number(process.env.PROBE_FIXED_TARGET ?? 0),
  };
  const state = resolve(process.cwd(), '.local/e2e/returning.json');
  const speakerBrowser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      `--use-file-for-fake-audio-capture=${SPEAKER_WAV || VOICE}`,
      // Например, RED с двумя повторами у издателя: `--force-fieldtrials=WebRTC-Audio-Red-For-Opus/Enabled-2/`.
      ...(process.env.PROBE_SPEAKER_ARGS ? process.env.PROBE_SPEAKER_ARGS.split(' ') : []),
      ...(DIST ? [LOCAL_PAGE] : []),
    ],
  });
  let listenerBrowser: Browser;
  if (LISTENER_WS) listenerBrowser = await chromium.connect(LISTENER_WS);
  else
    listenerBrowser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  const options = {
    viewport: { width: 1280, height: 860 },
    locale: 'ru-RU',
    baseURL,
    storageState: state,
    bypassCSP: true,
    serviceWorkers: 'block' as const,
    permissions: ['camera', 'microphone'],
  };
  const speakerContext = await speakerBrowser.newContext(options);
  const listenerContext = await listenerBrowser.newContext(options);
  await speakerContext.addInitScript(probe, {
    noPlayout: false,
    noDtx: flags.noDtx,
    fixedTarget: 0,
    noRed: !!process.env.PROBE_NO_RED,
  });
  await listenerContext.addInitScript(probe, {
    noPlayout: flags.noPlayout,
    noDtx: false,
    fixedTarget: flags.fixedTarget,
  });
  if (SUPPRESSION)
    await speakerContext.addInitScript((suppression) => {
      const key = 'cord:preferences:v1';
      const data = JSON.parse(localStorage.getItem(key) ?? '{}');
      data.audio = { ...(data.audio ?? {}), suppression };
      localStorage.setItem(key, JSON.stringify(data));
    }, SUPPRESSION);
  await serveDist(speakerContext, origin);
  await serveDist(listenerContext, origin);
  const speaker = await speakerContext.newPage();
  const listener = await listenerContext.newPage();
  let resubscribes = 0;
  const resubscribedAt: number[] = [];
  const errors: string[] = [];
  listener.on('console', (message) => {
    if (message.text().includes('live resubscribe')) {
      resubscribes += 1;
      resubscribedAt.push(Date.now());
    }
    if (message.type() === 'error' && errors.length < 20)
      errors.push(`слушатель: ${message.text().slice(0, 200)}`);
  });
  speaker.on('console', (message) => {
    if (message.type() === 'error' && errors.length < 20)
      errors.push(`говорящий: ${message.text().slice(0, 200)}`);
  });
  process.on('exit', () => errors.length && console.log('ошибки страниц:\n' + errors.join('\n')));
  try {
    // Встречу заводит браузер из netns: у него свой адрес, и общий для машины предел «новых встреч
    // за час» (его выбирают все e2e этой машины) его не касается.
    // Серия замеров идёт в одной встрече «якоря» (`anchor.mjs`, PROBE_INVITE) — так серия не
    // упирается в предел новых встреч за час.
    const [creator, joiner] = LISTENER_WS ? [listener, speaker] : [speaker, listener];
    const enter = async (page: Page, invitation: string) => {
      await page.goto(invitation);
      await page.getByLabel('Ваше имя').fill(page === speaker ? 'Говорящий' : 'Слушатель');
      await page.getByRole('button', { name: 'Войти во встречу' }).click();
      await expect(page.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    };
    let invitation = INVITE;
    if (!invitation) {
      await creator.goto('/');
      await creator.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 60000 });
      await creator.getByLabel('Ваше имя').fill(creator === speaker ? 'Говорящий' : 'Слушатель');
      await creator.getByRole('button', { name: 'Начать встречу' }).click();
      await expect(creator.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
      await creator.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
      invitation = await creator.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
      await creator.getByRole('button', { name: 'Закрыть', exact: true }).click();
    } else await enter(creator, invitation);
    await enter(joiner, invitation);
    await speaker.getByRole('button', { name: 'Включить микрофон', exact: true }).click();
    if (process.env.PROBE_CAMERA)
      await speaker.getByRole('button', { name: 'Включить камеру', exact: true }).click();
    await expect.poll(async () => (await inbound(listener)).length, { timeout: 30000 }).toBeGreaterThan(0);
    // Рисование встречи в безголовом Chromium на этой машине съедает процессор, и звук начинает
    // спотыкаться не от сети, а от того, что поток вывода не успевает (FakeAudioWorker пропускает
    // такты). Человеку на своём компьютере это не грозит, поэтому интерфейс прячем: звук и логика
    // встречи идут как обычно, `document.hidden` не меняется. PROBE_SHOW_UI=1 — не прятать.
    if (!process.env.PROBE_SHOW_UI)
      for (const page of [speaker, listener])
        await page.addStyleTag({ content: 'body { content-visibility: hidden !important; }' });
    await listener.waitForTimeout(WARM_MS);

    // Окно замера: огибающие до него выбрасываются, getStats — раз в секунду.
    const from = Date.now();
    const rows: any[] = [];
    const host: { idle: number; steal: number }[] = [];
    let cpuBefore = cpu();
    const sent: any[] = [];
    // Сценарий «канал замер и отпустил» (R107): в середине окна своя команда — например, netem
    // с задержкой 1,8 с на 2 с. Пакеты за это время приходят пачкой — так выглядит икота сети или хоста.
    let stalledAt = 0;
    while (Date.now() - from < PROBE_MS) {
      if (!stalledAt && STALL_CMD && Date.now() - from >= STALL_AT) {
        stalledAt = Date.now();
        exec(STALL_CMD);
      }
      const [inRows, outRows] = await Promise.all([inbound(listener), outbound(speaker)]);
      // Дорожка речи — та, у которой больше всего отсчётов (у слушателя она одна, но после
      // переподписки появляется новая — считаем по последней).
      const voice = inRows.sort((a, b) => (b.total ?? 0) - (a.total ?? 0))[0];
      const cpuNow = cpu();
      const spent = cpuNow.total - cpuBefore.total || 1;
      const load = {
        idle: (cpuNow.idle - cpuBefore.idle) / spent,
        steal: (cpuNow.steal - cpuBefore.steal) / spent,
      };
      host.push(load);
      cpuBefore = cpuNow;
      if (voice) rows.push({ at: Date.now(), ...voice, ...load });
      sent.push({ at: Date.now(), rows: outRows });
      await listener.waitForTimeout(1000);
    }
    const to = Date.now();
    const [heardTaps, sentTaps] = await Promise.all([taps(listener), taps(speaker)]);
    const window = (list?: { t: number; db: number }[]) =>
      (list ?? []).filter((b) => b.t >= from && b.t <= to);
    // Фраза, задетая краем окна, короче не из-за сети: её не считаем.
    const inner = (list: ReturnType<typeof phrases>) =>
      list.filter((p) => p.start > from + 300 && p.end < to - 300);
    // Выход речи — самый громкий из контекстов, подключённых к динамику.
    const loudness = (list: { db: number }[]) => {
      const sorted = list.map((b) => b.db).sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * 0.9)] ?? -Infinity;
    };
    const outName =
      Object.keys(heardTaps)
        .filter((k) => k.startsWith('out#'))
        .sort((a, b) => loudness(window(heardTaps[b])) - loudness(window(heardTaps[a])))[0] ?? 'out#0';
    const heardOut = inner(phrases(window(heardTaps[outName])));
    const heardRecv = inner(phrases(window(heardTaps.recv)));
    const spoken = inner(phrases(window(sentTaps.sent)));
    // Переподписка обнуляет счётчики: итог — по самому длинному куску одной дорожки.
    const byTrack = new Map<string, any[]>();
    for (const r of rows)
      byTrack.set(`${r.track}:${r.ssrc}`, [...(byTrack.get(`${r.track}:${r.ssrc}`) ?? []), r]);
    const longest = [...byTrack.values()].sort((a, b) => b.length - a.length)[0] ?? [];
    const delays = latency(spoken, heardOut.length >= 3 ? heardOut : heardRecv);
    const lastOut = sent.at(-1)?.rows ?? [];
    // Какой кодек на самом деле договорён: getStats у RED показывает Opus (декодер), правда — в SDP.
    const firstAudioCodec = (page: Page) =>
      page.evaluate(() =>
        ((window as any).__pcs as RTCPeerConnection[])
          .filter((pc) => pc.connectionState !== 'closed')
          .map((pc) => {
            const sdp = pc.currentRemoteDescription?.sdp ?? '';
            const audio = sdp
              .split('m=')
              .filter((m) => m.startsWith('audio'))
              .map((m) => {
                const pt = m.split('\r\n')[0]?.split(' ')[3];
                const codec = m.match(new RegExp(`a=rtpmap:${pt} ([^\\r\\n]+)`))?.[1] ?? null;
                const direction = m.match(/a=(sendrecv|sendonly|recvonly|inactive)/)?.[1] ?? null;
                const opus = m.match(/a=rtpmap:(\d+) opus/i)?.[1];
                const nack = opus && new RegExp(`a=rtcp-fb:${opus} nack`).test(m) ? '+nack' : '';
                return `${codec}/${direction}${nack}`;
              });
            const local = (pc.currentLocalDescription?.sdp ?? '').includes(' nack') ? 'local-nack' : '';
            return { type: pc.currentRemoteDescription?.type, audio, local };
          }),
      );
    const sdp = { speaker: await firstAudioCodec(speaker), listener: await firstAudioCodec(listener) };
    // Как звук слушателя доходит до динамика: элементы и контекст WebAudio приложения.
    const playback = await listener.evaluate(() => {
      const w = window as any;
      return {
        elements: [...document.querySelectorAll('audio')].map((a) => ({
          muted: a.muted,
          volume: a.volume,
          paused: a.paused,
          tracks:
            (a.srcObject as MediaStream | null)?.getAudioTracks().map((t) => `${t.readyState}:${t.muted}`) ??
            [],
        })),
        outContexts: (w.__outContexts as AudioContext[]).map((c) => ({ state: c.state, rate: c.sampleRate })),
        taps: Object.fromEntries(Object.entries(w.__taps ?? {}).map(([k, v]: any) => [k, v.t.length])),
      };
    });
    const result = {
      label: LABEL,
      flags: {
        ...flags,
        noRed: !!process.env.PROBE_NO_RED,
        speakerArgs: process.env.PROBE_SPEAKER_ARGS ?? '',
      },
      camera: !!process.env.PROBE_CAMERA,
      listenerInNetns: !!LISTENER_WS,
      dist: !!DIST,
      stats: statsSummary(longest),
      tracks: byTrack.size,
      stalledAt: stalledAt ? stalledAt - from : null,
      // Где пришлась каждая переподписка: внутри услышанной фразы (слышно) или в паузе.
      resubscribedIn: resubscribedAt.map((at) => {
        const inside = heardOut.some((p) => at >= p.start - 200 && at <= p.end + 200);
        return { atMs: at - from, during: inside ? 'фраза' : 'пауза' };
      }),
      sdp,
      playback,
      host: {
        idleAvgPct: Math.round((host.reduce((a, h) => a + h.idle, 0) / (host.length || 1)) * 100),
        idleMinPct: Math.round(Math.min(...host.map((h) => h.idle)) * 100),
        stealMaxPct: Math.round(Math.max(...host.map((h) => h.steal)) * 100),
      },
      resubscribes,
      heard: heardSummary(heardOut),
      heardBeforeWebAudio: heardSummary(heardRecv),
      spoken: heardSummary(spoken),
      // Баланс ушей у слушателя (R113): средняя разница L−R по звучащим блокам выхода, дБ.
      balanceDb: balance(window(heardTaps[outName])),
      sentBalanceDb: balance(window(sentTaps.sent)),
      latencyMs: {
        n: delays.length,
        median: delays.length ? [...delays].sort((a, b) => a - b)[Math.floor(delays.length / 2)] : null,
        max: delays.length ? Math.max(...delays) : null,
      },
      sender: {
        codec: lastOut.find((r: any) => r.type === 'out')?.codec ?? null,
        remoteLost: lastOut.find((r: any) => r.type === 'remote')?.lost ?? null,
        rttMs: Math.round((lastOut.find((r: any) => r.type === 'pair')?.rtt ?? 0) * 1000),
      },
      cuts: heardOut.flatMap((p) => p.cuts),
    };
    const pack = (list?: { t: number; db: number }[]) => {
      const w = window(list);
      return w.length ? { t0: Math.round(w[0]!.t), db: w.map((b) => Math.round(b.db * 10) / 10) } : null;
    };
    writeFileSync(
      join(OUT, `${LABEL}.json`),
      JSON.stringify({
        result,
        rows,
        sent,
        taps: { out: pack(heardTaps[outName]), recv: pack(heardTaps.recv), sent: pack(sentTaps.sent) },
      }),
    );
    console.log(JSON.stringify({ ...result, cuts: result.cuts.slice(0, 20) }, null, 1));
    if (ASSERT) {
      expect(result.stats, 'есть отчёты слушателя').not.toBeNull();
      expect(result.heard.phrases, 'слушатель слышит фразы').toBeGreaterThan(PROBE_MS / 6000);
      expect(result.stats!.concealPct!, 'заглушка речи ≤ 1 %').toBeLessThanOrEqual(1);
      expect(result.heard.cutsOver60, 'нет слышимых обрывов длиннее 60 мс').toBe(0);
      expect(result.stats!.jbDelayMs!, 'запас буфера приёма ≤ 250 мс').toBeLessThanOrEqual(250);
      expect(result.heard.shortP90Ms!, 'края фраз не срезаны (≤ 60 мс)').toBeLessThanOrEqual(60);
      expect(result.resubscribes, 'речь не переподписывалась').toBe(0);
      expect(Math.abs(result.balanceDb ?? 0), 'речь в обоих ушах (R113)').toBeLessThanOrEqual(3);
    }
  } finally {
    await speakerContext.close().catch(() => {});
    await listenerContext.close().catch(() => {});
    await speakerBrowser.close().catch(() => {});
    if (!LISTENER_WS) await listenerBrowser.close().catch(() => {});
  }
});
