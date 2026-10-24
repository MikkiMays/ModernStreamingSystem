import { describe, expect, it } from 'vitest';
import { readZoom, zoomSteps, type Lens } from './cameras';

const wide: Lens = { deviceId: 'wide', short: '0.5×', label: 'Широкоугольная', active: false, wide: true };
const main: Lens = { deviceId: 'back', short: '1×', label: 'Основная', active: true, wide: false };
const brief = (steps: ReturnType<typeof zoomSteps>) =>
  steps.map((step) => `${step.factor}×${step.active ? '*' : ''}`);

describe('ступени зума своей камеры (R36)', () => {
  it('телефон с зумом 1…8 — «1×» и «2×», горит та, что сейчас', () => {
    expect(brief(zoomSteps({ lenses: null, zoom: { min: 1, max: 8, value: 1 } }))).toEqual(['1×*', '2×']);
    expect(brief(zoomSteps({ lenses: null, zoom: { min: 1, max: 8, value: 2 } }))).toEqual(['1×', '2×*']);
  });

  it('«0.5×» — когда зум сам умеет отдалить вдвое (логическая камера Android: 0.5…10)', () => {
    const steps = zoomSteps({ lenses: null, zoom: { min: 0.5, max: 10, value: 1 } });
    expect(brief(steps)).toEqual(['0.5×', '1×*', '2×']);
    expect(steps.map((step) => step.zoom)).toEqual([0.5, 1, 2]);
  });

  it('«0.5×» — широкоугольной линзой, если зумом отдалить нельзя', () => {
    const steps = zoomSteps({ lenses: [wide, main], zoom: { min: 1, max: 4, value: 1 } });
    expect(brief(steps)).toEqual(['0.5×', '1×*', '2×']);
    expect([steps[0]?.deviceId, steps[0]?.zoom]).toEqual(['wide', undefined]);
  });

  it('на широкоугольной «1×» возвращает основную линзу, а «2×» не обещает: её зум неизвестен', () => {
    const steps = zoomSteps({
      lenses: [
        { ...wide, active: true },
        { ...main, active: false },
      ],
      zoom: { min: 1, max: 2, value: 1 },
    });
    expect(brief(steps)).toEqual(['0.5×*', '1×']);
    expect([steps[1]?.deviceId, steps[1]?.zoom]).toEqual(['back', undefined]);
  });

  it('веб-камера с зумом в своих единицах (100…500): «1×» — начало диапазона, «2×» — вдвое', () => {
    const steps = zoomSteps({ lenses: null, zoom: { min: 100, max: 500, value: 100 } });
    expect(brief(steps)).toEqual(['1×*', '2×']);
    expect(steps.map((step) => step.zoom)).toEqual([100, 200]);
  });

  it('зум меньше двукратного — выбора нет, контрол не показывается', () => {
    expect(zoomSteps({ lenses: null, zoom: { min: 1, max: 1.8, value: 1 } })).toEqual([]);
    expect(zoomSteps({ lenses: null, zoom: null })).toEqual([]);
  });

  it('поддельная камера Chromium и настольная без зума — ничего', () => {
    expect(zoomSteps({ lenses: null, zoom: null })).toEqual([]);
  });

  it('вторая линза без слова «широкоугольная» — не «0.5×»: её множитель неизвестен', () => {
    const second: Lens = {
      deviceId: 'two',
      short: '2',
      label: 'Вторая основная',
      active: false,
      wide: false,
    };
    const first: Lens = { ...main, short: '1' };
    expect(zoomSteps({ lenses: [first, second], zoom: null })).toEqual([]);
  });

  it('зум между ступенями (жест или чужая настройка) — не горит ни одна', () => {
    expect(brief(zoomSteps({ lenses: null, zoom: { min: 1, max: 4, value: 1.5 } }))).toEqual(['1×', '2×']);
  });
});

describe('зум дорожки (getCapabilities)', () => {
  const track = (capabilities: object, settings: object) =>
    ({ getCapabilities: () => capabilities, getSettings: () => settings }) as unknown as MediaStreamTrack;

  it('читает диапазон и нынешнее значение', () => {
    expect(readZoom(track({ zoom: { min: 1, max: 5, step: 0.1 } }, { zoom: 2 }))).toEqual({
      min: 1,
      max: 5,
      value: 2,
    });
  });

  it('без значения в настройках — начало диапазона', () => {
    expect(readZoom(track({ zoom: { min: 1, max: 5 } }, {}))?.value).toBe(1);
  });

  it('нет зума, пустой диапазон или нет getCapabilities (Firefox) — null', () => {
    expect(readZoom(track({}, {}))).toBeNull();
    expect(readZoom(track({ zoom: { min: 1, max: 1 } }, {}))).toBeNull();
    expect(readZoom({ getSettings: () => ({}) } as unknown as MediaStreamTrack)).toBeNull();
  });
});
