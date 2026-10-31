import {
  decideCodec,
  rungKey,
  sameShape,
  type Codec,
  type CodecDecision,
  type FailReason,
  type PolicyInput,
} from './codec-policy';
import { EncoderHealth, type EncoderSample } from './encoder-health';

/**
 * Кодек каждого источника на всю встречу (R152): решение политики (`codec-policy.ts`), сторож
 * (`encoder-health.ts`), что декодируют зрители и сколько раз можно переопубликоваться.
 *
 * ПОЧЕМУ ЗДЕСЬ, А НЕ В `session.ts`. Сессия публикует и опрашивает, а решать, когда сменить кодек,
 * — это правила со временем: «не чаще раза в 30 с», «подсказка — не чаще раза в 5 минут», «отступ
 * помнится всю встречу и переживает переподключение». Здесь они проверяются тестами без SDK.
 *
 * Камера и показ — у каждого свой сторож и своя память отступов: экран, упёршийся в процессор, не
 * роняет камеру, и наоборот.
 */
export type PublishSource = 'camera' | 'screen';
export type SwitchReason = FailReason | 'restore' | 'viewers' | 'level';

export interface CodecSwitch {
  source: PublishSource;
  from: Codec;
  to: Codec;
  reason: SwitchReason;
}

export type PlannerAction =
  | { kind: 'none' }
  | { kind: 'switch'; source: PublishSource; decision: CodecDecision; from: Codec; reason: SwitchReason }
  | { kind: 'hint'; source: PublishSource; reason: 'cpu' | 'encode-time' };

/** Что видно в «Диагностике» про выбор кодека этого источника. */
export interface CodecInfo {
  decision: CodecDecision;
  /** Отступы сторожа за встречу. */
  fallbacks: number;
  /** Смены кодека за встречу — любые: сторож, зрители, смена уровня. */
  switches: number;
  /** Смена решена, но ждёт конца 30-секундного окна. */
  pending: boolean;
}

/** Всё, кроме зрителей и здоровья, — их планировщик подставляет сам. */
export type PlanInput = Omit<PolicyInput, 'health' | 'viewers'>;

interface SourceState {
  base?: PlanInput;
  decision?: CodecDecision;
  failed: Map<string, FailReason>;
  health: EncoderHealth;
  lastSwitchAt: number;
  pending?: SwitchReason;
  hintAt: number;
  fallbacks: number;
  switches: number;
}

const NONE: PlannerAction = { kind: 'none' };

export class CodecPlanner {
  /** Переопубликация ради кодека — не чаще раза в 30 с на источник (лимит сессий NVENC, моргание плитки). */
  static readonly SWITCH_GAP_MS = 30_000;
  /** Подсказка «процессор не успевает» — не чаще раза в 5 минут. */
  static readonly HINT_GAP_MS = 5 * 60_000;
  private readonly states: Record<PublishSource, SourceState> = {
    camera: CodecPlanner.fresh(),
    screen: CodecPlanner.fresh(),
  };
  private viewers: readonly (readonly Codec[] | null)[] = [];
  private viewersKey = '';
  private cpuTight = false;
  private log: CodecSwitch[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  private static fresh(): SourceState {
    return {
      failed: new Map(),
      health: new EncoderHealth(),
      lastSwitchAt: -Infinity,
      hintAt: -Infinity,
      fallbacks: 0,
      switches: 0,
    };
  }

  private decide(state: SourceState): CodecDecision {
    return decideCodec({
      ...state.base!,
      viewers: this.viewers,
      health: { failed: state.failed, cpuTight: this.cpuTight },
    });
  }

  /**
   * Решение перед публикацией. `initial` — дорожка публикуется впервые (включили камеру, начали показ):
   * это не смена кодека. Иначе (сменился уровень) новая форма считается сменой — без 30-секундного
   * окна: её попросил человек, и кадр с частотой остаются выбранными.
   */
  plan(source: PublishSource, base: PlanInput, initial: boolean): CodecDecision {
    const state = this.states[source];
    state.base = base;
    const next = this.decide(state);
    const before = state.decision;
    if (!initial && before && !sameShape(before, next)) {
      state.switches++;
      state.lastSwitchAt = this.now();
      this.log.push({ source, from: before.codec, to: next.codec, reason: 'level' });
    }
    if (initial || !sameShape(before, next)) state.health.restart();
    state.decision = next;
    state.pending = undefined;
    return next;
  }

  current(source: PublishSource): CodecDecision | undefined {
    return this.states[source].decision;
  }

  info(source: PublishSource): CodecInfo | null {
    const state = this.states[source];
    return state.decision
      ? {
          decision: state.decision,
          fallbacks: state.fallbacks,
          switches: state.switches,
          pending: !!state.pending,
        }
      : null;
  }

  /**
   * Состав зрителей изменился. Что сменить сейчас — в ответе; что не успело 30-секундное окно —
   * ждёт и применится на очередном замере (`observe`).
   */
  setViewers(viewers: readonly (readonly Codec[] | null)[]): PlannerAction[] {
    const key = JSON.stringify(viewers.map((v) => (v ? [...v].sort() : null)).sort());
    if (key === this.viewersKey) return [];
    this.viewersKey = key;
    this.viewers = viewers;
    const actions: PlannerAction[] = [];
    for (const source of ['camera', 'screen'] as const) {
      const action = this.review(source, 'viewers');
      if (action.kind === 'switch') actions.push(action);
    }
    return actions;
  }

  /** Процессору тесно (Compute Pressure): учитывается в следующих решениях, само ничего не меняет. */
  setCpuTight(tight: boolean) {
    this.cpuTight = tight;
  }

  /** Переподключение: замеры подряд — заново (счётчики байтов новые), память отступов — нет. */
  reconnected() {
    for (const state of Object.values(this.states)) state.health.restart();
  }

  /** Дорожка снята (показ кончился, камеру выключили): решение забыто, память отступов — нет. */
  stop(source: PublishSource) {
    const state = this.states[source];
    state.decision = undefined;
    state.pending = undefined;
    state.health.restart();
  }

  /** Один замер кодировщика этого источника. */
  observe(source: PublishSource, sample: EncoderSample): PlannerAction {
    const state = this.states[source];
    const decision = state.decision;
    if (!decision || !state.base) return NONE;
    // Смена уже решена и ждёт окна: тот же кодировщик ещё раз в отступ не считаем.
    if (state.pending) return this.review(source, state.pending);
    const restorable = [...state.failed.values()].some((r) => r === 'cpu' || r === 'encode-time');
    const lowest = !decision.hw && (decision.codec === 'h264' || decision.codec === 'vp8');
    const result = state.health.observe(sample, { expectHw: decision.hw, lowest, restorable });
    switch (result.verdict) {
      case 'fallback':
        state.failed.set(rungKey(decision.codec, decision.hw), result.reason);
        state.fallbacks++;
        return this.review(source, result.reason);
      case 'restore':
        for (const [key, reason] of state.failed)
          if (reason === 'cpu' || reason === 'encode-time') state.failed.delete(key);
        return this.review(source, 'restore');
      case 'hint':
        if (this.now() - state.hintAt < CodecPlanner.HINT_GAP_MS) return NONE;
        state.hintAt = this.now();
        return { kind: 'hint', source, reason: result.reason };
      default:
        return NONE;
    }
  }

  /** Смены кодека с прошлого вызова — для сводки раз в 10 с (`cord_client_codec_switch_total`). */
  takeSwitches(): CodecSwitch[] {
    const switches = this.log;
    this.log = [];
    return switches;
  }

  private review(source: PublishSource, reason: SwitchReason): PlannerAction {
    const state = this.states[source];
    const before = state.decision;
    if (!before || !state.base) return NONE;
    const next = this.decide(state);
    if (sameShape(before, next)) {
      // В сеть уходит то же — но причина и «нужен ли запасной» видны в диагностике.
      state.decision = next;
      state.pending = undefined;
      return NONE;
    }
    if (this.now() - state.lastSwitchAt < CodecPlanner.SWITCH_GAP_MS) {
      state.pending = reason;
      return NONE;
    }
    state.decision = next;
    state.lastSwitchAt = this.now();
    state.pending = undefined;
    state.switches++;
    state.health.restart();
    this.log.push({ source, from: before.codec, to: next.codec, reason });
    return { kind: 'switch', source, decision: next, from: before.codec, reason };
  }
}
