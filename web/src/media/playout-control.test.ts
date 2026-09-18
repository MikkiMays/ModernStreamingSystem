import { describe, expect, it } from 'vitest';
import { PlayoutController, type PlayoutTrack } from './playout-control';
import { profileFor } from './playout';

type Stat = Record<string, unknown> & { id: string; type: string };
const RATE = 48000;

function statsOf(stats: Stat[]) {
  return new Map(stats.map((s) => [s.id, s])) as unknown as RTCStatsReport;
}
function path(protocol = 'udp', candidateType = 'srflx'): Stat[] {
  return [
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    {
      id: 'pair',
      type: 'candidate-pair',
      state: 'succeeded',
      localCandidateId: 'local',
      remoteCandidateId: 'remote',
      currentRoundTripTime: 0.2,
    },
    { id: 'local', type: 'local-candidate', candidateType, protocol, relayProtocol: protocol },
    { id: 'remote', type: 'remote-candidate', candidateType: 'host', protocol },
  ];
}
function inbound(seconds: number, extra: Record<string, unknown> = {}): Stat {
  return {
    id: 'in',
    type: 'inbound-rtp',
    kind: 'audio',
    timestamp: seconds * 1000,
    totalSamplesReceived: Math.round(seconds * RATE),
    concealedSamples: 0,
    silentConcealedSamples: 0,
    removedSamplesForAcceleration: 0,
    jitterBufferEmittedCount: Math.round(seconds * RATE),
    jitterBufferDelay: 0,
    jitter: 0,
    ...extra,
  };
}

class FakeReceiver {
  jitterBufferTarget = 0;
  writes = 0;
  set target(value: number) {
    this.jitterBufferTarget = value;
  }
}
function track(
  id: string,
  kind: PlayoutTrack['kind'],
  stats: () => RTCStatsReport,
): PlayoutTrack & {
  receiver: FakeReceiver;
} {
  const receiver = new FakeReceiver();
  return {
    id,
    kind,
    receiver: receiver as unknown as RTCRtpReceiver & FakeReceiver,
    stats: async () => stats(),
  } as PlayoutTrack & { receiver: FakeReceiver };
}

describe('контроллер запаса', () => {
  it('в одной комнате разговор остаётся быстрым, а музыка получает секундный запас', async () => {
    const controller = new PlayoutController();
    let seconds = 0;
    const voice = track('voice', 'conversation', () => statsOf([...path(), inbound(seconds)]));
    const music = track('music', 'media', () => statsOf([...path(), inbound(seconds)]));
    await controller.tick([voice, music], 0);
    seconds = 2;
    await controller.tick([voice, music], 2000);
    expect(voice.receiver.jitterBufferTarget).toBe(profileFor('conversation', 'auto').startMs);
    expect(music.receiver.jitterBufferTarget).toBe(profileFor('media', 'auto').startMs);
    expect(music.receiver.jitterBufferTarget).toBeGreaterThan(voice.receiver.jitterBufferTarget * 4);
  });

  it('на упорядоченном пути поднимает пол для всех дорожек сразу', async () => {
    const controller = new PlayoutController();
    let protocol = 'udp';
    let type = 'srflx';
    const voice = track('voice', 'conversation', () => statsOf([...path(protocol, type), inbound(0)]));
    await controller.tick([voice], 0);
    expect(controller.link.ordered).toBe(false);
    const direct = voice.receiver.jitterBufferTarget;
    // Сеть отрезала UDP, ICE перешёл на TURN поверх TLS. Прежний запас там бесполезен.
    protocol = 'tls';
    type = 'relay';
    await controller.tick([voice], 2000);
    expect(controller.link.path).toBe('relay-tcp');
    expect(voice.receiver.jitterBufferTarget).toBeGreaterThan(direct);
    expect(voice.receiver.jitterBufferTarget).toBeGreaterThanOrEqual(300);
  });

  it('заглушка в звуке поднимает запас именно у пострадавшей дорожки', async () => {
    const controller = new PlayoutController();
    let broken = false;
    const good = track('good', 'conversation', () => statsOf([...path(), inbound(seconds())]));
    const bad = track('bad', 'conversation', () =>
      statsOf([...path(), inbound(seconds(), broken ? { concealedSamples: 0.02 * seconds() * RATE } : {})]),
    );
    let tickAt = 0;
    const seconds = () => tickAt / 1000;
    await controller.tick([good, bad], tickAt);
    broken = true;
    tickAt = 2000;
    const reports = await controller.tick([good, bad], tickAt);
    expect(reports.find((r) => r.id === 'bad')!.concealRatio).toBeGreaterThan(0.004);
    expect(bad.receiver.jitterBufferTarget).toBeGreaterThan(good.receiver.jitterBufferTarget);
  });

  /**
   * Это и есть ответ на «картинка отстаёт от звука». Замирания у видео случаются и от
   * перегруженного декодера, а запас против них не помогает — зато уводит кадр от голоса
   * ровно на столько, на сколько его подняли.
   */
  it('видео держится запаса своего звука, а не набирает свой от замираний', async () => {
    const controller = new PlayoutController();
    let at = 0;
    let freezes = 0;
    const frames = () => Math.round(at / 40);
    const camera = {
      ...track('cam', 'video', () =>
        statsOf([
          ...path(),
          {
            id: 'in',
            type: 'inbound-rtp',
            kind: 'video',
            timestamp: at,
            framesDecoded: frames(),
            freezeCount: freezes,
            jitter: 0,
            jitterBufferEmittedCount: frames(),
            jitterBufferDelay: 0,
          },
        ]),
      ),
      group: 'bob:camera',
    };
    const voice = {
      ...track('voice', 'conversation', () => statsOf([...path(), inbound(at / 1000)])),
      group: 'bob:camera',
    };
    await controller.tick([voice, camera], at);
    for (let tick = 0; tick < 10; tick++) {
      at += 2000;
      freezes += 2;
      await controller.tick([voice, camera], at);
    }
    expect(camera.receiver.jitterBufferTarget).toBe(voice.receiver.jitterBufferTarget);

    // Молчащая демонстрация — единственный случай, где видео считает запас само.
    const alone = new PlayoutController();
    const lonely = { ...camera, id: 'screen', group: undefined };
    at = 0;
    freezes = 0;
    await alone.tick([lonely], at);
    const started = lonely.receiver.jitterBufferTarget;
    for (let tick = 0; tick < 5; tick++) {
      at += 2000;
      freezes += 2;
      await alone.tick([lonely], at);
    }
    expect(lonely.receiver.jitterBufferTarget).toBeGreaterThan(started);
  });

  it('новую дорожку обеспечивает запасом сразу, не дожидаясь первой статистики', () => {
    const controller = new PlayoutController();
    const music = track('music', 'media', () => statsOf([]));
    expect(controller.prime(music, 0)).toBe(profileFor('media', 'auto').startMs);
    expect(music.receiver.jitterBufferTarget).toBe(profileFor('media', 'auto').startMs);
  });

  it('переподписка сохраняет уже набранный запас, а не начинает с нуля', async () => {
    const controller = new PlayoutController();
    let tickAt = 0;
    const music = track('music', 'media', () =>
      statsOf([
        ...path(),
        inbound(tickAt / 1000, tickAt ? { concealedSamples: 0.05 * (tickAt / 1000) * RATE } : {}),
      ]),
    );
    await controller.tick([music], 0);
    tickAt = 2000;
    await controller.tick([music], tickAt);
    const raised = controller.targetFor('music');
    expect(raised).toBeGreaterThan(profileFor('media', 'auto').startMs);
    const again = track('music', 'media', () => statsOf([]));
    expect(controller.prime(again, 4000)).toBe(raised);
  });

  it('участник, переставший быть ботом, не наследует музыкальный запас', async () => {
    const controller = new PlayoutController();
    let tickAt = 0;
    const stats = () => statsOf([...path(), inbound(tickAt / 1000)]);
    await controller.tick([track('one', 'media', stats)], 0);
    tickAt = 2000;
    await controller.tick([track('one', 'media', stats)], tickAt);
    expect(controller.targetFor('one')).toBe(profileFor('media', 'auto').startMs);
    tickAt = 4000;
    await controller.tick([track('one', 'conversation', stats)], tickAt);
    expect(controller.targetFor('one')).toBe(profileFor('conversation', 'auto').startMs);
  });

  it('ушедшую дорожку забывает, чтобы не копить состояние комнаты', async () => {
    const controller = new PlayoutController();
    const stats = () => statsOf([...path(), inbound(0)]);
    await controller.tick([track('a', 'conversation', stats), track('b', 'conversation', stats)], 0);
    expect(controller.targets()).toHaveLength(2);
    await controller.tick([track('a', 'conversation', stats)], 2000);
    expect(controller.targets().map((t) => t.id)).toEqual(['a']);
  });

  it('смена режима применяется на месте, без переподписки', async () => {
    const controller = new PlayoutController();
    let tickAt = 0;
    const music = track('music', 'media', () => statsOf([...path(), inbound(tickAt / 1000)]));
    await controller.tick([music], 0);
    tickAt = 2000;
    await controller.tick([music], tickAt);
    const auto = controller.targetFor('music');
    controller.setMode('low-latency');
    expect(controller.targetFor('music')).toBeLessThan(auto);
    expect(controller.targetFor('music')).toBeGreaterThan(0);
  });

  it('дорожка без статистики никого не роняет и ничего не портит', async () => {
    const controller = new PlayoutController();
    const silent: PlayoutTrack = {
      id: 'silent',
      kind: 'conversation',
      stats: async () => {
        throw new Error('нет отчёта');
      },
    };
    await expect(controller.tick([silent], 0)).resolves.toEqual([]);
  });

  it('сброс забывает и путь, и накопленные цели', async () => {
    const controller = new PlayoutController();
    await controller.tick([track('a', 'conversation', () => statsOf([...path(), inbound(0)]))], 0);
    expect(controller.link.path).toBe('direct-udp');
    controller.reset();
    expect(controller.link.path).toBe('unknown');
    expect(controller.targets()).toHaveLength(0);
  });
});
