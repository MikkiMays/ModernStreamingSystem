import { beforeEach, expect, it } from 'vitest';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from './servers';

beforeEach(() => localStorage.clear());

it('starts from sane answers when nothing has been remembered', () => {
  expect(thisServer()).toEqual({
    url: currentServerUrl(),
    name: '',
    password: '',
  });
});

it('remembers the password for this server; the old «connect automatically» flag is simply not read (R195)', () => {
  rememberServer({ password: 'тайна' });
  expect(thisServer().password).toBe('тайна');
  rememberServer({ name: 'Наш' });
  expect(thisServer(), 'unrelated fields survive a partial change').toMatchObject({
    password: 'тайна',
    name: 'Наш',
  });
  expect('autoConnect' in thisServer()).toBe(false);
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
  expect(thisServer()).toMatchObject({ name: 'Наш', password: 'тайна' });
  rememberServer({ password: '' });
  expect(JSON.parse(localStorage.getItem('cord:servers:v1')!).url).toBe(currentServerUrl());
});

it('ignores a cache it cannot read', () => {
  localStorage.setItem('cord:servers:v1', '{ broken');
  expect(thisServer()).toEqual({ url: currentServerUrl(), name: '', password: '' });
});

it('names a server the way it was named here, or by its host', () => {
  expect(serverLabel({ url: 'https://meet.example.com/', name: '  Наш  ' })).toBe('Наш');
  expect(serverLabel({ url: 'https://meet.example.com:8443/', name: '   ' })).toBe('meet.example.com:8443');
});
