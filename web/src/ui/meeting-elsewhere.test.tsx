import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingElsewhere } from './MeetingElsewhere';

afterEach(cleanup);

/*
  T52: у зрителя активна одна встреча. Ядро отказывает во входе во вторую ответом
  `409 ALREADY_IN_MEETING {roomId, title}`, а здесь человек выбирает словами — без «ОК/Отмена».
*/

const meeting = { roomId: 'room-1', title: 'Вечер с друзьями' };

function open(props: Partial<Parameters<typeof MeetingElsewhere>[0]> = {}) {
  const handlers = { onGo: vi.fn(), onMove: vi.fn(), onClose: vi.fn() };
  render(<MeetingElsewhere meeting={meeting} {...handlers} {...props} />);
  return handlers;
}

it('называет встречу, в которой человек уже есть, и предлагает два ясных выхода', () => {
  const { onGo, onMove } = open();
  expect(screen.getByRole('dialog', { name: 'Вы уже во встрече «Вечер с друзьями»' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Перейти туда' }));
  expect(onGo).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Выйти оттуда и войти сюда' }));
  expect(onMove).toHaveBeenCalledOnce();
});

it('пока идёт переход, кнопки не нажимаются второй раз', () => {
  open({ busy: 'move' });
  expect(screen.getByRole('button', { name: 'Выйти оттуда и войти сюда' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Перейти туда' })).toBeDisabled();
});

it('если туда отсюда не попасть, говорит почему и оставляет второй выбор', () => {
  open({ note: 'В этом браузере эта встреча не открыта.' });
  expect(screen.getByRole('status')).toHaveTextContent('не открыта');
  expect(screen.getByRole('button', { name: 'Выйти оттуда и войти сюда' })).toBeEnabled();
});

it('без встречи ничего не показывает', () => {
  render(<MeetingElsewhere meeting={null} onGo={vi.fn()} onMove={vi.fn()} onClose={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});
