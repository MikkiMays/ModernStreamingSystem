import { describe, expect, it } from 'vitest';
import { blurSize, Budget, LEVELS, maskSize, modelFor, UP_FRAMES } from './budget';

/** Прогнать `n` кадров с интервалом `interval` и ценой `cost`; вернуть, сколько раз менялась ступень. */
function run(budget: Budget, n: number, cost: number, interval = 1000 / 30, from = 0) {
  let changes = 0;
  for (let i = 0; i < n; i++) if (budget.record(from + (i + 1) * interval, cost)) changes++;
  return changes;
}

describe('сторож бюджета фона (R186, Р-89)', () => {
  it('пока конвейер укладывается в кадр — модель считается на каждом кадре', () => {
    const budget = new Budget();
    run(budget, 200, 12);
    expect(budget.state.level).toBe(0);
    expect(budget.state.segmentEvery).toBe(1);
    expect(budget.shouldSegment()).toBe(true);
  });

  it('тяжёлые кадры подряд поднимают ступень, но не раньше UP_FRAMES', () => {
    const budget = new Budget();
    run(budget, UP_FRAMES - 1, 40);
    expect(budget.state.level).toBe(0);
    run(budget, 4, 40, 1000 / 30, UP_FRAMES * (1000 / 30));
    expect(budget.state.level).toBe(1);
    expect(budget.state.segmentEvery).toBe(2);
  });

  it('на ступени 2 модель считается на каждом втором кадре — по счётчику с момента смены', () => {
    const budget = new Budget();
    run(budget, UP_FRAMES + 2, 40);
    expect(budget.state.level).toBe(1);
    // После смены ступени счётчик кадров начат заново: первый кадр — с моделью, второй — без.
    expect(budget.shouldSegment()).toBe(true);
    budget.record(10_000, 20);
    expect(budget.shouldSegment()).toBe(false);
    budget.record(10_033, 20);
    expect(budget.shouldSegment()).toBe(true);
  });

  it('ступень не растёт выше последней и не падает ниже первой', () => {
    const budget = new Budget();
    run(budget, 1000, 100);
    expect(budget.state.level).toBe(Budget.top);
    expect(budget.state.segmentEvery).toBe(LEVELS[LEVELS.length - 1]);
    run(budget, 1000, 1, 1000 / 30, 1000 * (1000 / 30));
    expect(budget.state.level).toBe(0);
  });

  it('вниз — только после DOWN_FRAMES лёгких кадров подряд: один тяжёлый кадр обнуляет счёт', () => {
    const budget = new Budget();
    run(budget, UP_FRAMES + 2, 40);
    expect(budget.state.level).toBe(1);
    const step = 1000 / 30;
    let t = (UP_FRAMES + 2) * step;
    run(budget, 50, 2, step, t);
    t += 50 * step;
    expect(budget.state.level).toBe(1);
    // Один по-настоящему тяжёлый кадр (0.8·2 + 0.2·300 ≈ 62 мс из 33) обнуляет счёт лёгких…
    budget.record((t += step), 300);
    run(budget, 50, 2, step, t);
    t += 50 * step;
    expect(budget.state.level).toBe(1);
    // …и только ещё DOWN_FRAMES лёгких подряд возвращают качество.
    run(budget, 50, 2, step, t);
    expect(budget.state.level).toBe(0);
  });

  it('средняя цена — скользящее среднее, а не последний кадр: одиночный всплеск ступень не меняет', () => {
    const budget = new Budget();
    run(budget, 100, 5);
    for (let i = 0; i < 3; i++) budget.record(100_000 + i * 33, 300);
    // Три всплеска подряд — ещё не UP_FRAMES тяжёлых кадров.
    expect(budget.state.level).toBe(0);
    expect(budget.state.costMs).toBeGreaterThan(5);
  });

  it('интервал кадра берётся из меток времени источника: 15 кадров — бюджет вдвое больше', () => {
    const slow = new Budget();
    run(slow, 300, 40, 1000 / 15);
    expect(slow.state.level).toBe(0);
    expect(slow.state.intervalMs).toBeCloseTo(1000 / 15, 0);
    const fast = new Budget();
    run(fast, 300, 40, 1000 / 30);
    expect(fast.state.level).toBeGreaterThan(0);
  });

  it('разрыв меток (пауза источника) за интервал не считается', () => {
    const budget = new Budget();
    run(budget, 30, 5);
    budget.record(30 * (1000 / 30) + 5000, 5);
    expect(budget.state.intervalMs).toBeCloseTo(1000 / 30, 0);
  });

  it('новый источник сбрасывает метки и счётчик кадров, ступень остаётся', () => {
    const budget = new Budget();
    run(budget, UP_FRAMES + 2, 40);
    budget.record(10_000, 20);
    budget.resetSource();
    expect(budget.state.level).toBe(1);
    expect(budget.shouldSegment()).toBe(true);
  });

  it('модель — по кадру: горизонтальный — ландшафтная, вертикальный — квадратная', () => {
    expect(modelFor(1280, 720)).toBe('landscape');
    expect(modelFor(640, 640)).toBe('landscape');
    expect(modelFor(480, 640)).toBe('square');
  });

  it('буферы: размытие — вдвое или вчетверо, но не уже 320; маска — половина кадра до 640', () => {
    expect(blurSize(640, 360)).toEqual({ width: 320, height: 180 });
    expect(blurSize(1280, 720)).toEqual({ width: 320, height: 180 });
    expect(blurSize(1920, 1080)).toEqual({ width: 480, height: 270 });
    expect(blurSize(800, 600)).toEqual({ width: 400, height: 300 });
    expect(blurSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(maskSize(640, 360)).toEqual({ width: 320, height: 180 });
    expect(maskSize(1280, 720)).toEqual({ width: 640, height: 360 });
    expect(maskSize(1920, 1080)).toEqual({ width: 640, height: 360 });
    expect(maskSize(480, 640)).toEqual({ width: 240, height: 320 });
  });
});

describe('интервал кадра от источника (R186)', () => {
  it('известная частота источника задаёт интервал, и метки времени его больше не сдвигают', () => {
    const budget = new Budget();
    budget.resetSource(15);
    expect(budget.state.intervalMs).toBeCloseTo(1000 / 15, 3);
    for (let i = 0; i < 100; i++) budget.record(i * 10, 40);
    expect(budget.state.intervalMs).toBeCloseTo(1000 / 15, 3);
    expect(budget.state.level).toBe(0);
  });
});
