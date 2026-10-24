import './seat-rings.css';
import type { Meeting } from '../core/meeting';

/**
 * Кольцо хода — одно на покер и дурака (R110).
 *
 * ЧАСЫ ИДУТ ОТ СЕРВЕРА. Начало и конец хода — метки ядра (`actionAt`, `deadline`), а «сейчас» —
 * часы сервера в браузере (`meeting.serverNow()`, со сдвигом от часов этой машины). Поэтому кольцо
 * у всех за столом и у зрителей сматывается одинаково, и кончается ровно тогда, когда ход решит
 * ядро, — а не тогда, когда так показалось локальным часам.
 *
 * Это чистая CSS-анимация с задержкой: длительность — весь ход, задержка — сколько до его начала
 * (отрицательная, если ход уже идёт; положительная, пока карты ещё летят при раздаче). Ни одного
 * кадра не считает JavaScript, и кольцо не дёргается, когда браузер занят видео. Новый ход того же
 * места (подкинул ещё — срок заново) — новый ключ: анимация начинается сначала, а не с конца.
 */
export function TurnRing({
  meeting,
  actionAt,
  deadline,
}: {
  meeting: Pick<Meeting, 'serverNow'>;
  actionAt: number;
  deadline: number;
}) {
  const { duration, delay } = turnRingTiming(actionAt, deadline, meeting.serverNow());
  return (
    <svg className="turn-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle className="turn-ring-track" cx="50" cy="50" r="46" />
      <circle
        key={actionAt}
        className="turn-ring-run"
        cx="50"
        cy="50"
        r="46"
        style={{ animationDuration: `${duration}ms`, animationDelay: `${delay}ms` }}
      />
    </svg>
  );
}

/** Длительность и задержка кольца по меткам ядра и часам сервера. */
export function turnRingTiming(actionAt: number, deadline: number, now: number) {
  return { duration: Math.max(1, deadline - actionAt), delay: actionAt - now };
}
