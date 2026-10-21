import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, request } from '../../api/client';
import { ADMIN_KEY } from '../../core/activity';
import { Activity } from './Activity';

/*
  «Активность» владельца сервера (E10-B): вход паролем владельца, встречи сейчас и рычаг
  «Завершить» с подтверждением вторым нажатием. Ядро отвечает подменённым fetch.
*/

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

const now = {
  serverTime: 10_000_000,
  live: 1,
  waiting: 0,
  humans: 3,
  connected: 2,
  bots: 1,
  screens: 0,
  rooms: [
    {
      id: '0b6e7c8a-1111-4222-8333-944455556666',
      code: '123456789',
      createdAt: 9_000_000,
      startedAt: 9_400_000,
      endsAt: null,
      humans: 3,
      connected: 2,
      waiting: 0,
      bots: 1,
      screens: 0,
      integrations: ['music'],
      approvalRequired: false,
      createdHere: true,
    },
  ],
};

function server(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const { status, body } = handler(url, init);
      return Promise.resolve(
        new Response(body === undefined ? '' : JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
}

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it('без входа — только форма пароля владельца; верный пароль открывает «Сейчас»', async () => {
  server((url) =>
    url.endsWith('/admin/session')
      ? { status: 200, body: { token: 't0k', expiresAt: Date.now() / 1000 + 3600 } }
      : { status: 200, body: now },
  );
  render(<Activity />);
  expect(screen.queryByRole('tab')).toBeNull();
  fireEvent.change(screen.getByLabelText('Пароль владельца'), { target: { value: 'тайна' } });
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
  expect(await screen.findByText('123-456-789')).toBeTruthy();
  expect(screen.getByText('Музыка')).toBeTruthy();
  const login = calls.find((c) => c.url.endsWith('/admin/session'))!;
  expect(JSON.parse(String(login.init.body))).toEqual({ password: 'тайна' });
  const read = calls.find((c) => c.url.endsWith('/admin/now'))!;
  expect((read.init.headers as Record<string, string>)['X-Cord-Admin']).toBe('t0k');
});

it('«Завершить» спрашивает вторым нажатием и только потом закрывает встречу', async () => {
  sessionStorage.setItem(ADMIN_KEY, JSON.stringify({ token: 't0k', expiresAt: Date.now() / 1000 + 3600 }));
  server((url, init) =>
    url.includes('/close') && init.method === 'POST'
      ? { status: 200, body: { ...now, live: 0, rooms: [] } }
      : { status: 200, body: now },
  );
  render(<Activity />);
  const close = await screen.findByRole('button', { name: 'Завершить' });
  fireEvent.click(close);
  expect(calls.some((c) => c.url.includes('/close'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Точно? Нажмите ещё раз' }));
  await waitFor(() => expect(screen.getByText('Сейчас встреч нет.')).toBeTruthy());
  const sent = calls.find((c) => c.url.includes('/close'))!;
  expect(JSON.parse(String(sent.init.body))).toEqual({ blockCreator: false });
});

it('истёкший токен владельца возвращает на вход, а не показывает ошибку', async () => {
  sessionStorage.setItem(ADMIN_KEY, JSON.stringify({ token: 'old', expiresAt: Date.now() / 1000 + 3600 }));
  server(() => ({
    status: 401,
    body: { code: 'ADMIN_REQUIRED', detail: 'Войдите паролем владельца сервера' },
  }));
  render(<Activity />);
  expect(await screen.findByLabelText('Пароль владельца')).toBeTruthy();
  expect(sessionStorage.getItem(ADMIN_KEY)).toBeNull();
});

it('отказ BLOCKED называет срок словами по часам этого устройства', async () => {
  const until = new Date(2026, 9, 21, 14, 30).getTime();
  server(() => ({
    status: 403,
    body: { code: 'BLOCKED', detail: 'Доступ к этому серверу закрыт владельцем', until },
  }));
  const error = (await request('/rooms').catch((e: unknown) => e)) as ApiError;
  expect(error.code).toBe('BLOCKED');
  expect(error.message).toMatch(/^Доступ к этому серверу закрыт владельцем до 21 октября/);
  expect(error.message).toContain('14:30');
});

it('«Обращения» (E13): номер, тема, контакт, донёс ли бот — и статус, который ведёт владелец', async () => {
  cleanup(); // прежние сценарии файла оставили свои страницы в документе
  sessionStorage.setItem(ADMIN_KEY, JSON.stringify({ token: 't0k', expiresAt: Date.now() / 1000 + 3600 }));
  const ticket = {
    id: '1a2b3c4d-0000-4000-8000-000000000000',
    number: '1A2B3C4D',
    createdAt: 9_000_000,
    topic: 'camera',
    message: 'Камера чёрная во встрече',
    contact: '@someone',
    diagnostics: 'cord: 0.7.0\nclient: web',
    status: 'NEW',
    statusAt: 9_000_000,
    notifiedAt: null,
  };
  server((url, init) =>
    url.includes('/admin/support/') && init.method === 'PUT'
      ? { status: 204 }
      : url.includes('/admin/support')
        ? { status: 200, body: [ticket] }
        : { status: 200, body: now },
  );
  render(<Activity />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Обращения' }));
  expect(await screen.findByText('Камера чёрная во встрече')).toBeTruthy();
  expect(screen.getByText('Камера и микрофон')).toBeTruthy();
  expect(screen.getByText('Контакт: @someone')).toBeTruthy();
  expect(screen.getByText('Ждёт бота')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: 'Статус обращения 1A2B3C4D' }), {
    target: { value: 'DONE' },
  });
  await waitFor(() => expect(calls.some((c) => c.init.method === 'PUT')).toBe(true));
  const put = calls.find((c) => c.init.method === 'PUT')!;
  expect(put.url).toContain('/admin/support/1a2b3c4d-0000-4000-8000-000000000000/status');
  expect(JSON.parse(String(put.init.body))).toEqual({ status: 'DONE' });
  expect((put.init.headers as Record<string, string>)['X-Cord-Admin']).toBe('t0k');
});
