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
 * Поэтому, пока путь упорядоченный (TCP/TLS), ICE перезапускается: первый раз через 20 с, дальше
 * с удвоением до пяти минут — в сети, где UDP закрыт насовсем, попытки редеют, а не дёргают
 * разговор. Тот же повод — отдача, которую давно душит канал: телефон, подключившийся к Wi-Fi,
 * держит прежнее соединение на сотовой сети, пока оно живо, и новый раунд ICE пересаживает его
 * на Wi-Fi. Тут ждём дольше — 45 с: узкий канал чаще просто узкий.
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

export const ORDERED_RETRY_MS = 20_000;
export const STARVED_RETRY_MS = 45_000;
export const MAX_RETRY_MS = 300_000;
/** Сколько пути нужно быть хорошим, чтобы забыть прошлые попытки и снова начать с короткой паузы. */
export const FORGET_AFTER_MS = 120_000;

export class PathRetry {
  private badSince: number | null = null;
  private goodSince: number | null = null;
  private attempts = 0;
  private nextAt = 0;

  /** Очередной замер пути. @returns `true` — пора перезапустить ICE. */
  observe(signals: PathSignals, now: number): boolean {
    if (!signals.connected) return false;
    if (!signals.ordered && !signals.starved) {
      this.badSince = null;
      this.goodSince ??= now;
      if (now - this.goodSince >= FORGET_AFTER_MS) {
        this.attempts = 0;
        this.nextAt = 0;
      }
      return false;
    }
    this.goodSince = null;
    this.badSince ??= now;
    const wait = signals.ordered ? ORDERED_RETRY_MS : STARVED_RETRY_MS;
    if (now - this.badSince < wait || now < this.nextAt) return false;
    this.attempts++;
    this.nextAt = now + Math.min(MAX_RETRY_MS, wait * 2 ** this.attempts);
    return true;
  }
}
