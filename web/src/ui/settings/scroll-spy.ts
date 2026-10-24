/**
 * Подсветка подраздела слева по прокрутке справа (R12, R115) — как у Discord (r103-06).
 *
 * ПОЧЕМУ НЕ «ПОСЛЕДНИЙ ВЕРХ ВЫШЕ ЛИНИИ». Так было, и короткие последние группы не могли подняться
 * до линии: прокручивать дальше некуда, и внизу раздела подсвечивалась «Камера» — «я внизу, а
 * пункт на камере». Правила по порядку:
 *
 * 1. Прокручивать нечего (всё помещается) — подсвечен тот, что выбран щелчком (или первый): на
 *    странице видны все группы сразу, и геометрия выбрать не может — правило линии назвало бы
 *    среднюю, чья группа начинается в верхней трети (R115).
 * 2. У самого низа — последний: видны и первый, и последний, а средний только потому, что его
 *    заголовок наверху, подсвечивать нельзя (R115).
 * 3. У самого верха — первый, даже если первая группа коротка и заголовок второй уже в верхней трети.
 * 4. Иначе — группа, которая пересекает линию на трети высоты области: подраздел становится текущим,
 *    когда его заголовок поднялся в верхнюю треть, а не прилип к краю.
 */
export interface AnchorTop<A extends string = string> {
  anchor: A;
  /** Верх группы относительно видимого верха области прокрутки, px (выше края — меньше нуля). */
  top: number;
}

/** Допуск «дна» и «верха»: дробные пиксели масштаба 125–150 % не оставляют «почти дно». */
const BOTTOM_SLACK = 2;

export function activeAnchor<A extends string>({
  scrollTop,
  clientHeight,
  scrollHeight,
  tops,
  current,
}: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  tops: readonly AnchorTop<A>[];
  /** Подсвеченный сейчас — выбранный щелчком или прошлым пересчётом. */
  current?: string;
}): A | undefined {
  if (!tops.length) return undefined;
  const first = tops[0]!.anchor;
  if (scrollHeight - clientHeight <= BOTTOM_SLACK)
    return tops.find((top) => top.anchor === current)?.anchor ?? first;
  if (scrollTop + clientHeight >= scrollHeight - BOTTOM_SLACK) return tops.at(-1)!.anchor;
  if (scrollTop <= BOTTOM_SLACK) return first;
  const line = clientHeight / 3;
  let crossing = first;
  for (const { anchor, top } of tops) if (top <= line) crossing = anchor;
  return crossing;
}

/** Сколько ждать `scrollend`, прежде чем снять паузу самим: прокрутки могло и не быть. */
const HOLD_MS = 600;
/** Человек взялся за прокрутку сам — пауза больше не нужна. */
const HUMAN = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Пересчёт подсветки на прокрутке — не чаще кадра — и пауза на время перехода по якорю.
 *
 * Переход ставит `scrollTop` сам, браузер отвечает событием `scroll`, и пересчёт затирал только что
 * выбранный якорь: щелчок по короткой нижней группе подсвечивал соседнюю сверху. `hold()` — «сейчас
 * прокручивает программа»: до `scrollend` (или первого колеса, касания, клавиши человека, или
 * `HOLD_MS`, если прокрутки не случилось) пересчёта нет.
 */
export function watchScroll(scroller: HTMLElement, measure: () => void) {
  let frame = 0;
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    held = false;
    clearTimeout(timer);
  };
  const onScroll = () => {
    if (held || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  scroller.addEventListener('scrollend', release);
  for (const type of HUMAN) scroller.addEventListener(type, release, { passive: true });
  return {
    hold() {
      held = true;
      clearTimeout(timer);
      timer = setTimeout(release, HOLD_MS);
    },
    stop() {
      release();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', release);
      for (const type of HUMAN) scroller.removeEventListener(type, release);
    },
  };
}
