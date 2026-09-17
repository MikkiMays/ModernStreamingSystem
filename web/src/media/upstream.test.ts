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
  cameraAutomatic: false,
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

describe('лестница камеры, когда показа нет', () => {
  const alone = (patch = {}) =>
    inputs({ camera: true, cameraAutomatic: true, available: mbps(40), ...patch });

  it('поднимает камеру выше уровня по умолчанию, когда канал это позволяет', () => {
    const budget = new UpstreamBudget();
    expect(budget.observe(alone()).cameraLevel).toEqual({ resolution: 1440, fps: 60 });
  });

  it('не поднимает выше выбранного человеком потолка', () => {
    const budget = new UpstreamBudget();
    const capped = alone({ cameraCeiling: { resolution: 1080, fps: 30 } });
    budget.observe(capped);
    for (let i = 0; i < 5; i++) budget.observe(capped);
    expect(budget.cameraRung).toEqual({ resolution: 1080, fps: 30 });
  });

  it('снижает камеру по двум жалобам подряд', () => {
    const budget = new UpstreamBudget();
    const tight = alone({ limitation: 'cpu', available: mbps(1) });
    expect(budget.observe(tight).cameraLevel).toBeUndefined();
    expect(budget.observe(tight).cameraLevel).toEqual({ resolution: 720, fps: 15 });
  });

  it('не трогает камеру, выбранную вручную', () => {
    const budget = new UpstreamBudget();
    const chosen = alone({ cameraAutomatic: false });
    for (let i = 0; i < 5; i++) expect(budget.observe(chosen).cameraLevel).toBeUndefined();
    expect(budget.cameraRung).toEqual(ladder[startingRung]);
  });

  it('пока идёт показ, камерой распоряжается роль, а не лестница', () => {
    const budget = new UpstreamBudget();
    const sharing = alone({ sharing: true });
    expect(budget.observe(sharing).cameraLevel).toBeUndefined();
    expect(budget.cameraRole).toBe('companion');
  });

  it('новый потолок начинает лестницу заново, а совпадающий её не сбрасывает', () => {
    const budget = new UpstreamBudget();
    const tight = alone({ limitation: 'cpu', available: mbps(1), cameraCeiling: ladder[4] });
    // Один и тот же потолок не должен стирать счётчик жалоб: иначе снижения не случится никогда.
    budget.observe(tight);
    expect(budget.observe(tight).cameraLevel).toEqual({ resolution: 720, fps: 15 });
    // А другой — начинает всё заново, со ступени не выше нового потолка.
    budget.observe(alone({ cameraCeiling: { resolution: 720, fps: 30 } }));
    expect(budget.cameraRung).toEqual({ resolution: 720, fps: 30 });
  });
});
