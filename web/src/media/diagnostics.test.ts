import { describe, expect, it } from 'vitest';
import type { Track } from 'livekit-client';
import { StatsSampler } from './diagnostics';

type Stat = { id: string; type: string; [key: string]: unknown };
const makeTrack = (read: () => Stat[]) =>
  ({ getRTCStatsReport: async () => new Map(read().map((s) => [s.id, s])) }) as unknown as Track;
const route: Stat[] = [
  { id: 'transport', type: 'transport', selectedCandidatePairId: 'active' },
  {
    id: 'active',
    type: 'candidate-pair',
    state: 'succeeded',
    localCandidateId: 'local',
    remoteCandidateId: 'remote',
    currentRoundTripTime: 0.06,
  },
  { id: 'local', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tls' },
  { id: 'remote', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
  {
    id: 'old',
    type: 'candidate-pair',
    state: 'succeeded',
    nominated: true,
    localCandidateId: 'remote',
    currentRoundTripTime: 1,
  },
  { id: 'codec', type: 'codec', mimeType: 'video/H264' },
];
function inbound(n: number): Stat {
  return {
    id: 'video',
    type: 'inbound-rtp',
    kind: 'video',
    transportId: 'transport',
    codecId: 'codec',
    timestamp: 1000 + n * 1000,
    bytesReceived: 1000 + n * 1000000,
    framesDecoded: 30 + n * 60,
    packetsReceived: 500 + n * 98,
    packetsLost: 10 + n * 2,
    totalDecodeTime: 0.3 + n * 0.36,
    jitterBufferDelay: 1 + n * 2.4,
    jitterBufferEmittedCount: 30 + n * 60,
  };
}
describe('diagnostics of the selected media route', () => {
  it('distinguishes a TURN/TLS hop from the relay UDP candidate and ignores a stale nominated pair', async () => {
    const sampler = new StatsSampler();
    const [sample] = await sampler.sample(makeTrack(() => [...route, inbound(0)]));
    expect(sample).toMatchObject({
      transport: 'TURN · TLS',
      rttMs: 60,
      codec: 'video/H264',
      loss: null,
      bufferMs: null,
    });
  });
  it('measures interval buffer/decode/loss and isolates identical stats ids on different tracks', async () => {
    let n = 0;
    const track = makeTrack(() => [...route, inbound(n)]);
    const other = makeTrack(() => [{ ...inbound(80), bytesReceived: 700000000 }]);
    const sampler = new StatsSampler();
    await sampler.sample(track);
    await sampler.sample(other);
    n = 1;
    const [sample] = await sampler.sample(track);
    expect(sample).toMatchObject({ fps: 60, mbps: 8, loss: 2 });
    expect(sample!.bufferMs).toBeCloseTo(40);
    expect(sample!.processingMs).toBeCloseTo(6);
    n = 0;
    const [reset] = await sampler.sample(track);
    expect(reset).toMatchObject({ fps: 0, mbps: 0, bufferMs: null, processingMs: null, loss: null });
  });
  it('does not invent zero packet loss, UDP or a selected route when the browser omits them', async () => {
    const track = makeTrack(() => [
      { id: 'out', type: 'outbound-rtp', kind: 'video', timestamp: 1000, framesEncoded: 10, bytesSent: 1000 },
    ]);
    const [sample] = await new StatsSampler().sample(track);
    expect(sample).toMatchObject({
      transport: 'Не определено',
      rttMs: null,
      loss: null,
      implementation: 'Не раскрыт браузером',
    });
  });
});
