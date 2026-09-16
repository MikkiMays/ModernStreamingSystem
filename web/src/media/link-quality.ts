/**
 * Какой канал нам сегодня достался.
 *
 * ЗАЧЕМ. Буфер воспроизведения нельзя выбирать вслепую: 60 мс достаточно для прямого UDP
 * до соседнего города и заведомо мало для ретранслятора по TLS через полконтинента. Здесь
 * из одного отчёта getStats вынимается то немногое, что действительно меняет решение:
 * каким путём идёт медиа, сколько занимает оборот и насколько неровно приходят пакеты.
 *
 * Самое важное поле — `ordered`. Когда ICE выбрал TURN поверх TCP или TLS, потерянный
 * пакет не теряется, а **переспрашивается**, и всё, что успело прийти после него, ждёт
 * своей очереди. Наружу это выглядит как «резко замолчало, а потом заговорило быстрее» —
 * ровно то, что слышно в комнате. Против этого помогает только запас в буфере размером
 * хотя бы с один оборот, поэтому тип пути должен доезжать до расчёта буфера.
 */

export type LinkPath = 'direct-udp' | 'direct-tcp' | 'relay-udp' | 'relay-tcp' | 'unknown';
export type LinkGrade = 'good' | 'fair' | 'poor' | 'unknown';

export interface LinkState {
  path: LinkPath;
  /** Путь доставляет пакеты по порядку и переспрашивает потерянные: TCP или TLS. */
  ordered: boolean;
  rttMs: number | null;
  /** Наибольший джиттер приёма за последнее время, а не мгновенный. */
  jitterMs: number | null;
  lossPercent: number | null;
  grade: LinkGrade;
}

export const unknownLink: LinkState = {
  path: 'unknown',
  ordered: false,
  rttMs: null,
  jitterMs: null,
  lossPercent: null,
  grade: 'unknown',
};

/** То немногое из local-candidate/remote-candidate, что здесь используется. */
interface CandidateStats {
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Какой именно парой кандидатов пользуется это соединение прямо сейчас. */
export function readCandidatePair(report: RTCStatsReport): RTCIceCandidatePairStats | undefined {
  let selected: RTCIceCandidatePairStats | undefined;
  const nominated: RTCIceCandidatePairStats[] = [];
  report.forEach((stat) => {
    if (stat.type === 'transport' && stat.selectedCandidatePairId) {
      const pair = report.get(stat.selectedCandidatePairId);
      if (pair) selected = pair;
    }
    if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && (stat.selected || stat.nominated))
      nominated.push(stat);
  });
  // Единственная согласованная пара так же однозначна, как названная транспортом. Если их
  // несколько, а транспорт молчит, честнее не гадать: неверный путь хуже отсутствия пути.
  return selected ?? (nominated.length === 1 ? nominated[0] : undefined);
}

export function readPath(report: RTCStatsReport): LinkPath {
  const pair = readCandidatePair(report);
  if (!pair) return 'unknown';
  const local = report.get(pair.localCandidateId) as CandidateStats | undefined;
  const remote = report.get(pair.remoteCandidateId) as CandidateStats | undefined;
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  // У ретранслирующего кандидата `protocol` описывает участок до TURN-сервера, а нас
  // интересует участок от нас: его называет `relayProtocol`.
  const protocol = (
    local?.candidateType === 'relay'
      ? (local.relayProtocol ?? local.protocol)
      : (local?.protocol ?? remote?.protocol)
  )?.toLowerCase();
  if (!protocol) return 'unknown';
  const ordered = protocol === 'tcp' || protocol === 'tls' || protocol === 'ssltcp';
  if (relayed) return ordered ? 'relay-tcp' : 'relay-udp';
  return ordered ? 'direct-tcp' : 'direct-udp';
}

export function isOrdered(path: LinkPath) {
  return path === 'direct-tcp' || path === 'relay-tcp';
}

export function gradeLink(state: Omit<LinkState, 'grade'>): LinkGrade {
  const { rttMs, jitterMs, lossPercent, ordered } = state;
  if (rttMs === null && jitterMs === null && lossPercent === null) return 'unknown';
  // Упорядоченный путь никогда не считается хорошим: его провал ещё не случился, но один
  // потерянный пакет обойдётся дороже, чем на UDP, и запас должен быть заложен заранее.
  if (ordered) return (jitterMs ?? 0) > 60 || (rttMs ?? 0) > 250 ? 'poor' : 'fair';
  if ((lossPercent ?? 0) >= 3 || (jitterMs ?? 0) >= 60 || (rttMs ?? 0) >= 400) return 'poor';
  if ((lossPercent ?? 0) >= 0.7 || (jitterMs ?? 0) >= 25 || (rttMs ?? 0) >= 180) return 'fair';
  return 'good';
}

interface Counters {
  lost: number;
  received: number;
}

/**
 * Собирает состояние канала по повторяющимся отчётам. Джиттер запоминается пиком с
 * затуханием: короткий всплеск пинга — это именно то, ради чего набирается буфер, и
 * усреднение стёрло бы его раньше, чем он успел бы на что-то повлиять.
 */
export class LinkMonitor {
  private peakJitterMs = 0;
  private previous = new Map<string, Counters>();
  private state: LinkState = unknownLink;
  /** Во сколько раз пик джиттера уменьшается за один опрос без новых всплесков. */
  constructor(private decay = 0.8) {}

  get current(): LinkState {
    return this.state;
  }

  observe(report: RTCStatsReport): LinkState {
    const path = readPath(report);
    const pair = readCandidatePair(report);
    const rtt = finite(pair?.currentRoundTripTime);
    let jitter: number | null = null;
    let lost = 0;
    let received = 0;
    const active = new Set<string>();
    report.forEach((stat) => {
      if (stat.type !== 'inbound-rtp') return;
      active.add(stat.id);
      const value = finite(stat.jitter);
      if (value !== null) jitter = Math.max(jitter ?? 0, value * 1000);
      const before = this.previous.get(stat.id);
      const current: Counters = {
        lost: Number(stat.packetsLost ?? 0),
        received: Number(stat.packetsReceived ?? 0),
      };
      if (before && current.received >= before.received && current.lost >= before.lost) {
        lost += current.lost - before.lost;
        received += current.received - before.received;
      }
      this.previous.set(stat.id, current);
    });
    for (const id of this.previous.keys()) if (!active.has(id)) this.previous.delete(id);
    if (jitter !== null) this.peakJitterMs = Math.max(jitter, this.peakJitterMs * this.decay);
    const partial = {
      path,
      ordered: isOrdered(path),
      rttMs: rtt === null ? null : rtt * 1000,
      jitterMs: jitter === null && this.peakJitterMs === 0 ? null : this.peakJitterMs,
      lossPercent: lost + received > 0 ? (lost / (lost + received)) * 100 : null,
    };
    this.state = { ...partial, grade: gradeLink(partial) };
    return this.state;
  }

  reset() {
    this.peakJitterMs = 0;
    this.previous.clear();
    this.state = unknownLink;
  }
}

/**
 * Стоит ли показывать это как другое состояние. Числа сравниваются огрублённо: канал
 * шевелится непрерывно, а перерисовывать из-за одного миллисекундного дрожания нечего.
 */
export function linkChanged(before: LinkState, after: LinkState) {
  const step = (value: number | null, size: number) => (value === null ? null : Math.round(value / size));
  return (
    before.path !== after.path ||
    before.grade !== after.grade ||
    step(before.rttMs, 10) !== step(after.rttMs, 10) ||
    step(before.jitterMs, 5) !== step(after.jitterMs, 5) ||
    step(before.lossPercent, 0.5) !== step(after.lossPercent, 0.5)
  );
}

export function pathName(path: LinkPath) {
  return {
    'direct-udp': 'Прямой к серверу медиа · UDP',
    'direct-tcp': 'Прямой к серверу медиа · TCP',
    'relay-udp': 'Через ретранслятор TURN · UDP',
    'relay-tcp': 'Через ретранслятор TURN · TCP/TLS',
    unknown: 'Путь не определён',
  }[path];
}

export function gradeName(grade: LinkGrade) {
  return { good: 'Хороший', fair: 'Средний', poor: 'Слабый', unknown: 'Пока нет данных' }[grade];
}
