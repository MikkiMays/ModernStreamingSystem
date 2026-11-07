/**
 * Живой замер нажатия на микрофон (R191): «выключается быстро, а включается долго».
 *
 * Два браузера через настоящий SFU: говорящий с «речью» из файла без пауз (`MIC_WAV`, см. низ файла) и
 * слушатель. На каждое нажатие снимается весь путь: нажатие → кнопка → `enabled` сырого захвата → сигнал
 * «включён» → запрос `mute` в сокете → первый пакет у слушателя → значок у слушателя → звук у слушателя.
 * Всё считается от события `click` часами страницы, браузеры на одной машине — часы общие.
 *
 * Включается `CORD_MEDIA_PROBE=1` и `MIC_WAV=…`; нужен стенд с SFU. Переменные:
 *   MIC_SCENARIOS  — через запятую: basic, idle, devices, slowgum, wake, signal, signalin, soak;
 *   MIC_CYCLES     — сколько нажатий в `basic` (8);
 *   MIC_IDLE_MS    — сколько молчать в `idle` (120 с);
 *   MIC_SOAK_MS    — длина `soak` (10 мин);
 *   MIC_SUPPRESSION — шумоподавление говорящего: off | browser | rnnoise | voice (rnnoise);
 *   MIC_LABEL, OUT — как назвать итог и куда положить (`/tmp/mic-press`).
 *
 * Предел стенда — 10 новых встреч в час: все сценарии идут в одной встрече.
 */
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WAV = process.env.MIC_WAV ?? '';
const SCENARIOS = (process.env.MIC_SCENARIOS ?? 'basic').split(',').map((s) => s.trim());
const CYCLES = Number(process.env.MIC_CYCLES ?? 8);
const IDLE_MS = Number(process.env.MIC_IDLE_MS ?? 120_000);
const SOAK_MS = Number(process.env.MIC_SOAK_MS ?? 600_000);
const SUPPRESSION = process.env.MIC_SUPPRESSION ?? 'rnnoise';
const OUT = process.env.OUT ?? '/tmp/mic-press';
const LABEL = process.env.MIC_LABEL ?? 'run';
/** Громче этого на выходе слушателя — звук идёт; тишина заглушённого — ниже −70 дБ. */
const HEARD_DB = -50;
const MIC_OFF_LABEL = 'Микрофон выключен';

test.skip(!process.env.CORD_MEDIA_PROBE, 'живой замер: CORD_MEDIA_PROBE=1, MIC_WAV=…');
test.setTimeout(30 * 60_000);

/** Перехваты до кода страницы: время каждого шага и управляемые помехи. */
const probe = () => {
  const w = window as any;
  if (!window.RTCPeerConnection || typeof MediaDevices === 'undefined' || !window.isSecureContext) return;
  const abs = () => performance.timeOrigin + performance.now();
  const log: Record<string, any[]> = {
    clicks: [],
    flips: [],
    enabled: [],
    gum: [],
    wsOut: [],
    wsIn: [],
    notes: [],
    tile: [],
    packets: [],
    played: [],
    stats: [],
    outbound: [],
    errors: [],
  };
  w.__log = log;
  w.__cfg = { gumDelay: 0, wsOutMuteDelay: 0, wsInUpdateDelay: 0, devices: null };
  w.__pcs = [];
  w.__taps = {};

  const enabled = Object.getOwnPropertyDescriptor(MediaStreamTrack.prototype, 'enabled')!;
  Object.defineProperty(MediaStreamTrack.prototype, 'enabled', {
    configurable: true,
    get(this: MediaStreamTrack) {
      return enabled.get!.call(this);
    },
    set(this: MediaStreamTrack, value: boolean) {
      if (this.kind === 'audio') log.enabled!.push({ t: abs(), value, id: this.id, label: this.label });
      enabled.set!.call(this, value);
    },
  });

  const gum = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints?: MediaStreamConstraints) {
    const audio = !!constraints?.audio;
    const start = abs();
    if (audio && w.__cfg.gumDelay) await new Promise((r) => setTimeout(r, w.__cfg.gumDelay));
    const stream = await gum.call(this, constraints);
    if (audio) {
      log.gum!.push({ start, end: abs() });
      // Что отдаёт сам захват, до шумодава: контроль начала звука.
      for (const track of stream.getAudioTracks()) void w.__tapTrack?.('raw', track);
    }
    return stream;
  };
  // Какой список устройств видит страница: как настоящий или как после подключения гарнитуры.
  const enumerate = MediaDevices.prototype.enumerateDevices;
  let headset = 0;
  MediaDevices.prototype.enumerateDevices = async function () {
    const list = await enumerate.call(this);
    const mode = w.__cfg.devices as 'added' | 'first' | null;
    if (!mode) return list;
    const plain = list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: d.label }));
    const others = plain.filter((d) => d.kind !== 'audioinput');
    const mics = plain.filter((d) => d.kind === 'audioinput');
    // Chrome: «по умолчанию» остаётся первым, в списке новая строка.
    if (mode === 'added')
      return [
        ...mics.slice(0, 1),
        { kind: 'audioinput', deviceId: 'headset', groupId: 'g-headset', label: 'Гарнитура' },
        ...mics.slice(1),
        ...others,
      ] as MediaDeviceInfo[];
    // Firefox, Safari, ОС без default: первым стало другое настоящее устройство.
    headset += 1;
    const real = mics.filter((d) => d.deviceId !== 'default');
    const first = real[headset % real.length]!;
    return [first, ...real.filter((d) => d !== first), ...others] as MediaDeviceInfo[];
  };

  // Сигнал LiveKit: SignalRequest.mute — поле 5 (тег 0x2A), SignalResponse.update — поле 5 (тег тот же 0x2A, сокет другой).
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: any) {
    const first = data instanceof ArrayBuffer ? new Uint8Array(data)[0] : undefined;
    if (first === 0x2a) {
      log.wsOut!.push({ t: abs() });
      if (w.__cfg.wsOutMuteDelay) {
        setTimeout(() => send.call(this, data), w.__cfg.wsOutMuteDelay);
        return;
      }
    }
    send.call(this, data);
  };
  const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage')!;
  Object.defineProperty(WebSocket.prototype, 'onmessage', {
    configurable: true,
    get(this: WebSocket) {
      return onmessage.get!.call(this);
    },
    set(this: WebSocket, handler: ((event: MessageEvent) => void) | null) {
      if (!handler) return void onmessage.set!.call(this, handler);
      onmessage.set!.call(this, (event: MessageEvent) => {
        const first = event.data instanceof ArrayBuffer ? new Uint8Array(event.data)[0] : undefined;
        if (first === 0x2a) {
          log.wsIn!.push({ t: abs() });
          if (w.__cfg.wsInUpdateDelay) {
            setTimeout(() => handler.call(this, event), w.__cfg.wsInUpdateDelay);
            return;
          }
        }
        handler.call(this, event);
      });
    },
  });

  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when?: number) {
    log.notes!.push(abs());
    return start.call(this, when);
  };
  document.addEventListener(
    'click',
    (event) => {
      const button = (event.target as Element).closest?.('button');
      if (/микрофон/.test(button?.getAttribute('aria-label') ?? '')) log.clicks!.push(abs());
    },
    true,
  );
  const watchDom = () => {
    let tiles = -1;
    new MutationObserver((records) => {
      for (const record of records) {
        const label = (record.target as Element).getAttribute?.('aria-label');
        if (label === 'Включить микрофон' || label === 'Выключить микрофон')
          log.flips!.push({ t: abs(), label });
      }
      const now = document.querySelectorAll(`[aria-label="${'Микрофон выключен'}"]`).length;
      if (now !== tiles) {
        log.tile!.push({ t: abs(), count: now });
        tiles = now;
      }
    }).observe(document.documentElement, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['aria-label'],
    });
  };
  if (document.documentElement) watchDom();
  else document.addEventListener('DOMContentLoaded', watchDom);

  // Огибающая 8 мс: что пришло дорожкой к слушателю и что уходит в отправитель у говорящего.
  const code = `class Tap extends AudioWorkletProcessor {
    constructor(){super();this.e=0;this.n=0;this.first=0;this.out=[];}
    process(inputs){const ch=inputs[0]&&inputs[0][0];
      if(this.n===0&&this.out.length===0)this.first=currentFrame;
      for(let i=0;i<128;i++){const v=ch?ch[i]:0;this.e+=v*v;}
      this.n+=128;
      if(this.n>=384){this.out.push(this.e/this.n);this.e=0;this.n=0;
        if(this.out.length>=10){this.port.postMessage({f:this.first,rms:this.out});this.out=[];}}
      return true;}}
    registerProcessor('cord-tap',Tap);`;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  const contexts: Record<string, Promise<{ context: AudioContext; node: AudioWorkletNode }>> = {};
  const tap = (name: string) => {
    contexts[name] ??= (async () => {
      const context = new AudioContext({ sampleRate: 48000 });
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, 'cord-tap');
      const sink = (w.__taps[name] = { t: [] as number[], v: [] as number[] });
      node.port.onmessage = (event) => {
        const { f, rms } = event.data as { f: number; rms: number[] };
        const stamp = context.getOutputTimestamp();
        const ok = !!stamp.performanceTime && !!stamp.contextTime;
        const base =
          performance.timeOrigin +
          (ok ? stamp.performanceTime! : performance.now()) -
          ((ok ? stamp.contextTime! : context.currentTime) - f / context.sampleRate) * 1000;
        rms.forEach((value, i) => {
          sink.t.push(base + i * 8);
          sink.v.push(value);
        });
        // Только свежее: долгий замер не должен копить гигабайты.
        if (sink.t.length > 60000) {
          sink.t.splice(0, 20000);
          sink.v.splice(0, 20000);
        }
      };
      const mute = context.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(context.destination);
      void context.resume().catch(() => {});
      return { context, node };
    })();
    return contexts[name]!;
  };
  const tapTrack = async (name: string, track: MediaStreamTrack) => {
    const { context, node } = await tap(name);
    context.createMediaStreamSource(new MediaStream([track])).connect(node);
    // Дорожка Chrome отдаёт звук в WebAudio, только если её где-то играют: элемент без звука.
    const element = new Audio();
    element.muted = true;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => {});
    w.__keep = [...(w.__keep ?? []), element];
  };

  w.__tapTrack = tapTrack;
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
  const add = Native.prototype.addTransceiver;
  Native.prototype.addTransceiver = function (this: RTCPeerConnection, what: any, init?: any) {
    if (typeof what !== 'string' && what.kind === 'audio') void tapTrack('sent', what);
    return add.call(this, what, init);
  } as any;
  const replace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (this: RTCRtpSender, track: MediaStreamTrack | null) {
    if (track?.kind === 'audio') void tapTrack('sent', track);
    return replace.call(this, track);
  };

  // Первые пакеты и что играет: `getStats` — у сети, источники приёмника — у вывода.
  const state = new Map<RTCRtpReceiver, { packets: number; rtp: number }>();
  setInterval(() => {
    for (const pc of w.__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind !== 'audio') continue;
        const known = state.get(receiver) ?? { packets: -1, rtp: -1 };
        state.set(receiver, known);
        const source = receiver.getSynchronizationSources?.()[0];
        if (source && source.rtpTimestamp !== known.rtp) {
          known.rtp = source.rtpTimestamp;
          if (log.played!.length > 40000) log.played!.splice(0, 20000);
          log.played!.push({ t: abs(), rtp: source.rtpTimestamp, level: source.audioLevel });
        }
      }
    }
  }, 10);
  setInterval(() => {
    for (const pc of w.__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind !== 'audio') continue;
        const known = state.get(receiver);
        void receiver.getStats().then((report) => {
          report.forEach((s: any) => {
            if (s.type !== 'inbound-rtp' || !known) return;
            if (s.packetsReceived !== known.packets) {
              known.packets = s.packetsReceived;
              if (log.packets!.length > 40000) log.packets!.splice(0, 20000);
              log.packets!.push({
                t: abs(),
                packets: s.packetsReceived,
                jitter: s.jitter,
                target: (receiver as any).jitterBufferTarget ?? null,
                delay: s.jitterBufferDelay,
                emitted: s.jitterBufferEmittedCount,
                targetDelay: s.jitterBufferTargetDelay,
                minDelay: s.jitterBufferMinimumDelay,
              });
            }
          });
        });
      }
    }
  }, 40);
  // Что на самом деле ушло в сеть у говорящего: с какого момента пакеты пошли потоком речи.
  const sentState = new Map<RTCRtpSender, number>();
  setInterval(() => {
    for (const pc of w.__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'audio') continue;
        void sender.getStats().then((report) => {
          report.forEach((s: any) => {
            if (s.type !== 'outbound-rtp') return;
            if (s.packetsSent === sentState.get(sender)) return;
            sentState.set(sender, s.packetsSent);
            if (log.outbound!.length > 40000) log.outbound!.splice(0, 20000);
            log.outbound!.push({ t: abs(), packets: s.packetsSent, bytes: s.bytesSent });
          });
        });
      }
    }
  }, 40);
  // Те же счётчики, что читает `PlayoutBuffer`, с тем же шагом: чем заглушка выглядит для него.
  setInterval(() => {
    for (const pc of w.__pcs as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      for (const receiver of pc.getReceivers()) {
        if (receiver.track?.kind !== 'audio') continue;
        void receiver.getStats().then((report) => {
          report.forEach((s: any) => {
            if (s.type !== 'inbound-rtp') return;
            if (log.stats!.length > 4000) log.stats!.splice(0, 2000);
            log.stats!.push({
              t: abs(),
              packets: s.packetsReceived,
              lost: s.packetsLost,
              total: s.totalSamplesReceived,
              concealed: s.concealedSamples,
              silent: s.silentConcealedSamples,
              events: s.concealmentEvents,
              jitter: s.jitter,
              removed: s.removedSamplesForAcceleration,
              inserted: s.insertedSamplesForDeceleration,
              target: (receiver as any).jitterBufferTarget ?? null,
              enabled: receiver.track.enabled,
            });
          });
        });
      }
    }
  }, 2000);
  window.addEventListener('error', (event) => log.errors!.push(String(event.message)));
};

type Log = Record<string, any[]>;
const logOf = (page: Page) => page.evaluate(() => (window as any).__log as Log);
const tapsOf = (page: Page, name: string, from: number) =>
  page.evaluate(
    ([n, f]) => {
      const sink = (window as any).__taps[n as string] as { t: number[]; v: number[] } | undefined;
      if (!sink) return [];
      const out: { t: number; db: number }[] = [];
      for (let i = sink.t.length - 1; i >= 0 && sink.t[i]! >= (f as number); i--)
        out.push({ t: sink.t[i]!, db: 10 * Math.log10(sink.v[i]! + 1e-12) });
      return out.reverse();
    },
    [name, from] as const,
  );

/** Первый блок громче порога, за которым идут ещё два таких же: щелчок не считается началом речи. */
function firstHeard(blocks: { t: number; db: number }[], from: number) {
  for (let i = 0; i + 2 < blocks.length; i++)
    if (
      blocks[i]!.t >= from &&
      blocks[i]!.db > HEARD_DB &&
      blocks[i + 1]!.db > HEARD_DB &&
      blocks[i + 2]!.db > HEARD_DB
    )
      return blocks[i]!.t;
  return null;
}
function lastHeard(blocks: { t: number; db: number }[]) {
  let last: number | null = null;
  for (const block of blocks) if (block.db > HEARD_DB) last = block.t;
  return last;
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
};
const round = (value: number | null | undefined) => (value == null ? null : Math.round(value));

interface PressResult {
  scenario: string;
  dir: 'on' | 'off';
  /** Всё — миллисекунды от нажатия. */
  button: number | null;
  enabled: number | null;
  chime: number | null;
  wsOut: number | null;
  packet: number | null;
  tile: number | null;
  played: number | null;
  heard: number | null;
  sentAudio: number | null;
  rawAudio: number | null;
  /** Когда у говорящего пошёл поток: второй подряд пакет в пределах 60 мс (DTX шлёт раз в 400 мс). */
  sentFlow: number | null;
  /** Пик джиттера за две секунды после нажатия и средний запас буфера за секунду после первого пакета. */
  jitterMs: number | null;
  bufferMs: number | null;
  gum: number;
  gumMs: number | null;
  target: number | null;
  lastHeard?: number | null;
}

async function press(sender: Page, label: 'Включить микрофон' | 'Выключить микрофон') {
  await sender.getByRole('button', { name: label, exact: true }).click({ timeout: 60_000 });
}

async function measure(
  scenario: string,
  sender: Page,
  listener: Page,
  dir: 'on' | 'off',
  settleMs = Number(process.env.MIC_SETTLE_MS ?? 1800),
): Promise<PressResult> {
  const clicksBefore = (await logOf(sender)).clicks!.length;
  await press(sender, dir === 'on' ? 'Включить микрофон' : 'Выключить микрофон');
  await sender.waitForTimeout(settleMs);
  const [s, l] = await Promise.all([logOf(sender), logOf(listener)]);
  const t0: number = s.clicks![clicksBefore]!;
  const after = <T extends { t: number }>(list: T[]) => list.filter((e) => e.t >= t0);
  const from = (t: number | null | undefined) => (t == null ? null : Math.round(t - t0));
  const value = dir === 'on';
  const [sent, heard, raw] = await Promise.all([
    tapsOf(sender, 'sent', t0 - 200),
    tapsOf(listener, 'recv', t0 - 200),
    tapsOf(sender, 'raw', t0 - 200),
  ]);
  const gums = (s.gum as { start: number; end: number }[]).filter((g) => g.start >= t0);
  const out = after(s.outbound as { t: number; packets: number }[]);
  const flow = out.find((row, i) => {
    const next = out[i + 1];
    return !!next && next.packets - row.packets >= 2 && next.t - row.t < 120;
  });
  const packets = after(
    l.packets as { t: number; target: number | null; jitter?: number; delay?: number; emitted?: number }[],
  );
  const jitters = packets.map((p) => p.jitter ?? 0);
  const firstRow = packets[0];
  const lastRow = packets[packets.length - 1];
  const emitted = (lastRow?.emitted ?? 0) - (firstRow?.emitted ?? 0);
  return {
    scenario,
    dir,
    button: from(after(s.flips as { t: number }[])[0]?.t),
    enabled: from(after(s.enabled as { t: number; value: boolean }[]).find((e) => e.value === value)?.t),
    chime: from((s.notes as number[]).find((t) => t >= t0)),
    wsOut: from(after(s.wsOut as { t: number }[])[0]?.t),
    packet: from(packets[0]?.t),
    tile: from(after(l.tile as { t: number }[])[0]?.t),
    played: from(after(l.played as { t: number }[])[0]?.t),
    heard: from(firstHeard(heard, t0)),
    sentAudio: from(firstHeard(sent, t0)),
    rawAudio: from(firstHeard(raw, t0)),
    sentFlow: from(flow?.t),
    jitterMs: jitters.length ? round(Math.max(...jitters) * 1000) : null,
    bufferMs: emitted > 0 ? round((((lastRow!.delay ?? 0) - (firstRow!.delay ?? 0)) / emitted) * 1000) : null,
    gum: gums.length,
    gumMs: gums[0] ? round(gums[0].end - gums[0].start) : null,
    target: packets[0]?.target ?? null,
    ...(dir === 'off' ? { lastHeard: from(lastHeard(heard)) } : {}),
  };
}

/** Событие `devicechange` с нужным списком устройств; потом — время, за которое LiveKit его разберёт. */
const fireDevices = (page: Page, mode: 'added' | 'first' | null) =>
  page.evaluate(async (value) => {
    (window as any).__cfg.devices = value;
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    await new Promise((r) => setTimeout(r, 400));
  }, mode);

const table = (rows: PressResult[]) => {
  const keys = [
    'button',
    'enabled',
    'chime',
    'wsOut',
    'rawAudio',
    'sentAudio',
    'sentFlow',
    'tile',
    'packet',
    'played',
    'heard',
    'jitterMs',
    'bufferMs',
  ] as const;
  return rows
    .map(
      (r) =>
        `${r.scenario.padEnd(18)} ${r.dir.padEnd(3)} ` +
        keys.map((k) => `${k}=${r[k] ?? '—'}`).join(' ') +
        ` gum=${r.gum}${r.gumMs != null ? `(${r.gumMs})` : ''} target=${r.target ?? '—'}` +
        (r.lastHeard !== undefined ? ` last=${r.lastHeard}` : ''),
    )
    .join('\n');
};

test('нажатие на микрофон: весь путь до слушателя', async ({ baseURL }) => {
  expect(WAV, 'MIC_WAV — файл речи без пауз').not.toBe('');
  mkdirSync(OUT, { recursive: true });
  const standDev = process.env.CORD_STAND_DEV;
  const standArgs = standDev
    ? [`--host-resolver-rules=MAP ${new URL(baseURL!).hostname}:443 ${standDev}`, '--ignore-certificate-errors']
    : [];
  const launch = () =>
    chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        `--use-file-for-fake-audio-capture=${WAV}`,
        ...standArgs,
      ],
    });
  const browsers: Browser[] = [await launch(), await launch()];
  const options = {
    viewport: { width: 1280, height: 860 },
    locale: 'ru-RU',
    baseURL,
    storageState: resolve(process.cwd(), '.local/e2e/returning.json'),
    bypassCSP: true,
    serviceWorkers: 'block' as const,
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: !!standDev,
  };
  const senderContext = await browsers[0]!.newContext(options);
  const listenerContext = await browsers[1]!.newContext(options);
  await senderContext.addInitScript(probe);
  await listenerContext.addInitScript(probe);
  await senderContext.addInitScript((suppression) => {
    const key = 'cord:preferences:v1';
    const data = JSON.parse(localStorage.getItem(key) ?? '{}');
    data.audio = { ...(data.audio ?? {}), suppression, suppressionChosen: true };
    localStorage.setItem(key, JSON.stringify(data));
  }, SUPPRESSION);
  const sender = await senderContext.newPage();
  const listener = await listenerContext.newPage();
  const consoleLines: string[] = [];
  for (const [name, page] of [
    ['говорящий', sender],
    ['слушатель', listener],
  ] as const)
    page.on('console', (message) => {
      const text = message.text();
      if (/\[cord\]|error/i.test(text) && consoleLines.length < 400)
        consoleLines.push(`${new Date().toISOString().slice(11, 23)} ${name}: ${text.slice(0, 240)}`);
    });
  const results: PressResult[] = [];
  const extra: Record<string, unknown> = {};
  try {
    await listener.goto('/');
    await listener.getByRole('button', { name: /Новая встреча/ }).click({ timeout: 60000 });
    await listener.getByLabel('Ваше имя').fill('Слушатель');
    await listener.getByRole('button', { name: 'Начать встречу' }).click();
    await expect(listener.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    await listener.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
    const invitation = await listener.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
    await listener.getByRole('button', { name: 'Закрыть', exact: true }).click();
    await sender.goto(invitation);
    await sender.getByLabel('Ваше имя').fill('Говорящий');
    await sender.getByRole('button', { name: 'Войти во встречу' }).click();
    await expect(sender.locator('[data-media-status="connected"]')).toBeVisible({ timeout: 90000 });
    // Интерфейс в безголовом Chromium ест процессор, и звук спотыкается не от сети (как в `voice-probe`).
    for (const page of [sender, listener])
      await page.addStyleTag({ content: '.stage, .call-stage { content-visibility: hidden !important; }' });

    // Первое включение — захват и публикация; дальше тот же микрофон.
    await press(sender, 'Включить микрофон');
    await expect(sender.getByRole('button', { name: 'Выключить микрофон', exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect
      .poll(async () => (await tapsOf(listener, 'recv', Date.now() - 1500)).some((b) => b.db > HEARD_DB), {
        timeout: 30000,
      })
      .toBe(true);
    await listener.waitForTimeout(6000);

    const onePair = async (scenario: string, mutedMs: number, before?: () => Promise<void>) => {
      results.push(await measure(scenario, sender, listener, 'off', 600));
      await sender.waitForTimeout(mutedMs);
      await before?.();
      const row = await measure(scenario, sender, listener, 'on');
      results.push(row);
      console.log(table([row]));
    };

    if (SCENARIOS.includes('basic'))
      for (let i = 0; i < CYCLES; i++) await onePair('basic-3s', 3000);

    if (SCENARIOS.includes('idle')) {
      await onePair(`idle-${IDLE_MS / 1000}s`, IDLE_MS);
      await onePair(`idle-${IDLE_MS / 1000}s`, IDLE_MS);
    }

    if (SCENARIOS.includes('devices')) {
      extra.devices = await sender.evaluate(async () =>
        (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ id: d.deviceId.slice(0, 8), label: d.label })),
      );
      for (let i = 0; i < 2; i++) await onePair('dev-same', 2000, () => fireDevices(sender, null));
      for (let i = 0; i < 2; i++) await onePair('dev-added', 2000, () => fireDevices(sender, 'added'));
      for (let i = 0; i < 2; i++) await onePair('dev-first-changed', 2000, () => fireDevices(sender, 'first'));
      // Снова настоящий список — следующая смена вернёт и настоящее устройство.
      await fireDevices(sender, null);
    }

    if (SCENARIOS.includes('slowgum')) {
      // Гарнитура Bluetooth или занятая машина: захват идёт 1,5 с. После смены первого устройства.
      await sender.evaluate(() => void ((window as any).__cfg.gumDelay = 1500));
      for (let i = 0; i < 2; i++)
        await onePair('slowgum-devchange', 2000, () => fireDevices(sender, 'first'));
      await sender.evaluate(() => void ((window as any).__cfg.gumDelay = 0));
      await fireDevices(sender, null);
    }

    if (SCENARIOS.includes('wake')) {
      // ОС глушит вход (кнопка на гарнитуре, системный mute): сырой захват `muted`, пока микрофон выключен.
      const setMuted = (muted: boolean) =>
        sender.evaluate((value) => {
          const w = window as any;
          w.__rawMuted = value;
          const proto = MediaStreamTrack.prototype;
          if (!w.__mutedPatched) {
            const native = Object.getOwnPropertyDescriptor(proto, 'muted')!;
            Object.defineProperty(proto, 'muted', {
              configurable: true,
              get(this: MediaStreamTrack) {
                return this.kind === 'audio' && this.label && w.__rawMuted ? true : native.get!.call(this);
              },
            });
            w.__mutedPatched = true;
          }
        }, muted);
      for (let i = 0; i < 2; i++) {
        await onePair('os-muted', 2000, () => setMuted(true));
        await setMuted(false);
        await sender.waitForTimeout(3000);
      }
    }

    if (SCENARIOS.includes('signal')) {
      // Сокет сигнала говорящего опаздывает на 1,5 с (R151: TCP на плохом Wi-Fi): медиа в это время идёт.
      await sender.evaluate(() => void ((window as any).__cfg.wsOutMuteDelay = 1500));
      for (let i = 0; i < 3; i++) await onePair('signal-out-1500', 3000);
      await sender.evaluate(() => void ((window as any).__cfg.wsOutMuteDelay = 0));
      await sender.waitForTimeout(2000);
    }

    if (SCENARIOS.includes('signalin')) {
      // Сокет сигнала слушателя опаздывает: пакеты уже идут, а `ParticipantUpdate` ещё нет.
      await listener.evaluate(() => void ((window as any).__cfg.wsInUpdateDelay = 1500));
      for (let i = 0; i < 3; i++) await onePair('signal-in-1500', 3000);
      await listener.evaluate(() => void ((window as any).__cfg.wsInUpdateDelay = 0));
      await sender.waitForTimeout(2000);
    }

    if (SCENARIOS.includes('idlescan')) {
      // Сколько надо молчать, чтобы первый пакет у слушателя задержался, и у кого он задерживается.
      for (const seconds of (process.env.MIC_IDLE_SCAN ?? '5,30,60,90,120,150').split(',').map(Number)) {
        console.log(`молчим ${seconds} с`);
        await onePair(`scan-${seconds}s`, seconds * 1000);
        // Между замерами — несколько секунд речи: тишина считается заново.
        await sender.waitForTimeout(5000);
      }
    }

    if (SCENARIOS.includes('soak')) {
      // Долгий разговор: минуту говорим — выключаем на 20 с. Смотрим, растёт ли хоть что-то.
      const from = Date.now();
      let round = 0;
      while (Date.now() - from < SOAK_MS) {
        round += 1;
        await onePair(`soak-${String(round).padStart(2, '0')}`, 20_000);
        await sender.waitForTimeout(40_000);
      }
      extra.heap = await sender.evaluate(() => (performance as any).memory?.usedJSHeapSize ?? null);
    }
  } finally {
    const on = results.filter((r) => r.dir === 'on');
    const off = results.filter((r) => r.dir === 'off');
    const groups = new Map<string, PressResult[]>();
    for (const row of on) {
      const key = row.scenario.replace(/-\d+$/, '');
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const summary = [...groups].map(([name, rows]) => ({
      name,
      n: rows.length,
      enabled: median(rows.map((r) => r.enabled ?? NaN).filter(Number.isFinite)),
      chime: median(rows.map((r) => r.chime ?? NaN).filter(Number.isFinite)),
      packet: median(rows.map((r) => r.packet ?? NaN).filter(Number.isFinite)),
      tile: median(rows.map((r) => r.tile ?? NaN).filter(Number.isFinite)),
      sentAudio: median(rows.map((r) => r.sentAudio ?? NaN).filter(Number.isFinite)),
      played: median(rows.map((r) => r.played ?? NaN).filter(Number.isFinite)),
      heard: median(rows.map((r) => r.heard ?? NaN).filter(Number.isFinite)),
      target: median(rows.map((r) => r.target ?? NaN).filter(Number.isFinite)),
      gum: rows.reduce((s, r) => s + r.gum, 0),
    }));
    writeFileSync(
      join(OUT, `${LABEL}.json`),
      JSON.stringify(
        {
          label: LABEL,
          suppression: SUPPRESSION,
          summary,
          results,
          extra,
          stats: await logOf(listener)
            .then((l) => l.stats)
            .catch(() => []),
          clicks: await logOf(sender)
            .then((l) => l.clicks)
            .catch(() => []),
          console: consoleLines,
        },
        null,
        1,
      ),
    );
    console.log('---- включение ----\n' + table(on));
    console.log('---- выключение ----\n' + table(off));
    console.log('---- медианы (мс от нажатия) ----');
    for (const row of summary) console.log(JSON.stringify(row));
    console.log(`последние строки журнала:\n${consoleLines.slice(-12).join('\n')}`);
    await Promise.all(browsers.map((browser) => browser.close()));
  }
});
