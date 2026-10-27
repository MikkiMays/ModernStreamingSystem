import { describe, expect, it } from 'vitest';
import { LocalNetworks, localNetworks, NETWORK_CHECK_MS } from './local-networks';

type Candidate = { type: string; address?: string | null } | null;

/** Соединение-пустышка: на `setLocalDescription` отдаёт заданных кандидатов. */
function fake(candidates: () => Candidate[], made: { configs: RTCConfiguration[]; closed: number }) {
  return (config: RTCConfiguration) => {
    made.configs.push(config);
    const pc = {
      onicecandidate: null as ((event: { candidate: Candidate }) => void) | null,
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: '' }),
      setLocalDescription: async () => {
        setTimeout(() => {
          for (const candidate of candidates()) pc.onicecandidate?.({ candidate });
        }, 5);
      },
      close: () => {
        made.closed++;
      },
    };
    return pc as unknown as RTCPeerConnection;
  };
}

describe('локальные сети устройства', () => {
  it('без серверов: в сеть ничего не уходит; отпечаток — свои адреса, соединение закрыто', async () => {
    const made = { configs: [] as RTCConfiguration[], closed: 0 };
    const candidates = () => [
      { type: 'host', address: '10.0.0.7' },
      { type: 'host', address: '192.168.1.5' },
      { type: 'host', address: '10.0.0.7' },
      null,
    ];
    expect(await localNetworks(fake(candidates, made))).toBe('10.0.0.7 192.168.1.5');
    expect(made.configs).toEqual([{ iceServers: [] }]);
    expect(made.closed).toBe(1);
  });

  it('адреса спрятаны за mDNS — отпечаток по их числу', async () => {
    const made = { configs: [] as RTCConfiguration[], closed: 0 };
    const candidates = () => [
      { type: 'host', address: 'a1b2.local' },
      { type: 'host', address: 'c3d4.local' },
      null,
    ];
    expect(await localNetworks(fake(candidates, made))).toBe('mdns×2');
  });

  it('новая сеть появилась — сказать один раз; проверка не чаще раза в 15 с', async () => {
    const made = { configs: [] as RTCConfiguration[], closed: 0 };
    let list: Candidate[] = [{ type: 'host', address: '10.0.0.7' }, null];
    const watch = new LocalNetworks(fake(() => list, made));
    expect(await watch.changed(0)).toBe(false);
    list = [{ type: 'host', address: '10.0.0.7' }, { type: 'host', address: '192.168.1.5' }, null];
    expect(await watch.changed(NETWORK_CHECK_MS - 1)).toBe(false);
    expect(made.configs).toHaveLength(1);
    expect(await watch.changed(NETWORK_CHECK_MS)).toBe(true);
    expect(await watch.changed(2 * NETWORK_CHECK_MS)).toBe(false);
  });

  it('после сброса прежний отпечаток забыт: сравнивать не с чем', async () => {
    const made = { configs: [] as RTCConfiguration[], closed: 0 };
    let list: Candidate[] = [{ type: 'host', address: '10.0.0.7' }, null];
    const watch = new LocalNetworks(fake(() => list, made));
    await watch.changed(0);
    watch.reset();
    list = [{ type: 'host', address: '192.168.1.5' }, null];
    expect(await watch.changed(1)).toBe(false);
  });

  it('браузер не дал собрать — не повод', async () => {
    const watch = new LocalNetworks(() => {
      throw new Error('нет WebRTC');
    });
    expect(await watch.changed(0)).toBe(false);
    expect(await watch.changed(NETWORK_CHECK_MS)).toBe(false);
  });
});
