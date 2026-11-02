/**
 * Музыка у вошедшего посреди трека — с первой секунды чистая (R182).
 *
 * ЧТО БЫЛО. Вошедший во встречу, где уже играет музыка, первые шесть секунд слышал её «плывущей» и с
 * шумом. Живой замер на стенде 02.11.2026 (запись того, что уходит в динамик, `e2e/media/music-join.spec.ts`):
 * темп 0,90–0,93, THD+N −12…−27 дБ вместо −46, и так при первом входе, после перезагрузки и после
 * выхода и входа. Причина — в буфере приёма: NetEq начинает играть с первого же пакета, а запас до
 * цели (600 мс у музыки, `playout.ts`) набирает, растягивая звук на 8–10 %. У того, кто был во встрече
 * до первой ноты, запас набирался на тишине издателя — неслышно; у вошедшего — посреди музыки.
 *
 * ЧТО ТЕПЕРЬ. Начало каждой принятой стерео-дорожки (музыка, звук показа) придерживается до полного
 * запаса и отдаётся декодеру пачкой: NetEq стартует с полным буфером, растягивать нечего. Музыка
 * звучит на 0,6 с позже — и сразу чисто (замер: темп 1,000, THD+N на уровне кодека с первой секунды).
 * Речь — моно (R113) — идёт насквозь: держать её незачем, а задержка разговора дороже.
 *
 * КАК. Держит поток кадров `RTCRtpScriptTransform` (`receive-hold.worker.ts`). Ставить его можно только
 * на трансивер **до** договора: LiveKit 2.22 в режиме одного соединения принимает звук на секциях
 * `recvonly`, которые сам добавляет в своё предложение, и Chrome не применяет преобразование, поставленное
 * на такой приёмник позже (проверено: ни в `ontrack`, ни через секунды ни одного кадра в поток не
 * приходит). Поэтому здесь перехватывается `addTransceiver`: каждой новой секции приёма звука сразу
 * ставится преобразование. Чего браузер не умеет (нет `RTCRtpScriptTransform`, поток не создался) —
 * звук идёт, как шёл.
 */
import type { HoldMessage } from './receive-hold-core';

/**
 * Насколько держать меньше цели запаса. Пачка приносит декодеру больше, чем её размах по меткам: ещё
 * сам последний кадр и до двух повторов RED (20–60 мс), — а всё выше цели NetEq сожмёт ускорением.
 * Замер 02.11.2026 (цель 600): держали 640 — первые 0,8 с NetEq ускорял звук на 7–8 %, 580 — запас
 * 610 мс с первой секунды, ни сжатия, ни растяжения; 560 — немного растяжения в начале.
 */
export const HOLD_BELOW_TARGET_MS = 20;

/** Сколько держать начало стерео-дорожки, чтобы NetEq начал ровно с цели `targetMs`. */
export const holdFor = (targetMs: number) => Math.max(0, targetMs - HOLD_BELOW_TARGET_MS);

let installed = false;
let worker: Worker | null = null;
let nextId = 0;
let holdMs = 0;
const ids = new WeakMap<RTCRtpReceiver, number>();

const post = (message: HoldMessage) => {
  try {
    worker?.postMessage(message);
  } catch {
    // поток умер — кадры идут насквозь, держать нечем
  }
};

function supported() {
  return (
    typeof window !== 'undefined' &&
    typeof RTCPeerConnection !== 'undefined' &&
    typeof RTCRtpScriptTransform === 'function' &&
    typeof Worker !== 'undefined'
  );
}

/**
 * Поставить перехват один раз на страницу — до того, как LiveKit создаст соединение. Повторный вызов
 * ничего не делает.
 */
export function installReceiveHold() {
  if (installed || !supported()) return;
  installed = true;
  try {
    worker = new Worker(new URL('./receive-hold.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return;
  }
  const original = RTCPeerConnection.prototype.addTransceiver;
  RTCPeerConnection.prototype.addTransceiver = function addTransceiver(
    this: RTCPeerConnection,
    trackOrKind: MediaStreamTrack | string,
    init?: RTCRtpTransceiverInit,
  ) {
    const transceiver = original.call(this, trackOrKind, init);
    if (worker && trackOrKind === 'audio' && init?.direction === 'recvonly') {
      try {
        const id = nextId++;
        transceiver.receiver.transform = new RTCRtpScriptTransform(worker, { id, holdMs });
        ids.set(transceiver.receiver, id);
      } catch {
        // браузер не принял преобразование — секция работает без него
      }
    }
    return transceiver;
  } as typeof original;
}

/**
 * Сколько держать начало новой стерео-дорожки (`holdFor` цели запаса музыки). Без приёмника — для всех
 * новых секций и потоков; с приёмником — для этой дорожки (её цель могла уже вырасти).
 */
export function setReceiveHold(ms: number, receiver?: RTCRtpReceiver) {
  const value = Math.max(0, Math.round(ms));
  if (!receiver) {
    holdMs = value;
    post({ type: 'hold', ms: value });
    return;
  }
  const id = ids.get(receiver);
  if (id !== undefined) post({ type: 'hold', ms: value, id });
}

/** Дорожка оказалась речью (стерео от старого клиента): отдать придержанное сейчас. */
export function releaseReceiveHold(receiver: RTCRtpReceiver | undefined) {
  const id = receiver ? ids.get(receiver) : undefined;
  if (id !== undefined) post({ type: 'release', id });
}

/** Стоит ли преобразование на этом приёмнике — для диагностики и замеров. */
export function holdsReceiver(receiver: RTCRtpReceiver | undefined) {
  return !!receiver && ids.has(receiver);
}
