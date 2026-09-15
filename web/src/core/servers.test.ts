import { beforeEach, expect, it } from 'vitest';
import {
  currentServerUrl,
  findServer,
  normalizeServerUrl,
  readServers,
  removeServer,
  saveServer,
  serverLabel,
} from './servers';

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

it('always offers the server that served this page, even with nothing saved', () => {
  expect(readServers()).toEqual([{ url: currentServerUrl(), name: '', password: '', autoConnect: true }]);
});

it('keeps one entry per origin and updates it in place', () => {
  saveServer({ url: 'https://one.example.com', name: 'Первый', password: 'a', autoConnect: true });
  saveServer({ url: 'https://two.example.com', name: '', password: '', autoConnect: false });
  expect(readServers().map((s) => s.url)).toEqual([
    'https://two.example.com/',
    'https://one.example.com/',
    currentServerUrl(),
  ]);
  saveServer({ url: 'https://one.example.com/', name: 'Он же', password: 'b', autoConnect: false });
  expect(readServers().map((s) => s.url)).toEqual([
    'https://two.example.com/',
    'https://one.example.com/',
    currentServerUrl(),
  ]);
  expect(findServer('https://one.example.com/')).toMatchObject({
    name: 'Он же',
    password: 'b',
    autoConnect: false,
  });
  removeServer('https://one.example.com/');
  expect(findServer('https://one.example.com/')).toBeUndefined();
});

it('drops entries a previous version or a corrupt cache left behind', () => {
  localStorage.setItem(
    'cord:servers:v1',
    JSON.stringify([
      { url: 'https://kept.example.com', name: 42, password: null },
      { url: 'not a server' },
      { name: 'no address at all' },
      { url: 'https://kept.example.com/', name: 'дубль' },
    ]),
  );
  const servers = readServers();
  expect(servers.map((s) => s.url)).toEqual([currentServerUrl(), 'https://kept.example.com/']);
  expect(servers[1]).toMatchObject({ name: '', password: '', autoConnect: true });
  localStorage.setItem('cord:servers:v1', '{ broken');
  expect(readServers()).toHaveLength(1);
});

it('names a server the way the user did, or by its host', () => {
  expect(serverLabel({ url: 'https://meet.example.com/', name: '  Наш  ' })).toBe('Наш');
  expect(serverLabel({ url: 'https://meet.example.com:8443/', name: '   ' })).toBe('meet.example.com:8443');
});
