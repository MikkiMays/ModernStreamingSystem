/**
 * Замер пути до медиаузлов с этого устройства и выбор узла для новой встречи (R195, §5.4 и §6
 * `docs/architecture/distributed-media.md`).
 *
 * ЧТО ТАКОЕ «БЛИЖНИЙ УЗЕЛ». Не география, а путь пакетов отсюда и сейчас: под VPN он идёт из точки
 * выхода VPN, и правильный узел — тот, что ближе к ней. Поэтому геобаз здесь нет, а есть два замера до
 * каждого узла из `capabilities.nodes`, параллельно:
 *
 * - TCP: `fetch(probeUrl/api/v1/ping)` — один прогрев (рукопожатие TLS не считаем) и три замера, медиана.
 *   Отвечает сам узел (`infra/Caddyfile.node`), а не ядро — измеряется путь именно до него;
 * - UDP: пустое `RTCPeerConnection` с одним `stun:` узла — время до первого кандидата `srflx` — это один
 *   пакет STUN туда и обратно к TURN узла. Нет кандидата за {@link UDP_TIMEOUT_MS} — UDP до узла закрыт
 *   (так же, как в `udp-probe.ts`).
 *
 * ВЫБОР. Среди узлов с открытым UDP — наименьший UDP-оборот; если UDP закрыт везде — наименьший TCP (медиа
 * пойдёт через `turns:` 443 этого узла). Гистерезис против мигающего VPN: прошлый выбор меняется, только
 * если новый лучше и на {@link HYSTERESIS_MS}, и на {@link HYSTERESIS_RATIO}.
 *
 * СКОРОСТЬ — ТРЕБОВАНИЕ ВЛАДЕЛЬЦА. Замер не должен задерживать вход: он идёт на главной, в фоне, как только
 * известен список узлов, кэшируется на {@link CACHE_MS}, а последний выбор помнится в `localStorage`
 * сутки — на первом экране он есть ещё до замера. «Создать встречу» ждёт идущий замер не дольше
 * {@link JOIN_BUDGET_MS}; обычно не ждёт вовсе (результат уже есть). Один замер — ≤ 4 коротких запросов и
 * один STUN на узел, укладывается в ≈ 1,5 с даже на плохой сети; узел, не ответивший за таймаут,
 * считается далёким, а не ломает выбор. Входящим (не создателю) замер не нужен: узел задан комнатой.
 */

export interface NodeInfo {
  id: string;
  title: Record<string, string>;
  rtcUrl: string;
  probeUrl: string;
  stun?: string | null;
  control: boolean;
}

/** Что намерили до одного узла; `null` — замер не удался (узел далёк или не отвечает). */
export interface NodeMeasure {
  node: string;
  tcpMs: number | null;
  udpMs: number | null;
  udpOpen: boolean;
}

export const TCP_SAMPLES = 3;
export const TCP_TIMEOUT_MS = 1500;
export const UDP_TIMEOUT_MS = 1500;
export const CACHE_MS = 60_000;
export const JOIN_BUDGET_MS = 400;
export const HYSTERESIS_MS = 15;
export const HYSTERESIS_RATIO = 0.3;
/** Сколько помнить последний удачный выбор между визитами. */
export const REMEMBER_MS = 24 * 60 * 60 * 1000;
export const STORAGE_KEY = 'cord:node:v1';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Create = (config: RTCConfiguration) => RTCPeerConnection;
type Now = () => number;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Оборот TCP до узла: медиана трёх запросов после прогрева; `null` — не ответил или не CORS. */
export async function measureTcp(
  probeUrl: string,
  fetchFn: Fetch = (url, init) => fetch(url, init),
  now: Now = () => performance.now(),
  samples = TCP_SAMPLES,
): Promise<number | null> {
  const url = `${probeUrl.replace(/\/+$/, '')}/api/v1/ping`;
  const once = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TCP_TIMEOUT_MS);
    const started = now();
    try {
      const response = await fetchFn(url, {
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return now() - started;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  if ((await once()) === null) return null;
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t = await once();
    if (t !== null) times.push(t);
  }
  return times.length ? Math.round(median(times)) : null;
}

/** Оборот UDP до узла: время до первого `srflx` от его STUN; `null` — UDP закрыт или STUN не задан. */
export async function measureUdp(
  stun: string | null | undefined,
  create: Create = (config) => new RTCPeerConnection(config),
  now: Now = () => performance.now(),
): Promise<number | null> {
  if (!stun) return null;
  let pc: RTCPeerConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pc = create({ iceServers: [{ urls: stun }] });
    const started = now();
    const answered = new Promise<number | null>((resolve) => {
      pc!.onicecandidate = ({ candidate }) => {
        if (!candidate) resolve(null);
        else if (candidate.type === 'srflx') resolve(Math.round(now() - started));
      };
      timer = setTimeout(() => resolve(null), UDP_TIMEOUT_MS);
    });
    pc.createDataChannel('node-probe');
    await pc.setLocalDescription(await pc.createOffer());
    return await answered;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    pc?.close();
  }
}

export async function measureNode(
  node: NodeInfo,
  deps: { fetch?: Fetch; create?: Create; now?: Now } = {},
): Promise<NodeMeasure> {
  const [tcpMs, udpMs] = await Promise.all([
    measureTcp(node.probeUrl, deps.fetch, deps.now),
    measureUdp(node.stun, deps.create, deps.now),
  ]);
  return { node: node.id, tcpMs, udpMs, udpOpen: udpMs !== null };
}

/** Чем узел измерен для сравнения: UDP, если открыт, иначе TCP; `null` — ничем. */
export function score(measure: NodeMeasure): number | null {
  return measure.udpOpen ? measure.udpMs : measure.tcpMs;
}

/**
 * Лучший узел по замерам с гистерезисом относительно прошлого выбора. Узлы с открытым UDP всегда
 * впереди узлов без него. `null` — ни один не измерен.
 */
export function chooseNode(measures: readonly NodeMeasure[], previous: string | null = null): string | null {
  const udp = measures.filter((m) => m.udpOpen && m.udpMs !== null);
  const pool = udp.length ? udp : measures.filter((m) => m.tcpMs !== null);
  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (score(b)! < score(a)! ? b : a));
  const prior = previous ? pool.find((m) => m.node === previous) : undefined;
  if (!prior || prior.node === best.node) return best.node;
  const was = score(prior)!;
  const now = score(best)!;
  const better = was - now >= HYSTERESIS_MS && was - now >= was * HYSTERESIS_RATIO;
  return better ? best.node : prior.node;
}

interface Remembered {
  node: string;
  at: number;
}

export interface ProbeResult {
  at: number;
  measures: NodeMeasure[];
  node: string | null;
}

/**
 * Замер по расписанию и выбор для «Создать встречу». Один на страницу (`nodeProbe`), подменяемый в тестах.
 */
export class NodeProbe {
  private result: ProbeResult | null = null;
  private running: Promise<ProbeResult> | null = null;
  private nodes: NodeInfo[] = [];

  constructor(
    private deps: {
      fetch?: Fetch;
      create?: Create;
      now?: Now;
      clock?: () => number;
      storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
    } = {},
  ) {}

  private clock() {
    return this.deps.clock?.() ?? Date.now();
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
    if (this.deps.storage !== undefined) return this.deps.storage;
    try {
      return localStorage;
    } catch {
      return null;
    }
  }

  /** Список узлов из `capabilities`; один узел — мерить нечего, выбор — он. */
  schedule(nodes: readonly NodeInfo[]) {
    this.nodes = [...nodes];
    if (nodes.length <= 1) return;
    void this.refresh();
  }

  known(): readonly NodeInfo[] {
    return this.nodes;
  }

  /** Последний замер, если он моложе кэша. */
  current(): ProbeResult | null {
    const result = this.result;
    return result && this.clock() - result.at < CACHE_MS ? result : null;
  }

  /** Последний замер, даже старый — для диагностики «до Хельсинки 12 мс». */
  last(): ProbeResult | null {
    return this.result;
  }

  private remembered(): string | null {
    try {
      const raw = this.storage()?.getItem(STORAGE_KEY);
      const saved = raw ? (JSON.parse(raw) as Partial<Remembered>) : null;
      if (!saved || typeof saved.node !== 'string' || typeof saved.at !== 'number') return null;
      if (this.clock() - saved.at > REMEMBER_MS) return null;
      return this.nodes.some((n) => n.id === saved.node) ? saved.node : null;
    } catch {
      return null;
    }
  }

  private remember(node: string) {
    try {
      this.storage()?.setItem(STORAGE_KEY, JSON.stringify({ node, at: this.clock() } satisfies Remembered));
    } catch {
      /* Приватное окно: помним до перезагрузки. */
    }
  }

  /** Перемерить сейчас (если замер уже идёт — присоединиться к нему). */
  refresh(): Promise<ProbeResult> {
    if (this.running) return this.running;
    const nodes = this.nodes;
    const previous = this.result?.node ?? this.remembered();
    this.running = Promise.all(nodes.map((node) => measureNode(node, this.deps)))
      .then((measures) => {
        const node = chooseNode(measures, previous);
        const result: ProbeResult = { at: this.clock(), measures, node };
        this.result = result;
        if (node) this.remember(node);
        return result;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /**
   * Узел для новой встречи и замеры для ядра. Свежий результат — сразу; устаревший или запомненный выбор —
   * тоже сразу, а замер освежается в фоне (вход не ждёт сеть); ждём идущий замер не дольше `budgetMs`
   * только когда выбора нет вовсе; иначе — ничего (ядро возьмёт узел управления).
   */
  async preferred(budgetMs = JOIN_BUDGET_MS): Promise<{ node: string | null; measures: NodeMeasure[] }> {
    if (this.nodes.length <= 1) return { node: this.nodes[0]?.id ?? null, measures: [] };
    const fresh = this.current();
    if (fresh) return { node: fresh.node, measures: fresh.measures };
    const known = this.result?.node ?? this.remembered();
    if (known) {
      void this.refresh().catch(() => {});
      return { node: known, measures: this.result?.measures ?? [] };
    }
    const pending = this.running ?? this.refresh();
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
    if (result) return { node: result.node, measures: result.measures };
    return { node: this.result?.node ?? this.remembered(), measures: this.result?.measures ?? [] };
  }

  /** Как узел называется для человека: заголовок на языке интерфейса, иначе английский, иначе id. */
  title(id: string, language: string): string {
    const node = this.nodes.find((n) => n.id === id);
    if (!node) return id;
    const short = language.split('-')[0] ?? language;
    return node.title[language] ?? node.title[short] ?? node.title.en ?? id;
  }

  /** Замер до узла словами для диагностики: `12 мс` или null. */
  latency(id: string): number | null {
    const measure = this.result?.measures.find((m) => m.node === id);
    return measure ? score(measure) : null;
  }
}

export const nodeProbe = new NodeProbe();
