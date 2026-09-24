import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ApiError } from '../../../api/client';
import { Failure, problemText } from './notes';

/*
  Отказ в каталоге — словами для человека: служба говорит своими, а обрыв сети браузер называет
  по-английски, и каждый браузер по-своему.
*/

afterEach(cleanup);

it('обрыв сети — по-русски, какими бы словами его ни назвал браузер', () => {
  for (const message of [
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Load failed',
    'Network request failed',
  ])
    expect(problemText(new TypeError(message))).toBe('Нет связи с сервером — попробуйте ещё раз');
  expect(problemText(new DOMException('signal timed out', 'TimeoutError'))).toBe(
    'Сервер не ответил вовремя — попробуйте ещё раз',
  );
});

it('отказ службы остаётся её словами, а прочие ошибки — своим текстом', () => {
  expect(problemText(new ApiError(429, 'REQUEST_FAILED', 'Комната слишком часто разбирает ссылки'))).toBe(
    'Комната слишком часто разбирает ссылки',
  );
  expect(problemText(new TypeError('x is not a function'))).toBe('x is not a function');
  expect(problemText(null)).toBe('Не удалось выполнить запрос');
});

it('Failure показывает то же, что problemText', () => {
  render(<Failure problem={new TypeError('Failed to fetch')} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Нет связи с сервером — попробуйте ещё раз');
});
