import { describe, expect, it } from 'vitest';
import { AutoQuality, ceilingFor, ladder, levelFor, SETTLE_TICKS, startingRung } from './auto-quality';

const mbps = (value: number) => value * 1_000_000;
// Ladder targets: 720p15 1.5, 720p30 3, 1080p30 6, 1080p60 10, 1440p30 10, 1440p60 16 Mbit/s,
// each needing 25% spare on top.
const plenty = mbps(40);
/** Enough for 1080p30 and nothing above it. */
const modest = mbps(8);
/** Проматывает разгон полосы: после него жалобы кодировщика уже что-то значат. */
const settled = (quality: AutoQuality) => {
  for (let i = 0; i < SETTLE_TICKS; i++) quality.observe('bandwidth', mbps(1));
  return quality;
};

describe('choosing a level for the measured bandwidth', () => {
  it('picks the best level that fits with headroom', () => {
    expect(levelFor(mbps(2))).toBe(0);
    expect(levelFor(mbps(4))).toBe(1);
    expect(levelFor(mbps(8))).toBe(2);
    expect(levelFor(mbps(15))).toBe(4);
  });

  it('refuses a level whose target only just fits, since there is no room to breathe', () => {
    expect(levelFor(mbps(10))).toBe(2);
    expect(levelFor(mbps(12.5))).toBe(4);
  });

  it('falls back to the lowest level when the link cannot carry even that', () => {
    expect(levelFor(mbps(0.2))).toBe(0);
  });

  it('reaches 1440p60 on a link that carries it', () => {
    expect(levelFor(mbps(500))).toBe(ladder.length - 1);
    expect(ladder[ladder.length - 1]).toEqual({ resolution: 1440, fps: 60 });
  });

  it('prefers the larger frame when two levels cost the same', () => {
    expect(ladder[3]).toEqual({ resolution: 1080, fps: 60 });
    expect(ladder[4]).toEqual({ resolution: 1440, fps: 30 });
    expect(levelFor(mbps(13))).toBe(4);
  });
});

describe('the ceiling a chosen level puts on the ladder', () => {
  it('counts pixels and frames separately, not the price of the level', () => {
    // 1080p60 and 1440p30 ask the link for the same 10 Mbit/s. A ceiling read off the price
    // would let a 1440p frame through to somebody who asked for 1080p.
    expect(ceilingFor({ resolution: 1080, fps: 60 })).toBe(3);
    expect(ceilingFor({ resolution: 1440, fps: 30 })).toBe(4);
  });

  it('lets the whole ladder through at the top level', () => {
    expect(ceilingFor({ resolution: 1440, fps: 60 })).toBe(ladder.length - 1);
  });

  it('holds a modest choice down to its own rung', () => {
    expect(ceilingFor({ resolution: 720, fps: 30 })).toBe(1);
    expect(ceilingFor({ resolution: 1080, fps: 30 })).toBe(2);
  });

  it('never climbs past the ceiling however much bandwidth appears', () => {
    const quality = new AutoQuality(0, ceilingFor({ resolution: 1080, fps: 30 }));
    quality.observe('none', plenty);
    for (let i = 0; i < 10; i++) quality.observe('none', plenty);
    expect(quality.current).toEqual({ resolution: 1080, fps: 30 });
  });
});

describe('automatic quality', () => {
  it('jumps straight to the best level instead of climbing one at a time', () => {
    const quality = new AutoQuality(0);
    // The very first estimate is allowed to move up on its own: it arrives seconds after
    // joining, by which point the link has already ramped.
    expect(quality.observe('none', plenty)).toEqual({ resolution: 1440, fps: 60 });
  });

  it('settles at the top and stays there while the link holds', () => {
    const quality = new AutoQuality();
    expect(quality.observe('none', plenty)).toEqual({ resolution: 1440, fps: 60 });
    for (let i = 0; i < 10; i++) expect(quality.observe('none', plenty)).toBeNull();
  });

  it('без оценки канала стоит на месте, пока не придёт время пробовать выше', () => {
    const quality = new AutoQuality();
    for (let i = 0; i < 9; i++) expect(quality.observe('none', null)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
    // Оценки нет и не будет — значит, вверх ведёт только проба.
    expect(quality.observe('none', null)).toEqual(ladder[startingRung + 1]);
  });

  it('needs two agreeing estimates before moving up again', () => {
    const quality = new AutoQuality(0);
    // First estimate spends the free move.
    expect(quality.observe('none', mbps(4))).toEqual(ladder[1]);
    expect(quality.observe('none', plenty)).toBeNull();
    expect(quality.observe('none', mbps(1))).toBeNull();
    expect(quality.current).toEqual(ladder[1]);
  });

  it('never takes the free first move downwards', () => {
    // The opening seconds are the link ramping up, not a link that cannot cope.
    const quality = new AutoQuality(startingRung);
    expect(quality.observe('none', mbps(1))).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  /**
   * ЗАЧЕМ ЭТОТ ТЕСТ ИЗМЕНИЛСЯ. Раньше двух жалоб хватало всегда, и в первые секунды показа
   * это означало падение на дно лестницы: браузер в это время наращивает полосу пробами, и
   * кодировщику честно тесно. Теперь жалобы начинают считаться только после разгона.
   */
  it('не роняет уровень из-за разгона полосы в первые секунды показа', () => {
    const quality = new AutoQuality();
    for (let i = 0; i < SETTLE_TICKS; i++) expect(quality.observe('bandwidth', mbps(1))).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  it('needs sustained pressure before dropping', () => {
    const quality = settled(new AutoQuality());
    expect(quality.observe('bandwidth', null)).toBeNull();
    expect(quality.observe('bandwidth', null)).toEqual(ladder[startingRung - 1]);
  });

  /**
   * ЗДЕСЬ ЖИЛА ГЛАВНАЯ ПРИЧИНА «15 fps на старте». Прыжок вниз сразу к тому, что подтверждает
   * измерение, задуман для настоящего затора. Но в первые секунды показа это же измерение
   * показывает разгон полосы, то есть почти ноль, — и пара жалоб уносила показ на дно
   * лестницы, откуда он потом не поднимался: чтобы подняться, нужна оценка выше текущей,
   * а она не растёт, пока мы сами больше не отдаём.
   */
  it('до того, как оценка догнала реальность, спускается по одной ступени', () => {
    const quality = settled(new AutoQuality(3));
    quality.observe('bandwidth', mbps(2));
    expect(quality.observe('bandwidth', mbps(2))).toEqual(ladder[2]);
  });

  it('drops straight to what the measurement supports', () => {
    const quality = new AutoQuality(3);
    // Спокойный опрос, подтверждающий текущий уровень: с этого момента оценке верят.
    quality.observe('none', mbps(20));
    const dropping = settled(quality);
    dropping.observe('bandwidth', mbps(2));
    expect(dropping.observe('bandwidth', mbps(2))).toEqual(ladder[0]);
  });

  it('still goes down when a limited link reports optimistic bandwidth', () => {
    const quality = settled(new AutoQuality(2));
    quality.observe('bandwidth', plenty);
    expect(quality.observe('bandwidth', plenty)).toEqual(ladder[1]);
  });

  it('forgets earlier pressure once the link recovers', () => {
    const quality = settled(new AutoQuality(startingRung, startingRung));
    expect(quality.observe('bandwidth', null)).toBeNull();
    expect(quality.observe('none', modest)).toBeNull();
    expect(quality.observe('bandwidth', null)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  it('treats an overloaded encoder the same as a saturated link', () => {
    const quality = settled(new AutoQuality());
    quality.observe('cpu', plenty);
    expect(quality.observe('cpu', plenty)).toEqual(ladder[startingRung - 1]);
  });

  it('stops at the ends of the ladder', () => {
    const top = new AutoQuality(ladder.length - 1);
    for (let i = 0; i < 12; i++) expect(top.observe('none', plenty)).toBeNull();

    const bottom = new AutoQuality(0);
    for (let i = 0; i < 12; i++) expect(bottom.observe('bandwidth', mbps(0.1))).toBeNull();
    expect(bottom.current).toEqual(ladder[0]);
  });

  /**
   * ЗАЧЕМ ПРОБА. Подъём по оценке канала — замкнутый круг: браузер оценивает то, что через
   * него идёт, а идёт ровно столько, сколько мы отдаём. С нижней ступени оценка редко
   * переваливает за порог следующей, и без пробы лестница не поднимется никогда.
   */
  it('сама пробует ступень выше, когда оценка не зовёт наверх', () => {
    const quality = new AutoQuality(0);
    const stingy = mbps(2); // Хватает ровно на нижнюю ступень и ни на что выше.
    for (let i = 0; i < 9; i++) expect(quality.observe('none', stingy)).toBeNull();
    expect(quality.observe('none', stingy)).toEqual(ladder[1]);
  });

  it('после неудачной пробы ждёт вдвое дольше, прежде чем пробовать снова', () => {
    const quality = new AutoQuality(0);
    const stingy = mbps(2);
    for (let i = 0; i < 9; i++) quality.observe('none', stingy);
    expect(quality.observe('none', stingy)).toEqual(ladder[1]);
    // Ступень не удержалась: две жалобы после разгона возвращают вниз.
    for (let i = 0; i < SETTLE_TICKS; i++) quality.observe('bandwidth', stingy);
    quality.observe('bandwidth', stingy);
    expect(quality.observe('bandwidth', stingy)).toEqual(ladder[0]);
    // Теперь терпения вдвое больше: на десятом спокойном опросе пробы ещё нет.
    for (let i = 0; i < 19; i++) expect(quality.observe('none', stingy)).toBeNull();
    expect(quality.observe('none', stingy)).toEqual(ladder[1]);
  });

  it('подъём по оценке возвращает терпение: канал показал себя, придираться не за что', () => {
    const quality = new AutoQuality(0);
    for (let i = 0; i < 9; i++) quality.observe('none', mbps(2));
    quality.observe('none', mbps(2)); // Проба вверх.
    for (let i = 0; i < SETTLE_TICKS; i++) quality.observe('bandwidth', mbps(2));
    quality.observe('bandwidth', mbps(2));
    quality.observe('bandwidth', mbps(2)); // Вернулись вниз, терпение удвоилось.
    // Свободный первый ход уже потрачен, поэтому вверх — по двум согласным оценкам.
    expect(quality.observe('none', plenty)).toBeNull();
    expect(quality.observe('none', plenty)).toEqual(ladder[ladder.length - 1]);
    // Дальше двигаться некуда: лестница кончилась, и пробовать больше нечего.
    for (let i = 0; i < 12; i++) expect(quality.observe('none', plenty)).toBeNull();
  });

  it('clamps a nonsense starting point', () => {
    expect(new AutoQuality(-5).current).toEqual(ladder[0]);
    expect(new AutoQuality(99).current).toEqual(ladder[ladder.length - 1]);
  });
});
