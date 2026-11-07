import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MaintenancePage } from './MaintenancePage';

const NOW = new Date(2026, 10, 10, 4, 10).getTime();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const show = (over: object = {}) =>
  render(
    <MaintenancePage state={{ endsAt: null, expiresAt: NOW + 3600000, endedMeeting: false, ...over }} />,
  );

it('спокойно говорит, что идёт, и что страницу обновлять не нужно', () => {
  show();
  expect(screen.getByRole('heading', { level: 1, name: 'Идут технические работы' })).toBeInTheDocument();
  expect(screen.getByText(/обновлять страницу не нужно/)).toBeInTheDocument();
  // Срока не обещали — и строки о нём нет; действий на странице тоже нет.
  expect(screen.queryByText(/Планируем/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('обещанный конец — по часам устройства', () => {
  vi.useFakeTimers({ now: NOW });
  show({ endsAt: new Date(2026, 10, 10, 5, 0).getTime() });
  expect(screen.getByText('Планируем закончить к 05:00')).toBeInTheDocument();
});

it('конец в другой день — с датой', () => {
  vi.useFakeTimers({ now: NOW });
  show({ endsAt: new Date(2026, 10, 11, 5, 0).getTime() });
  expect(screen.getByText(/Планируем закончить к 11 ноября/)).toBeInTheDocument();
});

it('обещанный срок прошёл — не врёт о прошедшем времени', () => {
  vi.useFakeTimers({ now: NOW });
  show({ endsAt: NOW - 60000 });
  expect(screen.getByText('Заканчиваем, осталось немного')).toBeInTheDocument();
  expect(screen.queryByText(/Планируем/)).not.toBeInTheDocument();
});

it('срок проходит на глазах — строка меняется сама', async () => {
  vi.useFakeTimers({ now: NOW });
  show({ endsAt: NOW + 30000 });
  expect(screen.getByText(/Планируем закончить/)).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(31000);
  expect(screen.getByText('Заканчиваем, осталось немного')).toBeInTheDocument();
});

it('человека вывели из встречи — страница называет причину', () => {
  show({ endedMeeting: true });
  expect(screen.getByText(/Встреча завершилась, потому что начались работы/)).toBeInTheDocument();
});

it('встреча под страницей недоступна с клавиатуры и диктору, фокус — на заголовке; после — всё как было', () => {
  const meeting = document.createElement('button');
  const already = document.createElement('div');
  already.inert = true;
  document.body.append(meeting, already);
  const { unmount } = show();
  expect(meeting.inert).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
  unmount();
  expect(meeting.inert).toBe(false);
  // Закрытое до страницы — не её дело открывать.
  expect(already.inert).toBe(true);
  meeting.remove();
  already.remove();
});
