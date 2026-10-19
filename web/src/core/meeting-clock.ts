/**
 * Время встречи в шапке (T35, П7).
 *
 * ОТКУДА ОТСЧЁТ. Не от создания комнаты и не от своего входа: встреча начинается, когда в ней
 * двое живых людей. Этот момент ставит ядро — `Snapshot.startedAt`, боты не считаются, — и он один
 * на всех: у каждого в шапке одно и то же время, сколько бы кто ни переподключался.
 *
 * ПО ЧЬИМ ЧАСАМ. Разница считается по часам сервера (`Meeting.serverNow()`), как якорь кинозала:
 * часы участников расходятся на минуты, и у кого-то встреча шла бы «−2:13».
 *
 * Поле читается защитно, как `media/capabilities.ts`: ядро до пакета WP1 его не присылает, и тогда
 * времени в шапке просто нет — без нуля, который выглядел бы как «встреча только что началась».
 */
export function readStartedAt(snapshot: unknown): number | null {
  const value = (snapshot as { startedAt?: unknown } | null | undefined)?.startedAt;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

const two = (value: number) => String(value).padStart(2, '0');

/** `MM:SS`, а с часа — `Ч:ММ:СС`. Отрицательное (часы ещё не сошлись) — ноль. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${two(minutes)}:${two(seconds)}`;
}

/** Для диктора и подсказки: «1 ч 5 мин», «12 мин», «меньше минуты». */
export function spokenDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'меньше минуты';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} мин`;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}
