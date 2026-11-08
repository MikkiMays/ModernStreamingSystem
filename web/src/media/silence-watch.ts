/**
 * Входящее молчание при «живом» соединении — признак сменившегося без события адреса (VPN посреди
 * встречи, R195 §6.3), и ответ на него — один `resume`.
 *
 * ЧТО СЧИТАЕТСЯ ЖИЗНЬЮ. **Не RTP.** В обычной тихой встрече байты медиа не идут вовсе: SFU не пересылает
 * дорожки с выключенным микрофоном (Cord глушит, а не снимает публикацию — подписка остаётся), а
 * `adaptiveStream` ставит видео на паузу у скрытой вкладки и плитки вне экрана. Меряй по RTP — и каждые
 * 4–6 с шёл бы `signal-reconnect` со всеми его ICE restart и «восстанавливаем связь» (ревью R195).
 * Жизнь пути — это **счётчики выбранной пары кандидатов**: STUN consent и keepalive идут всегда, пока путь
 * жив (Chrome пингует стабильную пару раз в ≈ 2,5 с). Жив, если за окно выросли либо байты RTP, либо
 * `requestsReceived + responsesReceived` пары. Окно {@link SILENCE_MS} — 6 с: два пинга и запас на опрос
 * статистики раз в 2 с.
 *
 * Скрытая вкладка не считается: там браузер душит и таймеры, и статистику, а медиа всё равно на паузе.
 * Эпизод кончается только когда жизнь снова увидена — переподключение само по себе флаг не снимает:
 * иначе каждый `connected()` открывал бы дорогу следующему толчку.
 */
export const SILENCE_MS = 6000;

/**
 * Молчание короче {@link SILENCE_MS}, о котором стоит сказать ядру (R200 §5.3, Р-105): `media.stall` —
 * подсказка, без действий у клиента. Ядро складывает её с промахами своего опроса узла: половина людей
 * узла молчит и узел не отвечает — узел мёртв, переезд за ≈ 5 с вместо 15. Порог 5 с: один человек с
 * плохим Wi-Fi ничего не решает, а замирание хоста на 2–4 с не успевает дать жалобу вовсе. Опрос
 * статистики идёт раз в 2 с, поэтому подсказка уходит через 5–7 с после последней увиденной жизни.
 */
export const STALL_MS = 5000;

/** Что сказать ядру после очередного опроса: началось молчание, вернулась жизнь, или ничего нового. */
export type Stall = 'begin' | 'end' | null;

export interface SilenceSample {
  now: number;
  /** Сумма `bytesReceived` по `inbound-rtp` всех отчётов (`inboundBytes`). */
  rtpBytes: number;
  /** Счётчики STUN выбранной пары ({@link transportKeepalives}). */
  keepalives: number;
  /** `document.hidden`. */
  hidden: boolean;
  /** SDK считает комнату подключённой. */
  connected: boolean;
  /** ICE в `connected`. */
  iceConnected: boolean;
  /** Есть хоть одна подписка на чужую дорожку — иначе молчание нормально. */
  subscribed: boolean;
}

/**
 * STUN-счётчики пути: `requestsReceived + responsesReceived` выбранной (nominated/selected) пары. Отчёты
 * разных дорожек описывают один транспорт, поэтому берётся максимум, а не сумма.
 */
export function transportKeepalives(reports: readonly RTCStatsReport[]): number {
  let best = 0;
  for (const report of reports) {
    let selectedId: string | undefined;
    report.forEach((stat) => {
      if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string')
        selectedId = stat.selectedCandidatePairId;
    });
    report.forEach((stat) => {
      if (stat.type !== 'candidate-pair') return;
      const chosen = selectedId ? stat.id === selectedId : stat.nominated === true || stat.selected === true;
      if (!chosen) return;
      const total = (Number(stat.requestsReceived) || 0) + (Number(stat.responsesReceived) || 0);
      if (total > best) best = total;
    });
  }
  return best;
}

export class SilenceWatch {
  private lastAliveAt: number | null = null;
  private lastRtp: number | null = null;
  private lastKeepalives: number | null = null;
  private nudged = false;
  private stalled = false;
  private last: SilenceSample | null = null;
  /**
   * Браузер отдаёт STUN-счётчики пары. Не отдаёт (так бывает в Firefox) — молчание ни о чём не говорит: в
   * тихой встрече RTP стоит законно, и толчок был бы ложным. Тогда обрыв ловит ICE `disconnected` и `online`.
   */
  private keepalivesSeen = false;

  /** Очередной опрос статистики. @returns `true` — пора просить resume (один раз на эпизод). */
  observe(sample: SilenceSample): boolean {
    // Любое изменение счётчиков — жизнь: рост, а после переподключения — и сброс к нулю.
    const alive =
      (this.lastRtp !== null && sample.rtpBytes !== this.lastRtp) ||
      (this.lastKeepalives !== null && sample.keepalives !== this.lastKeepalives);
    if (sample.keepalives > 0) this.keepalivesSeen = true;
    this.lastRtp = sample.rtpBytes;
    this.lastKeepalives = sample.keepalives;
    this.last = sample;
    if (this.lastAliveAt === null || alive) {
      this.lastAliveAt = sample.now;
      if (alive) this.nudged = false;
      return false;
    }
    if (sample.hidden || this.nudged || !this.keepalivesSeen) return false;
    if (!sample.connected || !sample.iceConnected || !sample.subscribed) return false;
    if (sample.now - this.lastAliveAt < SILENCE_MS) return false;
    this.nudged = true;
    return true;
  }

  /**
   * После {@link observe}: пора ли сказать ядру о молчании (`begin`, один раз на эпизод) или о том,
   * что жизнь после молчания вернулась (`end`). Те же условия, что у толчка, но порог {@link STALL_MS}.
   */
  stall(): Stall {
    const sample = this.last;
    if (!sample || this.lastAliveAt === null) return null;
    if (this.stalled) {
      if (this.lastAliveAt !== sample.now) return null;
      this.stalled = false;
      return 'end';
    }
    if (sample.hidden || !this.keepalivesSeen) return null;
    if (!sample.connected || !sample.iceConnected || !sample.subscribed) return null;
    if (sample.now - this.lastAliveAt < STALL_MS) return null;
    this.stalled = true;
    return 'begin';
  }

  /** Новое соединение: отсчёт молчания — от него; эпизод не снимается, его снимает только жизнь. */
  reset(now: number) {
    this.lastAliveAt = now;
    this.lastRtp = null;
    this.lastKeepalives = null;
    this.stalled = false;
    this.last = null;
  }
}
