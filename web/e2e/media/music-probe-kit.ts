/**
 * Общее для живых замеров звука R182: ответвление того, что уходит в динамик, статистика приёма и
 * запись WAV. Используют `music-join.spec.ts` и отдельные сценарии слушателя.
 */
import type { Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';

export const pcHook = () => {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  (window as any).__pcs = [];
  class Wrapped extends Native {
    constructor(...a: any[]) {
      super(...(a as [RTCConfiguration?]));
      (window as any).__pcs.push(this);
    }
  }
  window.RTCPeerConnection = Wrapped as any;
};

/** Ответвление от всего, что подключено к `destination` каждого `AudioContext` страницы. */
export const tapHook = () => {
  const W = window as any;
  if (W.__taps) return;
  W.__taps = [];
  const source = `class T extends AudioWorkletProcessor {
    constructor() { super(); this.buf = []; this.n = 0; this.on = true;
      this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
    process(inputs) {
      const i = inputs[0] || [];
      const c = i.length;
      const l = new Float32Array(128), r = new Float32Array(128);
      if (c) { l.set(i[0]); r.set(c > 1 ? i[1] : i[0]); }
      this.buf.push(currentFrame, c, l, r);
      if (++this.n >= 40) { this.port.postMessage(this.buf); this.buf = []; this.n = 0; }
      return this.on;
    }
  }
  registerProcessor('cord-tap', T);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
  const Native = window.AudioContext;
  const connect = AudioNode.prototype.connect as any;
  const disconnect = AudioNode.prototype.disconnect as any;
  const setup = (ctx: AudioContext, options: any) => {
    const tap: any = {
      ctx,
      options,
      node: null,
      pending: [],
      chunks: [],
      created: Date.now(),
      dest: new Set(),
      maxDest: 0,
      events: [],
    };
    W.__taps.push(tap);
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        const node = new AudioWorkletNode(ctx, 'cord-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
        });
        node.port.onmessage = (e) => tap.chunks.push(e.data);
        tap.node = node;
        for (const [n, o] of tap.pending) connect.call(n, node, o);
        tap.pending = [];
      })
      .catch((e: unknown) => (tap.error = String(e)));
    return tap;
  };
  class Wrapped extends Native {
    constructor(options?: AudioContextOptions) {
      super(options);
      (this as any).__tap = setup(this, options ?? null);
    }
  }
  window.AudioContext = Wrapped as any;
  AudioNode.prototype.connect = function (this: AudioNode, dest: any, ...rest: any[]) {
    const result = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const tap = (this.context as any).__tap;
      if (tap) {
        tap.dest.add(this);
        tap.maxDest = Math.max(tap.maxDest, tap.dest.size);
        tap.events.push([Date.now(), 'connect', this.constructor.name, tap.dest.size]);
        if (tap.node) connect.call(this, tap.node, rest[0] ?? 0);
        else tap.pending.push([this, rest[0] ?? 0]);
      }
    }
    return result;
  } as any;
  AudioNode.prototype.disconnect = function (this: AudioNode, ...args: any[]) {
    const result = disconnect.apply(this, args);
    const tap = (this.context as any)?.__tap;
    if (tap && (args.length === 0 || args[0] instanceof AudioDestinationNode) && tap.dest.delete(this)) {
      tap.events.push([Date.now(), 'disconnect', this.constructor.name, tap.dest.size]);
      if (args.length && tap.node)
        try {
          disconnect.call(this, tap.node);
        } catch {
          // уже отключён
        }
    }
    return result;
  } as any;
};

export async function sample(page: Page) {
  return page.evaluate(async () => {
    const W = window as any;
    const rows: any[] = [];
    for (const pc of (W.__pcs ?? []) as RTCPeerConnection[]) {
      if (pc.connectionState === 'closed') continue;
      const targets = new Map<string, number | null>();
      const transforms = new Map<string, boolean>();
      for (const r of pc.getReceivers())
        if (r.track?.kind === 'audio') {
          targets.set(r.track.id, (r as any).jitterBufferTarget ?? null);
          transforms.set(r.track.id, !!(r as any).transform);
        }
      const report = await pc.getStats();
      const codecs = new Map<string, string>();
      report.forEach((s: any) => {
        if (s.type === 'codec') codecs.set(s.id, `${s.mimeType}/${s.channels ?? ''} ${s.sdpFmtpLine ?? ''}`);
      });
      report.forEach((s: any) => {
        if (s.type !== 'inbound-rtp' || s.kind !== 'audio') return;
        rows.push({
          track: s.trackIdentifier,
          mid: s.mid,
          codec: codecs.get(s.codecId),
          target: targets.get(s.trackIdentifier) ?? null,
          transform: transforms.get(s.trackIdentifier) ?? false,
          ts: s.timestamp,
          packets: s.packetsReceived,
          lost: s.packetsLost,
          discarded: s.packetsDiscarded,
          jitter: s.jitter,
          jbDelay: s.jitterBufferDelay,
          jbTargetDelay: s.jitterBufferTargetDelay,
          jbMinDelay: s.jitterBufferMinimumDelay,
          jbEmitted: s.jitterBufferEmittedCount,
          total: s.totalSamplesReceived,
          concealed: s.concealedSamples,
          silentConcealed: s.silentConcealedSamples,
          events: s.concealmentEvents,
          decel: s.insertedSamplesForDeceleration,
          accel: s.removedSamplesForAcceleration,
          level: s.audioLevel,
          energy: s.totalAudioEnergy,
          duration: s.totalSamplesDuration,
          playout: s.playoutId,
        });
      });
      report.forEach((s: any) => {
        if (s.type === 'media-playout')
          rows.push({
            playoutStats: true,
            synthesized: s.synthesizedSamplesDuration,
            synthesizedEvents: s.synthesizedSamplesEvents,
            totalDuration: s.totalSamplesDuration,
            delay: s.totalPlayoutDelay,
            count: s.totalSamplesCount,
          });
      });
    }
    const audios = [...document.querySelectorAll('audio')].map((a) => ({
      muted: a.muted,
      volume: a.volume,
      paused: a.paused,
      tracks: ((a.srcObject as MediaStream | null)?.getAudioTracks() ?? []).map((t) => t.id),
    }));
    const taps = ((W.__taps ?? []) as any[]).map((t) => ({
      rate: t.ctx.sampleRate,
      state: t.ctx.state,
      base: t.ctx.baseLatency,
      output: t.ctx.outputLatency,
      dest: t.dest.size,
      maxDest: t.maxDest,
      stats: t.ctx.playbackStats
        ? {
            underrun: t.ctx.playbackStats.underrunDuration,
            underrunEvents: t.ctx.playbackStats.underrunEvents,
            total: t.ctx.playbackStats.totalDuration,
          }
        : t.ctx.playoutStats
          ? {
              fallback: t.ctx.playoutStats.fallbackFramesDuration,
              fallbackEvents: t.ctx.playoutStats.fallbackFramesEvents,
              total: t.ctx.playoutStats.totalFramesDuration,
            }
          : null,
    }));
    return { at: Date.now(), rows, audios, taps };
  });
}

/** Сырые отсчёты всех ответвлений страницы с отметкой стенных часов начала. */
export async function harvest(page: Page) {
  return page.evaluate(() => {
    const W = window as any;
    const out: any[] = [];
    for (const tap of (W.__taps ?? []) as any[]) {
      const chunks = tap.chunks as any[][];
      tap.chunks = [];
      let frames = 0;
      for (const c of chunks) frames += (c.length / 4) * 128;
      const pcm = new Float32Array(frames * 2);
      let at = 0;
      let first: number | null = null;
      let gaps = 0;
      let expected: number | null = null;
      let channels = 0;
      for (const c of chunks)
        for (let i = 0; i < c.length; i += 4) {
          const frame = c[i] as number;
          if (first === null) first = frame;
          if (expected !== null && frame !== expected) gaps++;
          expected = frame + 128;
          channels = Math.max(channels, c[i + 1] as number);
          const l = c[i + 2] as Float32Array;
          const r = c[i + 3] as Float32Array;
          for (let k = 0; k < 128; k++) {
            pcm[at++] = l[k]!;
            pcm[at++] = r[k]!;
          }
        }
      const bytes = new Uint8Array(pcm.buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({
        rate: tap.ctx.sampleRate,
        options: tap.options,
        created: tap.created,
        firstFrame: first,
        gaps,
        channels,
        maxDest: tap.maxDest,
        events: tap.events,
        error: tap.error ?? null,
        data: btoa(binary),
      });
    }
    return out;
  });
}

export function wav(path: string, rate: number, base64: string) {
  const data = Buffer.from(base64, 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}
