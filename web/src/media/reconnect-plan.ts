/**
 * Что делать с медиасоединением, когда сеть подала знак.
 *
 * ЗАЧЕМ (T50). SDK LiveKit чинит связь сам — новый сигнальный WS и ICE restart на тех же
 * дорожках (`resumeConnection`), — но **замечает** обрыв поздно: сигнал — по таймауту пинга
 * (порядка пятнадцати секунд), медиа — только когда ICE дошёл до `failed`, а не `disconnected`.
 * Включение или выключение VPN меняет адрес, старый путь мёртв, а браузер при этом остаётся
 * «online» и SDK — «connected». Пока он это понимает, окно восстановления в двадцать секунд
 * почти кончается — отсюда «не всегда корректно и быстро».
 *
 * Знаков у нас четыре: `online` браузера (клиент Windows превращает в него свой `network.changed`
 * при смене адреса), ICE в `disconnected` по статистике, которую сессия и так опрашивает,
 * возвращение к экрану и возвращение **из заморозки** (`woke`, E12): телефон останавливал JS
 * страницы, пинги сигнала не уходили, и сокет, который SDK считает живым, скорее всего уже закрыт
 * сервером — ждать таймаута пинга незачем. Ответ — один из трёх:
 *
 * - `resume` — попросить SDK пройти свой бесшовный путь прямо сейчас: сигнал переоткрывается,
 *   ICE перезапускается, дорожки и SSRC у зрителей те же. На живом соединении это почти
 *   бесплатно, поэтому толчок по знаку сети делается без проверки, но не чаще раза в несколько
 *   секунд — два толчка подряд не ускорят, а помешают;
 * - `connect` — SDK сдался (`disconnected`), идёт наше окно восстановления, и ждать очередной
 *   попытки по расписанию незачем: как и раньше, подключаемся заново с новым токеном;
 * - `none` — SDK уже переподключается (там свой `online`-обработчик с немедленной попыткой) или
 *   ещё только подключается; возвращение к экрану само по себе не повод перезапускать ICE: пока
 *   страница была скрыта, JS работал, и обрыв SDK заметил бы сам. Повод — только заморозка.
 */
export type ReconnectTrigger = 'online' | 'ice-disconnected' | 'visible' | 'woke';
export type ReconnectAction = 'resume' | 'connect' | 'none';

export interface ReconnectSignals {
  trigger: ReconnectTrigger;
  /** `Room.state` SDK. */
  sdk: string;
  /** Идёт ли наше окно восстановления. */
  recovering: boolean;
  /** Идёт ли наш полный `connect` прямо сейчас. */
  connecting: boolean;
  /** Сколько прошло с прошлого толчка `resume`. */
  sinceNudgeMs: number;
}

/** Чаще толкать незачем: resume на живом соединении занимает секунду-две. */
export const NUDGE_INTERVAL_MS = 3000;

export function reconnectAction(signals: ReconnectSignals): ReconnectAction {
  if (signals.sdk === 'disconnected') return signals.recovering && !signals.connecting ? 'connect' : 'none';
  if (signals.sdk !== 'connected' || signals.trigger === 'visible') return 'none';
  return signals.sinceNudgeMs >= NUDGE_INTERVAL_MS ? 'resume' : 'none';
}
