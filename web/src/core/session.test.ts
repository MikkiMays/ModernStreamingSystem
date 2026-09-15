import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../api/client';
import { adopt, connect, disconnect, renew, session } from './session';
import { currentServerUrl, saveServer } from './servers';

const { cues } = vi.hoisted(() => ({ cues: [] as string[] }));
vi.mock('./sounds', () => ({
  signal: (cue: string) => cues.push(cue),
  ensureNotificationAudio() {},
}));

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const issued = (token: string) => ({
  token,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  name: 'Тестовый Cord',
  passwordRequired: true,
});

function calls() {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit][];
}
const sentSession = (index: number) =>
  (calls()[index]?.[1].headers as Record<string, string>)['X-Cord-Session'];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  disconnect();
  cues.length = 0;
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it('holds the connection for the visit and sends it with every request', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(answer(issued('token-1')));
  await connect('пароль');
  expect(session.get()?.name).toBe('Тестовый Cord');
  expect(JSON.parse(sessionStorage.getItem('cord:session:v1')!).token).toBe('token-1');

  vi.mocked(fetch).mockResolvedValueOnce(answer([]));
  await request('/favorites');
  expect(sentSession(1)).toBe('token-1');
});

it('treats a lapsed token as not connected', () => {
  sessionStorage.setItem(
    'cord:session:v1',
    JSON.stringify({ ...issued('stale'), expiresAt: Math.floor(Date.now() / 1000) - 1 }),
  );
  expect(session.get()).toBeNull();
});

/**
 * The property that keeps a meeting alive: an expired session is repaired underneath the
 * request that tripped over it, not by sending the person back to the connect screen.
 */
it('shakes hands again and repeats the request when the session has lapsed', async () => {
  saveServer({ url: currentServerUrl(), name: '', password: 'пароль', autoConnect: true });
  vi.mocked(fetch)
    .mockResolvedValueOnce(answer({ code: 'SERVER_PASSWORD_REQUIRED' }, 401))
    .mockResolvedValueOnce(answer({ passwordRequired: true }))
    .mockResolvedValueOnce(answer(issued('token-2')))
    .mockResolvedValueOnce(answer([{ roomId: 'a' }]));

  await expect(request('/favorites')).resolves.toEqual([{ roomId: 'a' }]);
  expect(calls().map(([url]) => url)).toEqual([
    '/api/v1/favorites',
    '/api/v1/capabilities',
    '/api/v1/session',
    '/api/v1/favorites',
  ]);
  expect(sentSession(3)).toBe('token-2');
});

it('gives up quietly when this device has no password to offer', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(answer({ passwordRequired: true }));
  await expect(renew()).resolves.toBe(false);
  expect(session.get()).toBeNull();
});

/**
 * Only the transitions are worth hearing. A token renewed mid-visit is the same connection,
 * and announcing it would tell somebody that something happened when nothing did.
 */
it('sounds connecting and disconnecting, and stays quiet for a renewal', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(answer(issued('token-a')));
  await connect('пароль');
  expect(cues).toEqual(['connected']);
  adopt({ ...issued('token-b'), name: 'Тестовый Cord' });
  expect(cues, 'a renewal is not a new connection').toEqual(['connected']);
  disconnect();
  expect(cues).toEqual(['connected', 'disconnected']);
  disconnect();
  expect(cues, 'already disconnected is not a disconnection').toEqual(['connected', 'disconnected']);
});

it('reconnects to an open server without asking for anything', async () => {
  vi.mocked(fetch)
    .mockResolvedValueOnce(answer({ passwordRequired: false }))
    .mockResolvedValueOnce(answer({ ...issued('token-3'), passwordRequired: false }));
  await expect(renew()).resolves.toBe(true);
  expect(session.get()?.token).toBe('token-3');
});
