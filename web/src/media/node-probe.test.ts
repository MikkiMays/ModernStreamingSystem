import { describe, expect, it, vi } from 'vitest';
import {
  CACHE_MS,
  JOIN_BUDGET_MS,
  NodeProbe,
  STORAGE_KEY,
  chooseNode,
  measureTcp,
  measureUdp,
  type NodeInfo,
  type NodeMeasure,
} from './node-probe';

const m = (node: string, tcpMs: number | null, udpMs: number | null): NodeMeasure => ({
  node,
  tcpMs,
  udpMs,
  udpOpen: udpMs !== null,
});

describe('chooseNode', () => {
  it('prefers the node with the shortest UDP round trip, and TCP only when UDP is closed everywhere', () => {
    expect(chooseNode([m('fra', 45, 44), m('hel', 14, 12)])).toBe('hel');
    // UDP открыт только до одного узла — он и выигрывает, даже если TCP до другого короче.
    expect(chooseNode([m('fra', 10, null), m('hel', 60, 58)])).toBe('hel');
    // UDP закрыт везде (VPN без UDP): считаем TCP — медиа пойдёт через turns: этого узла.
    expect(chooseNode([m('fra', 45, null), m('hel', 14, null)])).toBe('hel');
    expect(chooseNode([m('fra', null, null)])).toBeNull();
    expect(chooseNode([])).toBeNull();
  });

  it('keeps the previous node unless the new one is better by 15 ms and 30 %', () => {
    // 41 → 30: лучше на 11 мс и 27 % — остаёмся (мигающий VPN не трогает выбор).
    expect(chooseNode([m('fra', 0, 41), m('hel', 0, 30)], 'fra')).toBe('fra');
    // 41 → 20: лучше на 21 мс и 51 % — переходим.
    expect(chooseNode([m('fra', 0, 41), m('hel', 0, 20)], 'fra')).toBe('hel');
    // 100 → 80: 20 мс, но только 20 % — остаёмся.
    expect(chooseNode([m('fra', 0, 100), m('hel', 0, 80)], 'fra')).toBe('fra');
    // Прошлый узел больше не измерен — берём лучший без оговорок.
    expect(chooseNode([m('fra', null, null), m('hel', 0, 80)], 'fra')).toBe('hel');
    // Прошлый узел потерял UDP, новый с UDP — переходим: открытый UDP всегда впереди.
    expect(chooseNode([m('fra', 10, null), m('hel', 50, 48)], 'fra')).toBe('hel');
  });
});

describe('measureTcp', () => {
  it('warms up once, takes the median of three timed requests and never sends credentials', async () => {
    let clock = 0;
    const calls: RequestInit[] = [];
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      clock += calls.length === 1 ? 300 : [10, 50, 12][calls.length - 2]!;
      return new Response('{}', { status: 200 });
    });
    const now = () => clock;
    expect(await measureTcp('https://hel.example/', fetchFn, now)).toBe(12);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://hel.example/api/v1/ping');
    for (const init of calls) {
      expect(init.credentials).toBe('omit');
      expect(init.cache).toBe('no-store');
      expect(init.mode).toBe('cors');
    }
  });

  it('answers null when the node does not answer or refuses', async () => {
    expect(
      await measureTcp(
        'https://x',
        async () => new Response('', { status: 503 }),
        () => 0,
      ),
    ).toBeNull();
    expect(
      await measureTcp(
        'https://x',
        async () => {
          throw new TypeError('Failed to fetch');
        },
        () => 0,
      ),
    ).toBeNull();
  });
});

describe('measureUdp', () => {
  function connection(answer: 'srflx' | 'host-only' | 'none', delay = 7) {
    let clock = 0;
    const pc = {
      onicecandidate: null as ((e: { candidate: { type: string } | null }) => void) | null,
      createDataChannel: vi.fn(),
      createOffer: vi.fn(async () => ({})),
      setLocalDescription: vi.fn(async () => {
        queueMicrotask(() => {
          if (answer === 'none') return;
          pc.onicecandidate?.({ candidate: { type: 'host' } });
          if (answer === 'srflx') {
            clock = delay;
            pc.onicecandidate?.({ candidate: { type: 'srflx' } });
          } else pc.onicecandidate?.({ candidate: null });
        });
      }),
      close: vi.fn(),
    };
    return { pc, now: () => clock };
  }

  it('is the time to the first server-reflexive candidate from the node STUN', async () => {
    const { pc, now } = connection('srflx', 11);
    const create = vi.fn(() => pc as unknown as RTCPeerConnection);
    expect(await measureUdp('stun:turn-hel.example:3478', create, now)).toBe(11);
    expect(create).toHaveBeenCalledWith({ iceServers: [{ urls: 'stun:turn-hel.example:3478' }] });
    expect(pc.close).toHaveBeenCalled();
  });

  it('is null without a reflexive candidate, without STUN, or when the browser cannot build a connection', async () => {
    const { pc, now } = connection('host-only');
    expect(await measureUdp('stun:x:3478', () => pc as unknown as RTCPeerConnection, now)).toBeNull();
    expect(await measureUdp(null)).toBeNull();
    expect(
      await measureUdp('stun:x:3478', () => {
        throw new Error('no webrtc');
      }),
    ).toBeNull();
  });
});

describe('NodeProbe', () => {
  const NODES: NodeInfo[] = [
    {
      id: 'fra',
      title: { ru: 'Франкфурт' },
      rtcUrl: 'wss://rtc-fra',
      probeUrl: 'https://fra',
      stun: 'stun:fra:3478',
      control: true,
    },
    {
      id: 'hel',
      title: { ru: 'Хельсинки', en: 'Helsinki' },
      rtcUrl: 'wss://rtc-hel',
      probeUrl: 'https://hel',
      stun: 'stun:hel:3478',
      control: false,
    },
  ];

  /**
   * Узлы отвечают с настоящей задержкой (таймеры), потому что замеры узлов идут параллельно, и общая
   * подставная «часы» перепутали бы их. `hang` — STUN молчит: UDP считается закрытым по таймауту.
   */
  function probe(
    latency: Record<string, number>,
    options: { storage?: Map<string, string>; hang?: boolean } = {},
  ) {
    const store = options.storage ?? new Map<string, string>();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let wall = 1_000_000;
    const deps = {
      fetch: async (url: string) => {
        await wait(latency[url.includes('//hel') ? 'hel' : 'fra']!);
        return new Response('{}', { status: 200 });
      },
      create: (config: RTCConfiguration) => {
        const urls = String((config.iceServers?.[0] as RTCIceServer | undefined)?.urls ?? '');
        const node = urls.includes('hel') ? 'hel' : 'fra';
        const pc = {
          onicecandidate: null as ((e: { candidate: { type: string } | null }) => void) | null,
          createDataChannel: vi.fn(),
          createOffer: vi.fn(async () => ({})),
          setLocalDescription: vi.fn(async () => {
            if (options.hang) return;
            setTimeout(() => pc.onicecandidate?.({ candidate: { type: 'srflx' } }), latency[node]);
          }),
          close: vi.fn(),
        };
        return pc as unknown as RTCPeerConnection;
      },
      clock: () => wall,
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    };
    const instance = new NodeProbe(deps);
    return { probe: instance, store, advance: (ms: number) => void (wall += ms) };
  }

  it('measures in the background, caches the result and answers "preferred" without waiting', async () => {
    const { probe: p, store } = probe({ fra: 40, hel: 10 });
    p.schedule(NODES);
    const result = await p.refresh();
    expect(result.node).toBe('hel');
    expect(result.measures.map((x) => x.node)).toEqual(['fra', 'hel']);
    expect(JSON.parse(store.get(STORAGE_KEY)!).node).toBe('hel');
    const started = performance.now();
    const chosen = await p.preferred();
    expect(performance.now() - started).toBeLessThan(JOIN_BUDGET_MS);
    expect(chosen.node).toBe('hel');
    expect(chosen.measures).toHaveLength(2);
    expect(p.title('hel', 'ru')).toBe('Хельсинки');
    expect(p.title('hel', 'de')).toBe('Helsinki');
    expect(p.title('fra', 'en')).toBe('fra');
    expect(p.latency('hel')).toBeGreaterThan(0);
  });

  it('with a single node there is nothing to measure', async () => {
    const { probe: p } = probe({ fra: 40 });
    p.schedule([NODES[0]!]);
    expect(await p.preferred()).toEqual({ node: 'fra', measures: [] });
    expect(p.last()).toBeNull();
  });

  it('remembers the last choice for the first screen and re-measures after the cache expires', async () => {
    const store = new Map<string, string>();
    store.set(STORAGE_KEY, JSON.stringify({ node: 'hel', at: 1_000_000 - 60_000 }));
    const { probe: p, advance } = probe({ fra: 40, hel: 300 }, { storage: store, hang: true });
    p.schedule(NODES);
    // Запомненный выбор отдаётся сразу, без ожидания замера (замер идёт в фоне).
    const started = performance.now();
    const quick = await p.preferred();
    expect(performance.now() - started).toBeLessThan(100);
    expect(quick.node).toBe('hel');
    expect(quick.measures).toEqual([]);
    const result = await p.refresh();
    // UDP закрыт везде → по TCP; прошлый выбор hel хуже fra на 260 мс — переходим.
    expect(result.node).toBe('fra');
    expect(p.current()).not.toBeNull();
    advance(CACHE_MS + 1);
    expect(p.current()).toBeNull();
    expect(p.last()?.node).toBe('fra');
  }, 10_000);
});
