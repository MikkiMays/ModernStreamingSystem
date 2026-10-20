import { solveChallenge, type Challenge } from './proof-solve';

/**
 * Фоновый поток решателя: страница и звук не замирают, пока перебираются числа.
 *
 * Тип области потока назван руками, а не подключением библиотеки `webworker`: в одном проекте с DOM
 * они спорят об одних и тех же именах.
 */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Challenge>) => void) | null;
  postMessage(value: string | null): void;
};
scope.onmessage = (event) => scope.postMessage(solveChallenge(event.data));
