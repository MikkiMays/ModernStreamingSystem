/**
 * Когда пробовать вернуть медиа на хороший путь: перезапуск ICE на живом соединении.
 *
 * ЗАЧЕМ (27.10.2026). Жалоба: «с мобильного интернета 8–10 кадров; перешёл на Wi-Fi — лучше не
 * стало, перезашёл во встречу — сразу 720p60». Воспроизведено зондом `scripts/path-probe.mjs`:
 * пропал UDP — медиа ушло на TCP, UDP вернулся — медиа так и осталось на TCP, навсегда. Причин две,
 * обе проверены опытом A/B на отдельном LiveKit:
 *
 * - сервер после обрыва ICE ставил участнику «только TCP» (`allow_tcp_fallback`) до конца сессии, и
 *   ни ICE restart, ни resume путь не возвращали — это выключено в `scripts/configure.mjs`;
 * - без такой метки браузер сам с TCP не уходит: выбранная пара живёт, пока жива, — сколько бы
 *   UDP ни было доступно. Возвращает только ICE restart: в новом раунде UDP выигрывает по приоритету.
 *
 * Поэтому, пока путь упорядоченный (TCP/TLS), ICE перезапускается: через 20 с, 40, 80 и 160 с — четыре
 * попытки, около пяти минут на эпизод. Тот же повод — отдача, которую давно душит канал: телефон,
 * подключившийся к Wi-Fi, держит прежнее соединение на сотовой сети, пока оно живо, и новый раунд ICE
 * пересаживает его на Wi-Fi. Тут первая попытка — через 45 с: узкий канал чаще просто узкий.
 * На TCP попытка — сначала проба UDP (`udp-probe.ts`): перезапуск на закрытом UDP роняет видео на минуты.
 *
 * iPhone (27.10.2026, cordcam): «мобильный интернет, 720p60, ~5 кадров; включил Wi-Fi — ничего».
 * Safari не называет причину тесноты (`qualityLimitationReason`, WebKit bug 261266), и признак
 * «канал душит» там не загорался никогда — сторож молчал. Теперь без названной причины признак — сама
 * частота (`starvedUplink`). И событие «сменилась сеть» Safari не даёт, а Wi-Fi включают в «Пункте
 * управления», не уходя со страницы: пока путь плохой (`troubled`), раз в 15 с сверяются свои сетевые
 * адреса (`local-networks.ts`) — появилась новая сеть, значит, `wake`.
 *
 * ПОЧЕМУ НЕ БЕСКОНЕЧНО. Не вышло за четыре попытки — UDP здесь закрыт или лучшего пути просто нет, и
 * пробовать до конца десятичасовой встречи — это сотня перезапусков впустую. Дальше планировщик молчит,
 * пока не случится событие, после которого путь мог стать другим (`wake`): браузер сказал о смене сети
 * (Chrome на Android), человек вернулся на страницу (на iPhone Wi-Fi включают в «Пункте управления» или
 * «Настройках» — Safari при этом уходит в фон), SDK переподключился. Тогда — новая серия, и первая
 * попытка сразу, если путь всё ещё плохой.
 *
 * На хорошем пути планировщик не делает ничего: замер — два готовых признака из статистики, которую
 * сессия и так читает раз в две секунды.
 *
 * Перезапуск ICE идёт по живому сигнальному сокету и не трогает дорожки: медиа идёт по старой паре,
 * пока новая не выбрана. Это не resume (`reconnect-plan.ts`), который закрывает сигнал, — в узком
 * канале тот хуже бездействия (R119).
 */
export interface PathSignals {
  /** ICE в `connected`: переподключение после обрыва — дело SDK, а не этого планировщика. */
  connected: boolean;
  /** Путь упорядоченный — TCP или TLS (`LinkState.ordered`). */
  ordered: boolean;
  /** Отдачу видео ограничивает канал, и это не разгон после публикации. */
  starved: boolean;
}

/** Что из плашки отдачи (`OutboundVideo`) нужно, чтобы решить, душит ли отдачу канал. */
export interface UplinkSample {
  /** `qualityLimitationReason`; `unknown` — браузер её не называет (Safari). */
  limitation: string;
  fps: number;
  targetFps: number;
  /** Сколько кадров даёт сама камера; не знаем — `undefined`. */
  sourceFps?: number;
  settling: boolean;
  dormant: boolean;
}

/**
 * Отдачу душит канал. Chrome и Firefox называют причину сами. Safari — нет, и там признак — частота:
 * меньше половины ожидаемой, а ожидаемая — выставленная, но не больше, чем даёт камера (камера на 30
 * при выставленных 60 — это не канал). Ноль кадров — камера на паузе, а не теснота.
 */
export function starvedUplink(sample: UplinkSample | null): boolean {
  if (!sample || sample.settling) return false;
  if (sample.limitation !== 'unknown') return sample.limitation === 'bandwidth';
  if (sample.dormant || sample.fps <= 0) return false;
  const expected = Math.min(sample.targetFps, sample.sourceFps || sample.targetFps);
  return sample.fps < expected / 2;
}

export const ORDERED_RETRY_MS = 20_000;
export const STARVED_RETRY_MS = 45_000;
/** Попыток на эпизод: 20 + 40 + 80 + 160 с — около пяти минут, дальше — только по событию. */
export const MAX_ATTEMPTS = 4;
/**
 * Сколько пути нужно быть хорошим, чтобы эпизод кончился. Признак «канал душит» мигает от замера к
 * замеру, и без этой минуты каждый просвет начинал бы серию заново — то есть попытки без конца.
 */
export const EPISODE_END_MS = 60_000;

export class PathRetry {
  private badSince: number | null = null;
  private goodSince: number | null = null;
  private attempts = 0;
  private nextAt = 0;
  /** Было событие, после которого путь мог стать другим: следующий плохой замер — сразу попытка. */
  private woken = false;

  /** Очередной замер пути. @returns `true` — пора перезапустить ICE. */
  observe(signals: PathSignals, now: number): boolean {
    if (!signals.connected) return false;
    if (!signals.ordered && !signals.starved) {
      this.woken = false;
      this.goodSince ??= now;
      // Минута хорошего пути заканчивает эпизод: следующий плохой начнёт серию заново.
      if (now - this.goodSince >= EPISODE_END_MS) {
        this.badSince = null;
        this.attempts = 0;
        this.nextAt = 0;
      }
      return false;
    }
    this.goodSince = null;
    this.badSince ??= now;
    if (this.woken) {
      this.woken = false;
      this.attempts = 0;
      return this.attempt(signals, now);
    }
    const wait = signals.ordered ? ORDERED_RETRY_MS : STARVED_RETRY_MS;
    if (this.attempts >= MAX_ATTEMPTS || now - this.badSince < wait || now < this.nextAt) return false;
    return this.attempt(signals, now);
  }

  /** Путь сейчас плохой или был плохим меньше минуты назад: стоит следить, не появилась ли другая сеть. */
  get troubled() {
    return this.badSince !== null;
  }

  /** Сменилась сеть, вернулись на страницу, SDK переподключился — путь мог стать другим. */
  wake() {
    this.woken = true;
  }

  private attempt(signals: PathSignals, now: number) {
    const wait = signals.ordered ? ORDERED_RETRY_MS : STARVED_RETRY_MS;
    this.attempts++;
    this.nextAt = now + wait * 2 ** this.attempts;
    return true;
  }
}
