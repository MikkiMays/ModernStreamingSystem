import { describe, expect, it } from 'vitest';
import { UpstreamBudget } from './upstream';
import { ladder, startingRung } from './auto-quality';

const mbps = (value: number) => value * 1_000_000;
const inputs = (patch: Partial<Parameters<UpstreamBudget['observe']>[0]> = {}) => ({
  sharing: false,
  camera: false,
  limitation: 'none',
  available: null,
  screenAutomatic: true,
  ...patch,
});

describe('кадр камеры при включённой демонстрации', () => {
  it('ужимает камеру, как только начался показ экрана', () => {
    const budget = new UpstreamBudget();
    expect(budget.observe(inputs({ camera: true })).camera).toBeUndefined();
    expect(budget.observe(inputs({ camera: true, sharing: true })).camera).toBe('companion');
    expect(budget.cameraRole).toBe('companion');
  });

  it('не ужимает камеру по жалобе, а делает это сразу: ждать жалобы значит испортить экран', () => {
    const budget = new UpstreamBudget();
    const change = budget.observe(inputs({ camera: true, sharing: true, limitation: 'none' }));
    expect(change.camera).toBe('companion');
  });

  it('возвращает полный кадр, когда показ закончился', () => {
    const budget = new UpstreamBudget();
    budget.observe(inputs({ camera: true, sharing: true }));
    expect(budget.observe(inputs({ camera: true, sharing: false })).camera).toBe('full');
  });

  it('молчит, пока состав не поменялся', () => {
    const budget = new UpstreamBudget();
    budget.observe(inputs({ camera: true, sharing: true }));
    expect(budget.observe(inputs({ camera: true, sharing: true }))).toEqual({});
  });

  it('не трогает камеру, которой нет', () => {
    const budget = new UpstreamBudget();
    expect(budget.observe(inputs({ sharing: true })).camera).toBeUndefined();
    expect(budget.cameraRole).toBe('full');
  });
});

describe('очередь уступок', () => {
  const tight = (patch = {}) =>
    inputs({ camera: true, sharing: true, limitation: 'bandwidth', available: mbps(1), ...patch });

  it('не снижает экран, пока уступка камеры не успела отразиться в оценке канала', () => {
    const budget = new UpstreamBudget();
    // Первый опрос ужимает камеру и выдаёт паузу.
    expect(budget.observe(tight()).camera).toBe('companion');
    // Пауза: две следующие жалобы против экрана не считаются.
    expect(budget.observe(tight()).screen).toBeUndefined();
    expect(budget.observe(tight()).screen).toBeUndefined();
    expect(budget.screenRung).toEqual(ladder[startingRung]);
  });

  it('снижает экран, если после уступки камеры канала всё равно не хватает', () => {
    const budget = new UpstreamBudget();
    // Два опроса уходят на паузу (первый из них — тот, где ужалась камера), и ещё два —
    // на две подряд жалобы, без которых AutoQuality не снижает уровень.
    budget.observe(tight());
    budget.observe(tight());
    expect(budget.observe(tight()).screen).toBeUndefined();
    expect(budget.observe(tight()).screen).toEqual({ resolution: 720, fps: 15 });
  });

  it('без камеры экран уступает сразу после своих двух жалоб, без лишней паузы', () => {
    const budget = new UpstreamBudget();
    const only = inputs({ sharing: true, limitation: 'cpu', available: mbps(1) });
    expect(budget.observe(only).screen).toBeUndefined();
    expect(budget.observe(only).screen).toEqual({ resolution: 720, fps: 15 });
  });

  it('не двигает выбранный вручную уровень экрана', () => {
    const budget = new UpstreamBudget();
    const chosen = { screenAutomatic: false };
    budget.observe(tight(chosen));
    for (let i = 0; i < 6; i++) expect(budget.observe(tight(chosen)).screen).toBeUndefined();
    expect(budget.screenRung).toEqual(ladder[startingRung]);
  });

  it('ужимает камеру даже при выбранном вручную уровне экрана: это разные решения', () => {
    const budget = new UpstreamBudget();
    expect(budget.observe(tight({ screenAutomatic: false })).camera).toBe('companion');
  });

  it('после сброса лестница экрана начинается заново', () => {
    const budget = new UpstreamBudget();
    for (let i = 0; i < 5; i++) budget.observe(tight());
    expect(budget.screenRung).not.toEqual(ladder[startingRung]);
    budget.reset();
    expect(budget.screenRung).toEqual(ladder[startingRung]);
  });
});
