import { describe, expect, it } from 'vitest';
import { udpOpen, udpServers } from './udp-probe';

const servers = [
  { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' },
  { urls: ['turns:turn.example:5349?transport=tcp'], username: 'u', credential: 'c' },
  { urls: ['stun:stun.example:3478', 'turn:turn.example:443?transport=tcp'] },
];

/** Соединение-пустышка: на `setLocalDescription` отдаёт заданных кандидатов (`null` — сбор окончен). */
function fake(
  candidates: ({ type: string } | null)[],
  created: { config?: RTCConfiguration; closed?: boolean },
) {
  return (config: RTCConfiguration) => {
    created.config = config;
    const pc = {
      onicecandidate: null as ((event: { candidate: { type: string } | null }) => void) | null,
      createDataChannel: () => ({}),
      createOffer: async () => ({ type: 'offer', sdp: '' }),
      setLocalDescription: async () => {
        setTimeout(() => {
          for (const candidate of candidates) pc.onicecandidate?.({ candidate });
        }, 10);
      },
      close: () => {
        created.closed = true;
      },
    };
    return pc as unknown as RTCPeerConnection;
  };
}

describe('открыт ли UDP до сервера', () => {
  it('в проверку идут только адреса по UDP', () => {
    expect(udpServers(servers)).toEqual([
      { urls: ['turn:turn.example:3478?transport=udp'], username: 'u', credential: 'c' },
      { urls: ['stun:stun.example:3478'] },
    ]);
  });

  it('сервер ответил по UDP — открыт; соединение-проба закрыто', async () => {
    const created: { config?: RTCConfiguration; closed?: boolean } = {};
    const open = await udpOpen(servers, 1000, fake([{ type: 'host' }, { type: 'srflx' }], created));
    expect(open).toBe(true);
    expect(created.config?.iceServers).toEqual(udpServers(servers));
    expect(created.closed).toBe(true);
  });

  it('только свои адреса и конец сбора — закрыт', async () => {
    const created = {};
    expect(await udpOpen(servers, 1000, fake([{ type: 'host' }, null], created))).toBe(false);
  });

  it('сервер молчит — закрыт по таймауту', async () => {
    const created: { closed?: boolean } = {};
    expect(await udpOpen(servers, 50, fake([{ type: 'host' }], created))).toBe(false);
    expect(created.closed).toBe(true);
  });

  it('проверить не по чему — не мешаем попытке', async () => {
    expect(await udpOpen([{ urls: ['turns:turn.example:5349?transport=tcp'] }])).toBe(true);
  });
});
