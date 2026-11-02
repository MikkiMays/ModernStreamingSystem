import { HoldGate, opusStereo, type HoldMessage } from './receive-hold-core';

/**
 * Поток преобразования принятого звука (RTCRtpScriptTransform): кадры идут насквозь, начало каждого
 * стерео-потока придерживается до полного запаса и уходит пачкой (`receive-hold-core.ts`, R182).
 *
 * Любая ошибка разбора — кадр уходит как есть: этот поток стоит на пути всего принятого звука, и
 * сломаться в нём значит оставить встречу без звука.
 *
 * Тип области потока назван руками, а не подключением библиотеки `webworker`: в одном проекте с DOM
 * они спорят об одних и тех же именах (как в `core/proof.worker.ts`).
 */

interface EncodedAudioFrame {
  data: ArrayBuffer;
  /** Старое имя метки RTP (Firefox, Safari); новое — `rtpTimestamp` в метаданных. */
  timestamp?: number;
  getMetadata(): {
    synchronizationSource?: number;
    rtpTimestamp?: number;
    mimeType?: string;
    payloadType?: number;
  };
}
interface Transformer {
  readable: ReadableStream<EncodedAudioFrame>;
  writable: WritableStream<EncodedAudioFrame>;
  options?: { id?: number; holdMs?: number };
}

const scope = self as unknown as {
  onrtctransform: ((event: { transformer: Transformer }) => void) | null;
  onmessage: ((event: MessageEvent<HoldMessage>) => void) | null;
};

/** Опус внутри RED: номер типа 63 у SFU и браузеров (`services/publisher/red.go`). */
const RED_PAYLOAD = 63;

const gates = new Map<
  number,
  { gate: HoldGate<EncodedAudioFrame>; emit: (frames: EncodedAudioFrame[]) => void }
>();
let defaultHold = 0;

scope.onrtctransform = ({ transformer }) => {
  const id = transformer.options?.id ?? -1;
  const gate = new HoldGate<EncodedAudioFrame>(transformer.options?.holdMs ?? defaultHold);
  let output: TransformStreamDefaultController<EncodedAudioFrame> | null = null;
  const emit = (frames: EncodedAudioFrame[]) => {
    for (const frame of frames) output?.enqueue(frame);
  };
  gates.set(id, { gate, emit });
  void transformer.readable
    .pipeThrough(
      new TransformStream<EncodedAudioFrame, EncodedAudioFrame>({
        start(controller) {
          output = controller;
        },
        transform(frame, controller) {
          let out: EncodedAudioFrame[];
          try {
            const meta = frame.getMetadata();
            const red = meta.mimeType === 'audio/red' || meta.payloadType === RED_PAYLOAD;
            const rtpTimestamp = meta.rtpTimestamp ?? frame.timestamp;
            out = gate.push(frame, {
              ssrc: meta.synchronizationSource ?? 0,
              rtpTimestamp: rtpTimestamp ?? 0,
              // Без метки RTP запас не сосчитать — тогда не держим вовсе.
              stereo: rtpTimestamp === undefined ? null : opusStereo(new Uint8Array(frame.data), red),
              arrivalMs: performance.now(),
            });
          } catch {
            out = [...gate.release(), frame];
          }
          for (const item of out) controller.enqueue(item);
        },
      }),
    )
    .pipeTo(transformer.writable)
    .catch(() => {})
    .finally(() => gates.delete(id));
};

scope.onmessage = ({ data }) => {
  if (data.type === 'hold') {
    if (data.id !== undefined) gates.get(data.id)?.gate.setHold(data.ms);
    else {
      defaultHold = data.ms;
      for (const { gate } of gates.values()) gate.setHold(data.ms);
    }
  } else if (data.type === 'release') {
    const entry = gates.get(data.id);
    entry?.emit(entry.gate.release());
  }
};
