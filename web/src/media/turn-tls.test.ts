import { describe, expect, it } from 'vitest';
import { offersTls, readRelayOnly, relayOnlyConfig, tlsServers, RELAY_KEY } from './turn-tls';

/** Так LiveKit 1.13.6 в `strict` отдаёт серверы участнику: одна учётка на UDP и TLS. */
const strict = [
  {
    urls: ['turn:108.165.32.75:3478?transport=udp', 'turns:turn.cord.example:443?transport=tcp'],
    username: 'u',
    credential: 'c',
  },
];
const simple = [{ urls: ['turn:108.165.32.75:3478?transport=udp'], username: 'u', credential: 'c' }];

describe('TURN по TLS у сервера', () => {
  it('оставляет только адреса turns: с той же учёткой', () => {
    expect(tlsServers(strict)).toEqual([
      { urls: ['turns:turn.cord.example:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    expect(tlsServers(simple)).toEqual([]);
    expect(tlsServers([{ urls: 'TURNS:turn.example:443' }])).toEqual([{ urls: ['TURNS:turn.example:443'] }]);
  });

  it('знает, предлагал ли его сервер', () => {
    expect(offersTls(strict)).toBe(true);
    expect(offersTls(simple)).toBe(false);
    expect(offersTls([])).toBe(false);
  });
});

describe('режим «только TURN по TLS»', () => {
  it('включается только значением tls; без хранилища — выключен', () => {
    expect(readRelayOnly({ getItem: (key) => (key === RELAY_KEY ? 'tls' : null) })).toBe(true);
    expect(readRelayOnly({ getItem: () => '1' })).toBe(false);
    expect(readRelayOnly({ getItem: () => null })).toBe(false);
    expect(
      readRelayOnly({
        getItem: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe(false);
  });

  it('серверы берутся в момент сборки конфигурации — как разворот в SDK после ответа на вход', () => {
    let joined: typeof strict | undefined;
    const config = relayOnlyConfig(() => joined);
    // До ответа на вход (offer-with-join): своих серверов ноль, но список есть — серверные без фильтра SDK не возьмёт.
    const before = { ...config };
    expect(before).toEqual({ iceTransportPolicy: 'relay', iceServers: [] });
    joined = strict;
    const after = { ...config };
    expect(after.iceTransportPolicy).toBe('relay');
    expect(after.iceServers).toEqual([
      { urls: ['turns:turn.cord.example:443?transport=tcp'], username: 'u', credential: 'c' },
    ]);
    // Копия — уже данные: сменившийся ответ её не трогает.
    joined = simple;
    expect(after.iceServers).toHaveLength(1);
    expect({ ...config }.iceServers).toEqual([]);
  });
});
