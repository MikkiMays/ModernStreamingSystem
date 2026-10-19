import type { Participant } from '../api/types';

/**
 * Кто во встрече живой человек — одно правило на все счётчики (T35, П3).
 *
 * Бот музыки, Telegram и любая другая интеграция приходят в снимок участником с полем `service`.
 * Это не люди: ни в числе участников, ни в «пора кого-нибудь позвать», ни в отсчёте встречи их
 * считать нельзя. Раньше каждый счётчик решал это сам — и подсказка «Самое время пригласить
 * своих» пропадала, стоило включить музыку: вдвоём с ботом комната переставала быть пустой.
 * Ядро держит то же правило (`occupiesSeat` без `service`), здесь — его единственная копия в вебе.
 */
type Person = Pick<Participant, 'service' | 'status'>;

/** Люди без ботов и интеграций — включая тех, кто ждёт у входа. */
export function humans<T extends Person>(participants: readonly T[]): T[] {
  return participants.filter((person) => !person.service);
}

/** Люди, которые уже во встрече: без ботов и без ждущих допуска. */
export function presentHumans<T extends Person>(participants: readonly T[]): T[] {
  return participants.filter((person) => !person.service && person.status !== 'WAITING');
}
