import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { noteVisit, resetVisitsForTest } from './analytics';
import { clientKind } from './client-kind';
import { profileSecret } from './identity';

/** Аналитика продукта (R210): «открыл» и «предвход» — раз на сессию, с профилем и типом клиента, молча. */
const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

beforeEach(() => {
  sessionStorage.clear();
  resetVisitsForTest();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.telegram;
});

it('каждый шаг уходит один раз на сессию — с профилем устройства и типом клиента, без адреса страницы', () => {
  noteVisit('open');
  noteVisit('open');
  noteVisit('prejoin');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/v1/visit');
  expect(init.keepalive).toBe(true);
  expect(JSON.parse(String(init.body))).toEqual({ stage: 'open' });
  expect(init.headers).toMatchObject({ 'X-Cord-Profile': profileSecret(), 'X-Cord-Client': 'web' });
  // Перезагрузка вкладки — та же сессия: второго «открыл» нет.
  resetVisitsForTest();
  noteVisit('open');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('сбой сети и отказ ядра глотаются — аналитика не мешает входу', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('offline'));
  expect(() => noteVisit('open')).not.toThrow();
  await Promise.resolve();
});

it('тип клиента — словом: Mini App Telegram назван своим входом, иначе браузер', () => {
  expect(clientKind()).toBe('web');
  document.documentElement.dataset.telegram = 'android';
  expect(clientKind()).toBe('telegram');
  document.documentElement.dataset.telegram = 'outside';
  expect(clientKind()).toBe('web');
});
