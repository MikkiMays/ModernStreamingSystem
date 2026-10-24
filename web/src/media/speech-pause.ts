/**
 * Дождаться паузы говорящего (R107).
 *
 * Зачем. После «пробки» в сети буфер речи раздут на секунду и больше, и NetEq догоняет его
 * десятки секунд — разговор становится рацией. Переподписка ставит всё на место за долю секунды,
 * но это провал звука: посреди слова он и есть «звук говорящего обрезается». Поэтому переподписка
 * ждёт паузы: громкость в заголовках пришедших пакетов (`getSynchronizationSources`, обновляется
 * каждым пакетом — раз в 20 мс) читается раз в `stepMs`, и пауза — это `quietMs` подряд тише
 * `level`. Не дождались за `withinMs` — не переподписываем: NetEq догонит сам, а провал посреди
 * фразы хуже.
 */
export interface PauseOptions {
  /** Тише этого (0…1) — тишина. */
  level?: number;
  /** Сколько тишины подряд считать паузой. */
  quietMs?: number;
  /** Как часто смотреть. */
  stepMs?: number;
  /** Сколько ждать паузы вообще. */
  withinMs?: number;
  signal?: AbortSignal;
}

export const PAUSE_LEVEL = 0.01;

export function waitForPause(read: () => number | undefined, options: PauseOptions = {}): Promise<boolean> {
  const level = options.level ?? PAUSE_LEVEL;
  const quietMs = options.quietMs ?? 300;
  const stepMs = options.stepMs ?? 100;
  const withinMs = options.withinMs ?? 10000;
  return new Promise((resolve) => {
    let waited = 0;
    let quiet = 0;
    const timer = setInterval(() => {
      if (options.signal?.aborted) return finish(false);
      waited += stepMs;
      const value = read();
      // Нет пакетов вовсе (DTX молчит, а не канал умер — это решает playout) — тоже тишина.
      quiet = value === undefined || value < level ? quiet + stepMs : 0;
      if (quiet >= quietMs) return finish(true);
      if (waited >= withinMs) return finish(false);
    }, stepMs);
    const finish = (ok: boolean) => {
      clearInterval(timer);
      resolve(ok);
    };
  });
}

/** Громкость последнего пришедшего пакета дорожки (RFC 6464), если браузер её знает. */
export function receivedLevel(receiver: RTCRtpReceiver | undefined): number | undefined {
  try {
    const sources = receiver?.getSynchronizationSources?.() ?? [];
    const latest = sources.reduce<RTCRtpSynchronizationSource | undefined>(
      (best, source) => (!best || source.timestamp > best.timestamp ? source : best),
      undefined,
    );
    return latest?.audioLevel;
  } catch {
    return undefined;
  }
}
