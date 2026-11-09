import { act, cleanup, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { meetingEnded, meetingStarted } from '../core/live-meetings';
import { lazyPart, page, RELOAD_GAP_MS, reloadForNewBuild, resetReloadForTests } from './lazy-part';

/*
 * Модуль части не загрузился — вкладка открыта до выкатки (владелец 10.11: «раздел поддержки перестал
 * открываться в вебе»). Не во встрече — одна перезагрузка, во встрече — надпись вместо пустого экрана.
 */
const reload = vi.fn();
const stale = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

beforeEach(() => {
  sessionStorage.clear();
  resetReloadForTests();
  reload.mockReset();
  page.reload = reload;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function show(Part: ReturnType<typeof lazyPart>) {
  await act(async () => {
    render(
      <Suspense fallback={<span>загрузка</span>}>
        <Part />
      </Suspense>,
    );
  });
}

it('загрузившаяся часть показывается как обычно', async () => {
  await show(lazyPart(async () => ({ default: () => <p>Частые вопросы</p> })));
  expect(await screen.findByText('Частые вопросы')).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();
});

it('не во встрече — одна перезагрузка за новой сборкой, заглушка держится', async () => {
  await show(lazyPart(stale));
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByText('загрузка')).toBeInTheDocument();
  expect(screen.queryByRole('status')).toBeNull();
});

it('перезагружали только что — второй раз не перезагружает, а говорит словами', async () => {
  sessionStorage.setItem('cord:reloaded-for-build', String(Date.now() - 1000));
  await show(lazyPart(stale));
  expect(reload).not.toHaveBeenCalled();
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Эта часть откроется после обновления страницы',
  );
});

it('во встрече страница не перезагружается: надпись и кнопка, разговор идёт', async () => {
  meetingStarted();
  try {
    await show(lazyPart(stale));
    expect(reload).not.toHaveBeenCalled();
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Cord обновился на сервере');
    act(() => screen.getByRole('button', { name: 'Обновить страницу' }).click());
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    meetingEnded();
  }
});

it('отметка о перезагрузке живёт RELOAD_GAP_MS', () => {
  const storage = new Map<string, string>();
  const store = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  };
  const go = vi.fn();
  expect(reloadForNewBuild(1_000_000, go, store)).toBe(true);
  resetReloadForTests();
  expect(reloadForNewBuild(1_000_000 + RELOAD_GAP_MS - 1, go, store)).toBe(false);
  expect(reloadForNewBuild(1_000_000 + RELOAD_GAP_MS, go, store)).toBe(true);
  expect(go).toHaveBeenCalledTimes(2);
});
