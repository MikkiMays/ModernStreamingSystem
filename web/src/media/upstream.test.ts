import { describe, expect, it } from 'vitest';
import { UpstreamBudget, type UpstreamInputs } from './upstream';

const SETTLE = 2;
const p720 = { resolution: 720 as const, fps: 30 as const };
const p1080 = { resolution: 1080 as const, fps: 60 as const };

function inputs(patch: Partial<UpstreamInputs> = {}): UpstreamInputs {
  return {
    sharing: false,
    camera: true,
    limitation: 'none',
    screenLevel: p1080,
    cameraLevel: p1080,
    cameraYields: false,
    ...patch,
  };
}

describe('камера рядом с демонстрацией', () => {
  it('по умолчанию не ужимается: выбранное число — указание, а не совет', () => {
    const budget = new UpstreamBudget(SETTLE);
    expect(budget.observe(inputs({ sharing: true }))).toEqual({});
    expect(budget.cameraRole).toBe('full');
    for (let i = 0; i < 6; i++) budget.observe(inputs({ sharing: true, limitation: 'bandwidth' }));
    expect(budget.cameraRole).toBe('full');
  });

  it('ужимается сразу при начале показа, если сервер велел уступать, и возвращается после него', () => {
    const budget = new UpstreamBudget(SETTLE);
    expect(budget.observe(inputs({ sharing: true, cameraYields: true }))).toEqual({ camera: 'companion' });
    expect(budget.observe(inputs({ sharing: true, cameraYields: true }))).toEqual({});
    expect(budget.observe(inputs({ sharing: false, cameraYields: true }))).toEqual({ camera: 'full' });
  });

  it('не трогает камеру, которой нет', () => {
    const budget = new UpstreamBudget(SETTLE);
    expect(budget.observe(inputs({ sharing: true, camera: false, cameraYields: true }))).toEqual({});
  });
});

describe('удержание экрана во время показа', () => {
  it('в окне разгона не спускается, после — две жалобы подряд опускают кадр до 720p при той же частоте', () => {
    const budget = new UpstreamBudget(SETTLE);
    const pressed = inputs({ sharing: true, limitation: 'bandwidth' });
    expect(budget.observe(pressed)).toEqual({});
    expect(budget.observe(pressed)).toEqual({});
    expect(budget.observe(pressed)).toEqual({});
    expect(budget.observe(pressed)).toEqual({ screen: { resolution: 720, fps: 60 } });
  });

  it('после уступки камеры экран ждёт, пока уступка отразится в оценке канала', () => {
    const budget = new UpstreamBudget(0);
    const pressed = inputs({ sharing: true, cameraYields: true, limitation: 'bandwidth' });
    expect(budget.observe(pressed)).toEqual({ camera: 'companion' });
    expect(budget.observe(pressed)).toEqual({});
    expect(budget.observe(pressed)).toEqual({});
    expect(budget.observe(pressed)).toEqual({ screen: { resolution: 720, fps: 60 } });
  });

  it('новый выбор человека начинает удержание заново', () => {
    const budget = new UpstreamBudget(0);
    budget.observe(inputs({ sharing: true, limitation: 'bandwidth' }));
    expect(budget.observe(inputs({ sharing: true, limitation: 'bandwidth', screenLevel: p720 }))).toEqual({});
    expect(budget.observe(inputs({ sharing: true, limitation: 'bandwidth', screenLevel: p720 }))).toEqual({});
  });

  it('после сброса удержание начинается заново', () => {
    const budget = new UpstreamBudget(0);
    budget.observe(inputs({ sharing: true, limitation: 'bandwidth' }));
    budget.reset();
    expect(budget.observe(inputs({ sharing: true, limitation: 'bandwidth' }))).toEqual({});
  });
});

describe('удержание камеры, когда показа нет', () => {
  it('держит выбранное, пока оно выходит', () => {
    const budget = new UpstreamBudget(SETTLE);
    for (let i = 0; i < 10; i++) expect(budget.observe(inputs())).toEqual({});
  });

  it('уступает кадром на ступень, когда не выходит, и возвращается сам', () => {
    const budget = new UpstreamBudget(0);
    expect(budget.observe(inputs({ limitation: 'cpu' }))).toEqual({});
    expect(budget.observe(inputs({ limitation: 'cpu' }))).toEqual({
      cameraLevel: { resolution: 720, fps: 60 },
    });
    let returned: unknown;
    for (let i = 0; i < 12 && !returned; i++) returned = budget.observe(inputs()).cameraLevel;
    expect(returned).toEqual(p1080);
  });

  it('720p — пол: 15 fps и 640×360 отсюда не бывает', () => {
    const budget = new UpstreamBudget(0);
    for (let i = 0; i < 10; i++)
      expect(budget.observe(inputs({ cameraLevel: p720, limitation: 'bandwidth' }))).toEqual({});
  });

  it('пока идёт показ, камера под удержание не попадает — статистика там про экран', () => {
    const budget = new UpstreamBudget(0);
    for (let i = 0; i < 4; i++) {
      const change = budget.observe(inputs({ sharing: true, limitation: 'bandwidth' }));
      expect(change.cameraLevel).toBeUndefined();
    }
  });

  it('включённая заново камера начинает с выбранного', () => {
    const budget = new UpstreamBudget(0);
    budget.observe(inputs({ limitation: 'cpu' }));
    budget.resetCamera();
    expect(budget.observe(inputs({ limitation: 'cpu' }))).toEqual({});
  });
});
