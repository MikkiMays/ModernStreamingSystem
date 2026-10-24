import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeAnchor, watchScroll } from './scroll-spy';

/*
  Подсветка подраздела слева (R12): «когда листаешь в самый низ, видишь — я внизу, а пункт на
  камере». Числа — из живого замера CODEMAP (R12): раздел прокручен до конца (`scrollTop` = 879 =
  max), верх групп относительно области прокрутки — камера −8, экран 380, «Чужое видео» 600,
  «Дополнительно» 736; прежнее правило «последний верх выше линии top + 48» давало «Камеру».
*/
const live = [
  { anchor: 'microphone', top: -1400 },
  { anchor: 'output', top: -900 },
  { anchor: 'processing', top: -500 },
  { anchor: 'camera', top: -8 },
  { anchor: 'screen', top: 380 },
  { anchor: 'reception', top: 600 },
  { anchor: 'advanced', top: 736 },
];

describe('activeAnchor — какой подраздел сейчас на экране', () => {
  it('на дне прокрутки — последний подраздел, даже если его группа короткая и не дошла до линии', () => {
    expect(activeAnchor({ scrollTop: 879, clientHeight: 764, scrollHeight: 879 + 764, tops: live })).toBe(
      'advanced',
    );
    // Дно с допуском в 2 px: дробные пиксели масштаба 125–150 % не оставляют «почти дно».
    expect(activeAnchor({ scrollTop: 877.5, clientHeight: 764, scrollHeight: 879 + 764, tops: live })).toBe(
      'advanced',
    );
  });

  it('не на дне — группа, которая пересекает линию на трети высоты области', () => {
    // Линия на 764 / 3 ≈ 255: камера (−8) уже выше неё, экран (380) — ещё ниже.
    expect(activeAnchor({ scrollTop: 400, clientHeight: 764, scrollHeight: 2000, tops: live })).toBe(
      'camera',
    );
    const tops = [
      { anchor: 'a', top: -500 },
      { anchor: 'b', top: 100 },
      { anchor: 'c', top: 300 },
    ];
    expect(activeAnchor({ scrollTop: 10, clientHeight: 600, scrollHeight: 2000, tops })).toBe('b');
  });

  it('в самом начале — первый подраздел, даже если его заголовок ниже линии', () => {
    const tops = [
      { anchor: 'a', top: 260 },
      { anchor: 'b', top: 700 },
    ];
    expect(activeAnchor({ scrollTop: 0, clientHeight: 600, scrollHeight: 2000, tops })).toBe('a');
  });

  it('раздел без прокрутки — первый подраздел, а не «дно» и не последний', () => {
    const tops = [
      { anchor: 'a', top: 0 },
      { anchor: 'b', top: 300 },
    ];
    expect(activeAnchor({ scrollTop: 0, clientHeight: 764, scrollHeight: 764, tops })).toBe('a');
  });

  /*
    R115: «на странице видны и первый, и последний разделы, а в дереве подсвечен средний». Три группы,
    средняя начинается выше линии трети высоты: правило линии называло её, хотя страница у самого
    низа (или прокручивать нечего вовсе).
  */
  const three = [
    { anchor: 'first', top: -40 },
    { anchor: 'middle', top: 120 },
    { anchor: 'last', top: 430 },
  ];

  it('у самого низа, когда видны первый и последний, — последний, а не средний (R115)', () => {
    // Прокрутка на 40 px, и она в самом низу: средний у линии трети (600 / 3 = 200), последний виден.
    expect(activeAnchor({ scrollTop: 40, clientHeight: 600, scrollHeight: 640, tops: three })).toBe('last');
    // Масштаб 125–150 %: дно на полпикселя не дотягивает — всё равно дно.
    expect(activeAnchor({ scrollTop: 38.6, clientHeight: 600, scrollHeight: 640, tops: three })).toBe('last');
  });

  it('у самого верха — первый, даже если короткая первая группа уже выше линии второй (R115)', () => {
    const tops = [
      { anchor: 'first', top: 0 },
      { anchor: 'middle', top: 110 },
      { anchor: 'last', top: 700 },
    ];
    expect(activeAnchor({ scrollTop: 0, clientHeight: 600, scrollHeight: 1200, tops })).toBe('first');
    // Ушли от верха — решает линия.
    expect(
      activeAnchor({
        scrollTop: 60,
        clientHeight: 600,
        scrollHeight: 1200,
        tops: tops.map((group) => ({ ...group, top: group.top - 60 })),
      }),
    ).toBe('middle');
  });

  it('без прокрутки (всё помещается) подсвечен выбранный щелчком, геометрия его не меняет (R115)', () => {
    const fits = three.map((group) => ({ ...group, top: group.top + 40 }));
    for (const current of ['first', 'middle', 'last'])
      expect(activeAnchor({ scrollTop: 0, clientHeight: 640, scrollHeight: 640, tops: fits, current })).toBe(
        current,
      );
    // Выбранного здесь нет (раздел сменился) — первый.
    expect(
      activeAnchor({ scrollTop: 0, clientHeight: 640, scrollHeight: 640, tops: fits, current: 'gone' }),
    ).toBe('first');
    // Прокрутка в пределах допуска — тоже «всё помещается».
    expect(
      activeAnchor({ scrollTop: 1, clientHeight: 640, scrollHeight: 641, tops: fits, current: 'last' }),
    ).toBe('last');
  });

  it('без подразделов — ничего', () => {
    expect(activeAnchor({ scrollTop: 0, clientHeight: 600, scrollHeight: 600, tops: [] })).toBeUndefined();
  });
});

describe('watchScroll — пересчёт на прокрутке и пауза на время перехода по якорю', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const scroller = document.createElement('div');
    const measure = vi.fn();
    const spy = watchScroll(scroller, measure);
    const flush = () => frames.splice(0).forEach((callback) => callback(0));
    return { scroller, measure, spy, flush };
  }

  it('прокрутка человеком — один пересчёт на кадр', () => {
    const { scroller, measure, flush, spy } = setup();
    for (let i = 0; i < 5; i++) scroller.dispatchEvent(new Event('scroll'));
    flush();
    expect(measure).toHaveBeenCalledTimes(1);
    spy.stop();
  });

  it('программная прокрутка после перехода по якорю не затирает выбранный якорь до scrollend', () => {
    const { scroller, measure, flush, spy } = setup();
    spy.hold();
    scroller.dispatchEvent(new Event('scroll'));
    flush();
    expect(measure).not.toHaveBeenCalled();
    scroller.dispatchEvent(new Event('scrollend'));
    scroller.dispatchEvent(new Event('scroll'));
    flush();
    expect(measure).toHaveBeenCalledTimes(1);
    spy.stop();
  });

  it('пауза снимается и без scrollend: колесо или касание человека, а иначе — по времени', () => {
    vi.useFakeTimers();
    try {
      const { scroller, measure, flush, spy } = setup();
      spy.hold();
      scroller.dispatchEvent(new Event('wheel'));
      scroller.dispatchEvent(new Event('scroll'));
      flush();
      expect(measure).toHaveBeenCalledTimes(1);
      // Якорь уже на месте — прокрутки нет, scrollend не придёт: пауза уходит сама.
      spy.hold();
      vi.advanceTimersByTime(1000);
      scroller.dispatchEvent(new Event('scroll'));
      flush();
      expect(measure).toHaveBeenCalledTimes(2);
      spy.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop — больше никаких пересчётов', () => {
    const { scroller, measure, flush, spy } = setup();
    spy.stop();
    scroller.dispatchEvent(new Event('scroll'));
    flush();
    expect(measure).not.toHaveBeenCalled();
  });
});
