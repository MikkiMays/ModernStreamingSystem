import type { Track } from 'livekit-client';

export interface Sample {
  kind: 'audio' | 'video';
  direction: string;
  width: number;
  height: number;
  fps: number;
  mbps: number;
  loss: number | null;
  limitation: string;
  transport: string;
  rttMs: number | null;
  codec: string;
  processingMs: number | null;
  bufferMs: number | null;
  implementation: string;
  at: number;
}
interface Counters {
  timestamp: number;
  bytes: number;
  lost: number;
  received: number;
  frames: number;
  processing?: number;
  buffer?: number;
  emitted?: number;
}
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function averageMs(current: number | undefined, previous: number | undefined, count: number) {
  return current !== undefined && previous !== undefined && current >= previous && count > 0
    ? ((current - previous) * 1000) / count
    : null;
}
export class StatsSampler {
  // A stats id is unique inside one peer connection, not across all participants/tracks.
  private previous = new WeakMap<Track, Map<string, Counters>>();
  async sample(track: Track): Promise<Sample[]> {
    const report = await track.getRTCStatsReport();
    if (!report) return [];
    const history = this.previous.get(track) ?? new Map<string, Counters>();
    this.previous.set(track, history);
    const active = new Set<string>();
    const result: Sample[] = [];
    report.forEach((stat) => {
      if (
        !['inbound-rtp', 'outbound-rtp'].includes(stat.type) ||
        !['audio', 'video'].includes(stat.kind ?? stat.mediaType)
      )
        return;
      active.add(stat.id);
      const receiving = stat.type === 'inbound-rtp';
      const transportStats = report.get(stat.transportId);
      let pair = report.get(transportStats?.selectedCandidatePairId);
      if (!pair) {
        const candidates: RTCIceCandidatePairStats[] = [];
        report.forEach((candidate) => {
          if (
            candidate.type === 'candidate-pair' &&
            candidate.state === 'succeeded' &&
            (candidate.selected || candidate.nominated)
          )
            candidates.push(candidate);
        });
        if (candidates.length === 1) pair = candidates[0];
      }
      const local = report.get(pair?.localCandidateId);
      const remote = report.get(pair?.remoteCandidateId);
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      const protocol =
        local?.candidateType === 'relay' ? local.relayProtocol : (local?.protocol ?? remote?.protocol);
      const transport = pair
        ? `${relay ? 'TURN' : 'Прямой к SFU'} · ${typeof protocol === 'string' ? protocol.toUpperCase() : 'протокол не раскрыт'}`
        : 'Не определено';
      const current: Counters = {
        timestamp: stat.timestamp,
        bytes: Number(stat.bytesReceived ?? stat.bytesSent ?? 0),
        lost: Number(stat.packetsLost ?? 0),
        received: Number(stat.packetsReceived ?? stat.packetsSent ?? 0),
        frames: Number(stat.framesDecoded ?? stat.framesEncoded ?? 0),
        processing: finite(receiving ? stat.totalDecodeTime : stat.totalEncodeTime),
        buffer: finite(stat.jitterBufferDelay),
        emitted: finite(stat.jitterBufferEmittedCount),
      };
      const before = history.get(stat.id);
      const prior =
        before &&
        current.timestamp > before.timestamp &&
        current.bytes >= before.bytes &&
        current.frames >= before.frames
          ? before
          : undefined;
      const dt = prior ? (current.timestamp - prior.timestamp) / 1000 : 0;
      const frames = prior ? current.frames - prior.frames : 0;
      const lost = prior ? Math.max(0, current.lost - prior.lost) : 0;
      const packets = prior ? Math.max(0, current.received - prior.received) : 0;
      result.push({
        kind: stat.kind ?? stat.mediaType,
        direction: receiving ? 'Получение' : 'Передача',
        width: Number(stat.frameWidth ?? 0),
        height: Number(stat.frameHeight ?? 0),
        fps: dt > 0 ? frames / dt : 0,
        mbps: dt > 0 ? ((current.bytes - prior!.bytes) * 8) / dt / 1e6 : 0,
        loss:
          receiving && prior && finite(stat.packetsLost) !== undefined && packets + lost > 0
            ? (lost / (packets + lost)) * 100
            : null,
        limitation: String(stat.qualityLimitationReason ?? (receiving ? 'unknown' : 'none')),
        transport,
        rttMs: finite(pair?.currentRoundTripTime) === undefined ? null : pair.currentRoundTripTime * 1000,
        codec: String(report.get(stat.codecId)?.mimeType ?? 'Не раскрыт'),
        processingMs: averageMs(current.processing, prior?.processing, frames),
        bufferMs: averageMs(current.buffer, prior?.buffer, (current.emitted ?? 0) - (prior?.emitted ?? 0)),
        implementation: String(
          (receiving ? stat.decoderImplementation : stat.encoderImplementation) ?? 'Не раскрыт браузером',
        ),
        at: stat.timestamp,
      });
      history.set(stat.id, current);
    });
    for (const id of history.keys()) if (!active.has(id)) history.delete(id);
    return result;
  }
}
