import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeProbe } from '../media/node-probe';
import { MANUAL_NODE_KEY, manualNode, nodeForCreate, setManualNode } from './node-choice';

/*
  «Авто / вручную» (R200, Р-101): ручной узел помнится на устройстве и уходит в создание как
  `preferredNode` с `manual: true`; «Авто» — результат замера, как в 1.2.1. Узел, которого ядро больше
  не называет, молча сбрасывается на «Авто».
*/

const NODES = [
  { id: 'fra', title: { ru: 'Франкфурт' }, rtcUrl: 'wss://fra', probeUrl: 'https://fra', control: true },
  { id: 'hel', title: { ru: 'Хельсинки' }, rtcUrl: 'wss://hel', probeUrl: 'https://hel', control: false },
];

beforeEach(() => {
  localStorage.clear();
  setManualNode(null);
  vi.spyOn(nodeProbe, 'known').mockReturnValue(NODES);
  vi.spyOn(nodeProbe, 'preferred').mockResolvedValue({
    node: 'fra',
    measures: [{ node: 'fra', tcpMs: 40, udpMs: 38, udpOpen: true }],
  });
});
afterEach(() => vi.restoreAllMocks());

describe('выбор узла руками', () => {
  it('по умолчанию — «Авто»: узел и замеры из node-probe, без manual', async () => {
    expect(manualNode.get()).toBeNull();
    await expect(nodeForCreate()).resolves.toEqual({
      preferredNode: 'fra',
      measurements: [{ node: 'fra', tcpMs: 40, udpMs: 38, udpOpen: true }],
      manual: false,
    });
  });

  it('ручной узел помнится на устройстве и уходит в создание с manual: true и замерами', async () => {
    setManualNode('hel');
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBe('hel');
    expect(manualNode.get()).toBe('hel');
    const choice = await nodeForCreate();
    expect(choice.preferredNode).toBe('hel');
    expect(choice.manual).toBe(true);
    expect(choice.measurements).toHaveLength(1);
    setManualNode(null);
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
  });

  it('узел, которого ядро больше не называет, сбрасывается на «Авто»', async () => {
    localStorage.setItem(MANUAL_NODE_KEY, 'msk');
    // Магазин читается при загрузке модуля; здесь — как если бы страницу открыли с этим значением.
    setManualNode('msk');
    const choice = await nodeForCreate();
    expect(choice).toEqual(expect.objectContaining({ preferredNode: 'fra', manual: false }));
    expect(manualNode.get()).toBeNull();
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
  });

  it('пока список узлов не пришёл, ручной выбор не трогается', async () => {
    vi.mocked(nodeProbe.known).mockReturnValue([]);
    setManualNode('hel');
    const choice = await nodeForCreate();
    expect(choice.preferredNode).toBe('hel');
    expect(manualNode.get()).toBe('hel');
  });
});
