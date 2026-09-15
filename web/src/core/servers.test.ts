import { beforeEach, expect, it } from 'vitest';
import { currentServerUrl, normalizeServerUrl, rememberServer, serverLabel, thisServer } from './servers';

beforeEach(() => localStorage.clear());

it('accepts the addresses a server can actually be reached at and rejects the rest', () => {
  expect(normalizeServerUrl('meet.example.com')).toBe('https://meet.example.com/');
  expect(normalizeServerUrl('  https://meet.example.com  ')).toBe('https://meet.example.com/');
  expect(normalizeServerUrl('https://meet.example.com:8443/')).toBe('https://meet.example.com:8443/');
  expect(normalizeServerUrl('http://localhost:5173')).toBe('http://localhost:5173/');
  for (const wrong of [
    '',
    '   ',
    'http://meet.example.com',
    'https://meet.example.com/join/1',
    'https://meet.example.com?a=1',
    'https://user:pass@meet.example.com',
    'ftp://meet.example.com',
  ])
    expect(() => normalizeServerUrl(wrong), wrong).toThrow();
});

it('starts from sane answers when nothing has been remembered', () => {
  expect(thisServer()).toEqual({
    url: currentServerUrl(),
    name: '',
    password: '',
    autoConnect: true,
  });
});

it('remembers the password and the automatic connection for this server', () => {
  rememberServer({ password: 'тайна' });
  expect(thisServer().password).toBe('тайна');
  expect(thisServer().autoConnect, 'unrelated fields survive a partial change').toBe(true);
  rememberServer({ autoConnect: false });
  expect(thisServer()).toMatchObject({ password: 'тайна', autoConnect: false });
});

/**
 * Earlier versions kept a list here, with bookmarks to servers this page can never reach. The
 * entry for this origin is still ours; the rest was never usable and is simply not read.
 */
it('reads its own entry out of a list left by an earlier version', () => {
  localStorage.setItem(
    'cord:servers:v1',
    JSON.stringify([
      { url: 'https://elsewhere.example.com/', name: 'Чужой', password: 'x', autoConnect: false },
      { url: currentServerUrl(), name: 'Наш', password: 'тайна', autoConnect: false },
    ]),
  );
  expect(thisServer()).toMatchObject({ name: 'Наш', password: 'тайна', autoConnect: false });
  rememberServer({ password: '' });
  expect(JSON.parse(localStorage.getItem('cord:servers:v1')!).url).toBe(currentServerUrl());
});

it('ignores a cache it cannot read', () => {
  localStorage.setItem('cord:servers:v1', '{ broken');
  expect(thisServer().autoConnect).toBe(true);
});

it('names a server the way it was named here, or by its host', () => {
  expect(serverLabel({ url: 'https://meet.example.com/', name: '  Наш  ' })).toBe('Наш');
  expect(serverLabel({ url: 'https://meet.example.com:8443/', name: '   ' })).toBe('meet.example.com:8443');
});
