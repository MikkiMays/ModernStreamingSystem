/**
 * Идёт ли во вкладке встреча — без импорта самой встречи (`core/meeting.ts` грузится лениво, и тянуть её
 * в главный модуль ради одного вопроса нельзя). `Meeting` отмечается здесь в конструкторе и в `dispose`.
 * Нужно тому, кто решает, можно ли перезагрузить страницу ради новой сборки (`ui/lazy-part.tsx`):
 * перезагрузка посреди встречи оборвала бы разговор.
 */
let live = 0;

export function meetingStarted() {
  live += 1;
}

export function meetingEnded() {
  live = Math.max(0, live - 1);
}

export function inMeeting() {
  return live > 0;
}
