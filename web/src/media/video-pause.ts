import { Store } from '../core/store';

/**
 * Пауза чужого видео от SFU (R117).
 *
 * ЗАЧЕМ. С 25.10 SFU работает с `congestion_control.allow_pause`: зрителю, чей канал не тянет
 * картинку, он перестаёт слать видео и бережёт ему речь и музыку (`backlog/DECISIONS.md`). SDK
 * сообщает об этом `TrackStreamStateChanged`, а без обработки зритель видел молча застывший кадр и
 * думал, что завис собеседник или звонок. Пауза касается только этого зрителя — значит, и сказать
 * о ней может только его собственная страница.
 *
 * ПРАВИЛА.
 * 1. **Надпись — не раньше {@link PAUSE_NOTICE_MS}.** Распределитель полосы SFU пробует слои и
 *    нередко снимает паузу через долю секунды; кадр всё это время доигрывает буфер приёма, и глазу
 *    такая пауза не видна. Надпись на ней только мигала бы. Буфер, который мы сами попросили глубже
 *    (видео показа идёт за своим звуком, до секунды), — тоже ждём: пока он доигрывает, картинка ещё
 *    живая, и «приостановлено» поверх движущегося кадра читалось бы как ложь.
 * 2. **Снимается сразу** — по `Active` от SFU. Запасной путь — новый кадр из сети: `Active` теряется,
 *    если сигнал переподключался в ту секунду, когда SFU паузу снял, и тогда надпись висела бы поверх
 *    живой картинки — хуже, чем не сказать ничего. Кадры считаются принятые (`framesReceived`), а не
 *    показанные: показанные идут и после паузы, пока доигрывает буфер.
 * 3. **Пока связь с SFU потеряна, надписей нет**: застывшее у всех объясняет плашка восстановления,
 *    а отсчёт паузы начинается заново после возврата — с тем, что SDK к тому времени знает.
 *
 * Здесь нет ни LiveKit, ни React: сессия передаёт события SDK и счётчики статистики, плитки и
 * показ читают {@link VideoPauses.shown}.
 */

/** Сколько пауза должна длиться, чтобы о ней сказать. Короче — не мигаем. */
export const PAUSE_NOTICE_MS = 700;
/**
 * Сколько ждать после начала паузы, прежде чем верить счётчику принятых кадров: кадры, которые SFU
 * отправил до решения о паузе, ещё в пути.
 */
export const IN_FLIGHT_MS = 300;

interface Pause {
  /** `pending` — ждём {@link PAUSE_NOTICE_MS}; `shown` — надпись видна; `flowing` — кадры пошли без `Active`. */
  phase: 'pending' | 'shown' | 'flowing';
  /** С какого момента считать паузу: начало или возврат связи. */
  since: number;
  /** Сколько доигрывает буфер приёма — раньше этого кадр ещё живой. */
  bufferedMs: number;
  /** Принятые кадры на первом опросе после {@link IN_FLIGHT_MS}: рост от них — картинка пошла. */
  baseline?: number;
  /** Пауза уже дошла до надписи и посчитана в {@link VideoPauses.total}. */
  counted: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class VideoPauses {
  /** trackSid → true: у этих дорожек сейчас видна надпись «Видео приостановлено». */
  readonly shown = new Store<Readonly<Record<string, true>>>({});
  /** Сколько пауз за встречу дошло до надписи — для «Диагностики». */
  readonly total = new Store(0);
  private pauses = new Map<string, Pause>();
  private suspended = false;

  /** SFU приостановил дорожку. `bufferedMs` — запас приёма, который мы попросили для неё. */
  pause(id: string, bufferedMs = 0, now = Date.now()) {
    const current = this.pauses.get(id);
    if (current && current.phase !== 'flowing') return;
    if (current) clearTimeout(current.timer);
    const pause: Pause = { phase: 'pending', since: now, bufferedMs, counted: false };
    this.pauses.set(id, pause);
    if (!this.suspended) this.arm(id, pause);
  }

  /** SFU снова шлёт дорожку — надпись гаснет сразу, без задержки. */
  resume(id: string) {
    this.drop(id);
  }

  /**
   * Счётчик принятых кадров дорожки из опроса статистики. Вырос во время паузы — SFU картинку
   * вернул, а `Active` не дошёл: надпись гаснет, отсчёт тоже.
   */
  frames(id: string, received: number, now = Date.now()) {
    const pause = this.pauses.get(id);
    if (!pause || pause.phase === 'flowing' || this.suspended || now - pause.since < IN_FLIGHT_MS) return;
    if (pause.baseline === undefined || received < pause.baseline) {
      pause.baseline = received;
      return;
    }
    if (received === pause.baseline) return;
    clearTimeout(pause.timer);
    const wasShown = pause.phase === 'shown';
    pause.phase = 'flowing';
    if (wasShown) this.publish();
  }

  /**
   * Держит ли SFU дорожку на паузе: кадров нет по его решению. Тогда это не зависание, и
   * переподписка (`live-health.ts`) ничего не починит — пауза снимется сама.
   */
  holds(id: string) {
    const pause = this.pauses.get(id);
    return !!pause && pause.phase !== 'flowing';
  }

  /** Оставить только дорожки, которые ещё подписаны: отписка — конец паузы. */
  retain(ids: ReadonlySet<string>) {
    for (const id of [...this.pauses.keys()]) if (!ids.has(id)) this.drop(id);
  }

  /** Связь с SFU потеряна: надписи прячутся, отсчёт стоит. */
  suspend() {
    this.suspended = true;
    for (const pause of this.pauses.values()) {
      clearTimeout(pause.timer);
      if (pause.phase === 'shown') pause.phase = 'pending';
      pause.baseline = undefined;
    }
    this.publish();
  }

  /**
   * Связь вернулась. `stillPaused` — какие дорожки SDK всё ещё считает приостановленными: после
   * полного переподключения дорожки новые и по умолчанию идут, а о паузе SFU скажет заново.
   */
  restore(stillPaused: ReadonlySet<string>, now = Date.now()) {
    this.suspended = false;
    for (const [id, pause] of [...this.pauses]) {
      if (!stillPaused.has(id)) {
        this.drop(id);
        continue;
      }
      if (pause.phase === 'flowing') continue;
      pause.since = now;
      this.arm(id, pause);
    }
  }

  /** Встреча кончилась. */
  clear() {
    for (const pause of this.pauses.values()) clearTimeout(pause.timer);
    this.pauses.clear();
    this.suspended = false;
    this.publish();
  }

  private arm(id: string, pause: Pause) {
    clearTimeout(pause.timer);
    pause.timer = setTimeout(
      () => {
        if (this.pauses.get(id) !== pause || pause.phase !== 'pending' || this.suspended) return;
        pause.phase = 'shown';
        if (!pause.counted) {
          pause.counted = true;
          this.total.update((count) => count + 1);
        }
        this.publish();
      },
      Math.max(PAUSE_NOTICE_MS, pause.bufferedMs),
    );
  }

  private drop(id: string) {
    const pause = this.pauses.get(id);
    if (!pause) return;
    clearTimeout(pause.timer);
    this.pauses.delete(id);
    if (pause.phase === 'shown') this.publish();
  }

  /** Новое значение — только когда набор надписей и правда изменился: плитки не перерисовываются зря. */
  private publish() {
    const next: Record<string, true> = {};
    for (const [id, pause] of this.pauses) if (pause.phase === 'shown') next[id] = true;
    const current = this.shown.get();
    const same =
      Object.keys(current).length === Object.keys(next).length &&
      Object.keys(next).every((id) => current[id]);
    if (!same) this.shown.set(next);
  }
}
